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

    async def request(self, payload):
        self.calls.append(payload)
        self.entered.set()
        await self.release.wait()
        return {"ok": True, "bpm": 120, "key": "8A", "intro_ms": 500, "confidence": 0.9}

    def capability(self, meta_key, _loss_key):
        return self.capabilities.get(meta_key) if self.ready else None


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
    assert pool.capability("audio_embedding_capable", "audio_embedding") is False
    second.ready = False
    assert pool.capability("audio_embedding_capable", "audio_embedding") is None


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
    await test_unavailable_worker_skipped()
    await test_capability_aggregation_is_conservative()
    await test_path_contract()


asyncio.run(main())
print("analyzer sidecar pool + path contract: ok")
