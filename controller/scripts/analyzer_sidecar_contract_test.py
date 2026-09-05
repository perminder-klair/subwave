"""Dependency-free tests for the analyzer sidecar pool and path contract."""

import asyncio
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class FastAPI:
    def __init__(self, **_kwargs):
        pass

    def get(self, _path):
        return lambda fn: fn

    def post(self, _path):
        return lambda fn: fn


class BaseModel:
    def __init__(self, **values):
        for key, value in values.items():
            setattr(self, key, value)


fastapi = types.ModuleType("fastapi")
fastapi.FastAPI = FastAPI
fastapi.HTTPException = HTTPException
pydantic = types.ModuleType("pydantic")
pydantic.BaseModel = BaseModel
pydantic.Field = lambda **_kwargs: None
sys.modules["fastapi"] = fastapi
sys.modules["pydantic"] = pydantic

server_path = Path(__file__).parents[2] / "docker" / "analyzer" / "server.py"
spec = importlib.util.spec_from_file_location("subwave_analyzer_server", server_path)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class FakeWorker:
    def __init__(self, name, ready=True):
        self.name = name
        self.ready = ready
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = []
        self.ready_meta = {}
        self.capability_errors = {}
        self.capabilities = {}
        self.models_resident = False
        self.last_heavy = None
        self.recycles = 0
        self.state_listener = None
        self.unavailable_on_request = False
        self.reserved = False

    def set_state_listener(self, listener):
        self.state_listener = listener

    async def set_ready(self, ready):
        self.ready = ready
        if self.state_listener:
            await self.state_listener()

    @property
    def available(self):
        return self.ready

    @property
    def recycling(self):
        return False

    def reserve_if_available(self):
        if not self.available or self.reserved:
            return False
        self.reserved = True
        return True

    def release_reservation(self):
        self.reserved = False

    async def request(self, payload):
        if self.unavailable_on_request:
            self.ready = False
            if self.state_listener:
                await self.state_listener()
            raise server.WorkerUnavailableError(f"[{self.name}] worker not ready")
        self.calls.append(payload)
        self.entered.set()
        await self.release.wait()
        return {"ok": True, "bpm": 120, "key": "8A", "intro_ms": 500, "confidence": 0.9}

    def capability(self, meta_key, loss_key):
        # Mirrors StdioWorker.capability: an observed load failure wins over the
        # advertised flag, and a member that is down has no opinion at all.
        if not self.ready:
            return None
        if loss_key in self.capability_errors:
            return False
        return self.capabilities.get(meta_key)


class LifecycleWorker(server.StdioWorker):
    """StdioWorker state transitions with request I/O replaced by events."""

    def __init__(self, name):
        super().__init__(name, "python", "worker.py")
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = []

    async def request(self, payload):
        self.calls.append(payload)
        self.entered.set()
        await self.release.wait()
        return {"ok": True}


async def test_pool_concurrency():
    first = FakeWorker("first")
    second = FakeWorker("second")
    pool = server.AnalyzerWorkerPool([first, second])
    one = asyncio.create_task(pool.request({"id": "1"}))
    two = asyncio.create_task(pool.request({"id": "2"}))
    await asyncio.wait_for(asyncio.gather(first.entered.wait(), second.entered.wait()), 1)
    assert first.calls == [{"id": "1"}], first.calls
    assert second.calls == [{"id": "2"}], second.calls
    first.release.set()
    second.release.set()
    await asyncio.gather(one, two)


async def test_waiter_uses_worker_that_becomes_ready():
    busy = FakeWorker("busy")
    booting = LifecycleWorker("booting")
    pool = server.AnalyzerWorkerPool([busy, booting])
    first = asyncio.create_task(pool.request({"id": "1"}))
    await asyncio.wait_for(busy.entered.wait(), 1)
    waiting = asyncio.create_task(pool.request({"id": "2"}))
    await asyncio.sleep(0)
    assert not waiting.done(), "second request should wait while the only ready worker is busy"

    # This is the same StdioWorker readiness transition start() performs after
    # its ready line, and must wake the pool's capacity waiter.
    await booting._set_ready(True)
    await asyncio.wait_for(booting.entered.wait(), 1)
    assert booting.calls == [{"id": "2"}], booting.calls
    assert busy.calls == [{"id": "1"}], busy.calls

    booting.release.set()
    await waiting
    busy.release.set()
    await first


async def test_unavailable_selection_retries_another_ready_worker():
    recycling = FakeWorker("recycling")
    recycling.unavailable_on_request = True
    healthy = FakeWorker("healthy")
    pool = server.AnalyzerWorkerPool([recycling, healthy])

    task = asyncio.create_task(pool.request({"id": "1"}))
    await asyncio.wait_for(healthy.entered.wait(), 1)
    assert recycling.calls == [], recycling.calls
    assert healthy.calls == [{"id": "1"}], healthy.calls
    healthy.release.set()
    await task


async def test_unavailable_worker_skipped():
    unavailable = FakeWorker("down", ready=False)
    healthy = FakeWorker("healthy")
    pool = server.AnalyzerWorkerPool([unavailable, healthy])
    task = asyncio.create_task(pool.request({"id": "1"}))
    await asyncio.wait_for(healthy.entered.wait(), 1)
    assert unavailable.calls == [], unavailable.calls
    healthy.release.set()
    await task


async def test_capability_aggregation_is_conservative():
    first = FakeWorker("first")
    second = FakeWorker("second")
    first.capabilities["audio_embedding_capable"] = True
    second.capabilities["audio_embedding_capable"] = False
    pool = server.AnalyzerWorkerPool([first, second])
    # Split verdict: some member can still serve it, so `True` would be a lie —
    # but `False` would switch the feature off station-wide over one member.
    assert pool.capability("audio_embedding_capable", "audio_embedding") is None
    # A member that is not selectable has no opinion; the pool reports what the
    # ones that CAN take work say, so one cycling member never drags the whole
    # pool to unknown (the controller's tail-vocal backfill needs === true).
    second.ready = False
    assert pool.capability("audio_embedding_capable", "audio_embedding") is True
    first.ready = False
    assert pool.capability("audio_embedding_capable", "audio_embedding") is None
    # Unanimous among selectable members is the lean-image case — they share one
    # build, and that is the only shape that earns a definitive False.
    first.capabilities["audio_embedding_capable"] = False
    first.ready = True
    second.ready = True
    assert pool.capability("audio_embedding_capable", "audio_embedding") is False


async def test_latched_capability_error_does_not_fan_out():
    healthy = FakeWorker("healthy")
    unlucky = FakeWorker("unlucky")
    healthy.capabilities["vocal_activity_capable"] = True
    unlucky.capabilities["vocal_activity_capable"] = True
    # capability_errors survives the member's own respawn by design (#1300), so
    # one worker's bad load hour must not switch Demucs off for the other three.
    unlucky.capability_errors["vocal_activity"] = "CUDA out of memory"
    pool = server.AnalyzerWorkerPool([healthy, unlucky])
    assert pool.capability("vocal_activity_capable", "vocal_activity") is None
    assert pool.capability_error("vocal_activity") == "CUDA out of memory"
    # …and once that member is out of the selectable set, its latch goes with it.
    unlucky.ready = False
    assert pool.capability("vocal_activity_capable", "vocal_activity") is True
    assert pool.capability_error("vocal_activity") is None


async def test_single_worker_recycle_queues_instead_of_failing():
    """The ANALYZE_CONCURRENCY=1 default must not 500 across a recycle.

    Drives the REAL StdioWorker recycle transitions (`_set_recycling` /
    `_set_ready`) rather than a stand-in, because the regression this guards is
    in that state machine: recycle claiming the only member used to leave the
    pool with nothing selectable, and _acquire_worker raised instead of waiting
    out the respawn the way the worker's request lock used to.
    """
    only = LifecycleWorker("analyze-1")
    pool = server.AnalyzerWorkerPool([only])
    await only._set_ready(True)

    # recycle_loop claims the worker, then terminates it and waits for run() to
    # respawn — up to 180s with nothing else in the pool to take the request.
    await only._set_recycling(True)
    await only._set_ready(False)

    task = asyncio.create_task(pool.request({"id": "1"}))
    await asyncio.sleep(0)
    assert not task.done(), "a request during the recycle window must queue, not fail"
    assert only.calls == [], only.calls

    # start() re-readies the fresh process; recycle_loop's finally clears the claim.
    await only._set_ready(True)
    await only._set_recycling(False)
    await asyncio.wait_for(only.entered.wait(), 1)
    assert only.calls == [{"id": "1"}], only.calls
    only.release.set()
    assert await asyncio.wait_for(task, 1) == {"ok": True}


async def test_no_worker_ready_and_none_recycling_fails_fast():
    """Boot and crash still fail fast — blocking there would help no one."""
    down = LifecycleWorker("analyze-1")
    pool = server.AnalyzerWorkerPool([down])
    try:
        await asyncio.wait_for(pool.request({"id": "1"}), 1)
    except server.WorkerUnavailableError:
        pass
    else:
        raise AssertionError("a pool with nothing ready or recycling must fail fast")
    assert down.calls == [], down.calls


async def test_path_contract():
    worker_calls = []

    async def worker_request(payload):
        worker_calls.append(payload)
        return {"ok": True, "bpm": 120, "key": "8A", "intro_ms": 500, "confidence": 0.9}

    server.analyzer_pool.request = worker_request
    missing = "/definitely-not-mounted/subwave-track.audio"
    try:
        await server.analyze(server.AnalyzeRequest(path=missing))
    except HTTPException as err:
        assert err.status_code == 422, err.status_code
        assert err.detail == {
            "code": "path_unavailable",
            "message": f"analyzer cannot read controller path: {missing}",
        }, err.detail
    else:
        raise AssertionError("missing controller path reached the analyzer worker")
    assert worker_calls == [], worker_calls

    with tempfile.NamedTemporaryFile() as audio:
        result = await server.analyze(server.AnalyzeRequest(path=audio.name))
    assert result["ok"] is True, result
    assert worker_calls == [{"id": "1", "path": audio.name}], worker_calls


def test_concurrency_env_validation():
    old = os.environ.get("SUBWAVE_TEST_CONCURRENCY")
    try:
        for raw, expected in ((None, 1), ("", 1), ("4", 4), ("0", 1), ("9", 1), ("many", 1)):
            if raw is None:
                os.environ.pop("SUBWAVE_TEST_CONCURRENCY", None)
            else:
                os.environ["SUBWAVE_TEST_CONCURRENCY"] = raw
            assert server._bounded_int_env("SUBWAVE_TEST_CONCURRENCY", 1, 1, 8) == expected
    finally:
        if old is None:
            os.environ.pop("SUBWAVE_TEST_CONCURRENCY", None)
        else:
            os.environ["SUBWAVE_TEST_CONCURRENCY"] = old


async def main():
    test_concurrency_env_validation()
    await test_pool_concurrency()
    await test_waiter_uses_worker_that_becomes_ready()
    await test_unavailable_selection_retries_another_ready_worker()
    await test_unavailable_worker_skipped()
    await test_single_worker_recycle_queues_instead_of_failing()
    await test_no_worker_ready_and_none_recycling_fails_fast()
    await test_capability_aggregation_is_conservative()
    await test_latched_capability_error_does_not_fan_out()
    await test_path_contract()


asyncio.run(main())
print("analyzer sidecar pool + path contract: ok")
