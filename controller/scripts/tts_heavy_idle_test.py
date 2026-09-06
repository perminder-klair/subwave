#!/usr/bin/env python3
# Unit test for the tts-heavy sidecar's idle unload (#1579) — the mechanism
# that hands Chatterbox's ~4GB back while the station is quiet and loads it
# again on demand. Pure stdlib: fastapi/pydantic are stubbed and the worker
# subprocess is faked, so no torch, no model, no network, no port.
# Run: `python3 scripts/tts_heavy_idle_test.py` (exit 0 = pass).
#
# What this pins down, in the order it matters:
#   - a cold engine stays in /health's `engines`. This is the one-way door: the
#     controller caches that list and routes on it, so an engine dropped while
#     unloaded would never be asked to speak and so would never wake;
#   - a crashed or still-booting engine stays OUT of it, which is the reason
#     `cold` and `not ready` cannot be one flag;
#   - the unload is a process exit (#1204: an in-process release leaves torch
#     resident), and run() treats that exit as deliberate — no crash warning,
#     no eager respawn;
#   - a render in flight, or one that has merely claimed the worker, blocks the
#     unload;
#   - /speak on a cold worker loads it and succeeds; a load that never arrives
#     is a 503, which is what makes the controller fall through to its rescue
#     voice instead of the station going quiet;
#   - a worker that is DOWN (not cold) fails its caller at once rather than
#     waiting out the load ceiling — degrading has to be immediate, and a
#     90-second stall before the rescue voice is worse than no wait at all;
#   - the window resolves per ENGINE, so an operator using one engine doesn't
#     have the other's idle behaviour decided for them.

import asyncio
import importlib.util
import json
import os
import sys
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

# Load with a clean env so the module-level defaults are the shipped ones.
for _var in (
    "TTS_HEAVY_IDLE_UNLOAD_S",
    "CHATTERBOX_IDLE_UNLOAD_S",
    "POCKET_TTS_IDLE_UNLOAD_S",
    "TTS_HEAVY_DEVICE",
    "TTS_HEAVY_ENGINES",
):
    os.environ.pop(_var, None)

server_path = Path(__file__).parents[2] / "docker" / "tts-heavy" / "server.py"
spec = importlib.util.spec_from_file_location("subwave_tts_heavy_server", server_path)
assert spec and spec.loader
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


class FakeStdin:
    def __init__(self, proc):
        self.proc = proc

    def write(self, data):
        self.proc.written.append(data)
        # Every request gets one canned success back, which is all the idle
        # bookkeeping cares about; the render itself is the worker's business.
        req = json.loads(data.decode())
        self.proc.feed({"id": req.get("id"), "ok": True, "path": req.get("out"), "duration_s": 1.0})

    async def drain(self):
        return None


class FakeProc:
    """An asyncio.subprocess.Process stand-in: real StreamReaders, a stdin that
    answers requests, and a wait() that only returns once terminate() is called
    — the same shape run() supervises."""

    def __init__(self, ready_msg=None, fail_ready=False):
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.stdin = FakeStdin(self)
        self.returncode = None
        self.written = []
        self.terminated = False
        self._exited = asyncio.Event()
        # Set by a test that needs to act in the window between terminate()
        # and the supervisor observing the exit — the race the idle latch
        # exists for, which is otherwise too fast to step into.
        self.hold_exit: asyncio.Event | None = None
        if fail_ready:
            # Worker dies before announcing readiness (a fatal model load).
            self.stdout.feed_eof()
            self.stderr.feed_eof()
        else:
            self.feed(ready_msg or {"ready": True, "voice_cloning": True})

    def feed(self, obj):
        self.stdout.feed_data((json.dumps(obj) + "\n").encode())

    def terminate(self):
        self.terminated = True
        self.exit(code=-15)

    def exit(self, code=0):
        if self.returncode is None:
            self.returncode = code
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self._exited.set()

    async def wait(self):
        await self._exited.wait()
        if self.hold_exit is not None:
            await self.hold_exit.wait()
        return self.returncode


def install_fake_spawn(procs):
    """Hand out one FakeProc per start(); records them in `procs`."""

    async def fake_exec(*_args, **_kwargs):
        proc = FakeProc()
        procs.append(proc)
        return proc

    asyncio.create_subprocess_exec = fake_exec
    return procs


async def wait_for(predicate, timeout=2.0, what="condition"):
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


def make_worker(name="chatterbox", idle_unload_s=0.0):
    return server.TtsWorker(
        name=name,
        python="/nonexistent/python",
        script="/nonexistent/worker.py",
        env_extra={},
        idle_unload_s=idle_unload_s,
    )


def run_async(coro):
    return asyncio.run(coro)


def main():
    real_exec = asyncio.create_subprocess_exec
    try:
        _cases()
    finally:
        asyncio.create_subprocess_exec = real_exec

    print("✓ tts_heavy_idle_test.py passed" if not failures else f"✗ {failures} case(s) failed")
    return 1 if failures else 0


def _cases():
    # --- window resolution --------------------------------------------------
    def case_per_engine_env_beats_shared():
        os.environ["TTS_HEAVY_IDLE_UNLOAD_S"] = "900"
        os.environ["CHATTERBOX_IDLE_UNLOAD_S"] = "120"
        try:
            assert server.idle_unload_seconds("chatterbox") == 120.0, "per-engine var must win"
            assert server.idle_unload_seconds("pocket-tts") == 900.0, "shared var covers the rest"
        finally:
            os.environ.pop("TTS_HEAVY_IDLE_UNLOAD_S", None)
            os.environ.pop("CHATTERBOX_IDLE_UNLOAD_S", None)

    test("per-engine idle var beats the shared one", case_per_engine_env_beats_shared)

    def case_device_default():
        server.DEVICE = "cuda"
        try:
            assert server.idle_unload_seconds("chatterbox") == server.IDLE_UNLOAD_CUDA_S, (
                "cuda chatterbox takes the tighter window — VRAM contention is the urgent case"
            )
            # PocketTTS' venv is CPU-torch whatever the sidecar's device says.
            assert server.idle_unload_seconds("pocket-tts") == server.IDLE_UNLOAD_CPU_S, (
                "pocket-tts is never on the GPU, so the device must not move its window"
            )
        finally:
            server.DEVICE = "cpu"

    test("device-aware default applies to chatterbox only", case_device_default)

    def case_junk_and_zero():
        os.environ["TTS_HEAVY_IDLE_UNLOAD_S"] = "soon"
        try:
            assert server.idle_unload_seconds("chatterbox") == server.IDLE_UNLOAD_CPU_S, (
                "a junk value falls back to the default rather than disabling the feature"
            )
            os.environ["TTS_HEAVY_IDLE_UNLOAD_S"] = "-5"
            assert server.idle_unload_seconds("chatterbox") == 0.0, "a negative window means off"
            os.environ["TTS_HEAVY_IDLE_UNLOAD_S"] = "0"
            assert server.idle_unload_seconds("chatterbox") == 0.0, "0 means always resident"
        finally:
            os.environ.pop("TTS_HEAVY_IDLE_UNLOAD_S", None)

    test("junk window falls back; 0 and negatives disable", case_junk_and_zero)

    # --- should_unload precedence ------------------------------------------
    def case_should_unload_guards():
        w = make_worker(idle_unload_s=60.0)
        assert not w.should_unload(), "a worker that never loaded has nothing to unload"
        w.ready = True
        w.loaded_at = server.time.monotonic() - 10.0
        assert not w.should_unload(), "inside the window it stays loaded"
        w.loaded_at = server.time.monotonic() - 61.0
        assert w.should_unload(), "past the window it is releasable"
        w._inflight = 1
        assert not w.should_unload(), "a claimed worker is never unloaded under a render"
        w._inflight = 0
        w.cold = True
        assert not w.should_unload(), "an already-cold worker is not unloaded twice"
        w.cold = False
        w.idle_unload_s = 0.0
        assert not w.should_unload(), "0 means the feature is off"

    test("should_unload honours every guard", case_should_unload_guards)

    def case_render_clock_beats_load_clock():
        w = make_worker(idle_unload_s=60.0)
        w.ready = True
        w.loaded_at = server.time.monotonic() - 600.0
        w.last_spoke = server.time.monotonic() - 5.0
        assert not w.should_unload(), (
            "the clock runs from the last RENDER; a long-loaded but recently used "
            "worker is busy, not idle"
        )

    test("idle clock runs from the last render", case_render_clock_beats_load_clock)

    # --- lifecycle ----------------------------------------------------------
    async def case_unload_then_wake():
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            assert len(procs) == 1, "one worker process on boot"

            # Age past the window and let one idle tick run.
            w.loaded_at = server.time.monotonic() - 601.0
            w.IDLE_TICK_S = 0.01
            idler = asyncio.create_task(w.idle_loop())
            try:
                await wait_for(lambda: w.cold, what="the idle unload")
            finally:
                idler.cancel()

            assert procs[0].terminated, "the reclaim is a process exit, not an in-process del"
            assert not w.ready, "a cold worker is not ready"
            await wait_for(lambda: w.proc is None, what="run() to observe the exit")
            assert len(procs) == 1, "a deliberate stop must NOT be respawned eagerly"
            assert w.unloads == 1

            # …and the next render brings it back.
            msg = await w.speak({"id": "1", "text": "hi", "out": "/tmp/x.wav"})
            assert msg["ok"], "a cold worker loads on demand and renders"
            assert len(procs) == 2, "the wake spawned a fresh worker"
            assert not w.cold and w.ready, "the woken worker is hot again"
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("idle unload stops the process; the next render wakes it", lambda: run_async(case_unload_then_wake()))

    async def case_crash_is_not_cold():
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=0.0)
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            w.RUN_BACKOFF_S = 0.01
            procs[0].exit(code=1)  # died on its own — nobody asked
            await wait_for(lambda: len(procs) == 2, what="the crash respawn")
            assert not w.cold, (
                "a crash must not read as an idle unload — cold means loadable on "
                "demand, and /health advertises it"
            )
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("a crash respawns and is never marked cold", lambda: run_async(case_crash_is_not_cold()))

    async def case_inflight_blocks_unload():
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            w.loaded_at = server.time.monotonic() - 601.0
            w.IDLE_TICK_S = 0.01
            # Hold the worker the way a render in flight does.
            async with w.lock:
                w._inflight = 1
                idler = asyncio.create_task(w.idle_loop())
                try:
                    await asyncio.sleep(0.1)
                    assert not w.cold, "an idle tick must stand down under a claimed worker"
                finally:
                    idler.cancel()
                    await asyncio.gather(idler, return_exceptions=True)
            assert not procs[0].terminated, "the render's process survived the tick"
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("a claimed worker blocks the unload", lambda: run_async(case_inflight_blocks_unload()))

    async def case_down_worker_fails_immediately():
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            w.last_spoke = None
            # Down, not cold: booting, or crash-looping. Nobody armed a load.
            w.ready = False
            loop = asyncio.get_running_loop()
            started = loop.time()
            try:
                await w.speak({"id": "1", "text": "hi", "out": "/tmp/x.wav"})
                raise AssertionError("a down worker must fail the render")
            except RuntimeError:
                pass
            elapsed = loop.time() - started
            assert elapsed < 1.0, (
                f"a down worker must fail AT ONCE (took {elapsed:.1f}s) — the rescue "
                "chain is what keeps the station talking, and LOAD_TIMEOUT_S of "
                "silence before reaching it is worse than the cold start it covers"
            )
            assert w.last_spoke is not None, (
                "the idle clock tracks DEMAND: a run of failing renders is the worst "
                "moment to pull the engine out from under the retries"
            )
            assert w._inflight == 0, "a failed render must release its claim"
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("a down worker fails the render immediately", lambda: run_async(case_down_worker_fails_immediately()))

    async def case_second_caller_joins_a_load():
        # The first caller arms the reload and clears `cold`; a second arriving
        # mid-load must wait for the same load, not read the cleared flag as
        # "down" and bail to Piper while the engine is on its way back.
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            w.loaded_at = server.time.monotonic() - 601.0
            w.IDLE_TICK_S = 0.01
            idler = asyncio.create_task(w.idle_loop())
            try:
                await wait_for(lambda: w.cold, what="the idle unload")
            finally:
                idler.cancel()
                await asyncio.gather(idler, return_exceptions=True)

            first = asyncio.create_task(w.speak({"id": "1", "text": "a", "out": "/tmp/a.wav"}))
            await wait_for(lambda: w._loading or w.ready, what="the load to arm")
            second = asyncio.create_task(w.speak({"id": "2", "text": "b", "out": "/tmp/b.wav"}))
            got = await asyncio.gather(first, second)
            assert all(m["ok"] for m in got), "both renders ride the one reload"
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("a second caller joins an in-flight load", lambda: run_async(case_second_caller_joins_a_load()))

    async def case_ensure_ready_gives_up():
        w = make_worker(idle_unload_s=60.0)
        w.cold = True  # cold, but with no supervisor running to answer the wake
        try:
            await w.ensure_ready(timeout_s=0.05)
            raise AssertionError("a load that never arrives must fail its caller")
        except RuntimeError:
            pass
        assert not w.cold, "the wake was armed even though nothing answered it"

    test("a wake that never loads raises rather than hanging", lambda: run_async(case_ensure_ready_gives_up()))

    def case_warm_is_idempotent():
        w = make_worker(idle_unload_s=60.0)
        w.cold = True
        assert w.warm() is True, "warming a cold worker starts the load"
        assert w.warm() is False, "warming a warm worker is a no-op the caller can see"
        assert not w.cold and w._wake.is_set(), "the supervisor was signalled"

    test("warm() starts a cold load once", case_warm_is_idempotent)

    # --- /health contract ---------------------------------------------------
    async def case_health_lists_cold_engines():
        server.ENABLED_ENGINES = ["chatterbox", "pocket-tts"]
        cb, pk = server.WORKERS["chatterbox"], server.WORKERS["pocket-tts"]
        saved = [(w.ready, w.cold, dict(w.ready_meta)) for w in (cb, pk)]
        try:
            cb.ready, cb.cold = False, True       # idle-unloaded
            pk.ready, pk.cold = False, False      # still booting / crash-looping
            body = await server.health()
            assert "chatterbox" in body["engines"], (
                "a cold engine MUST stay routable — the controller caches this list "
                "and only ever wakes an engine by calling /speak on it"
            )
            assert "pocket-tts" not in body["engines"], (
                "a not-yet-ready engine stays out, so /speak isn't called on a worker "
                "that can't answer"
            )
            assert body["cold"] == ["chatterbox"]
            assert body["chatterbox_loaded"] is False, (
                "*_loaded is residency, and a cold engine is not resident"
            )

            # Capability metadata outlives a deliberate stop.
            pk.ready, pk.cold = False, True
            pk.ready_meta = {"voice_cloning": True}
            body = await server.health()
            assert body["pocket_voice_cloning"] is True, (
                "cloning is a property of the image, not of the process — flickering "
                "it to unknown every idle window would make the admin warning worse"
            )
        finally:
            for w, (ready, cold, meta) in zip((cb, pk), saved):
                w.ready, w.cold, w.ready_meta = ready, cold, meta

    test("/health keeps cold engines routable and hides unready ones", lambda: run_async(case_health_lists_cold_engines()))

    def case_reset_keeps_meta_only_when_deliberate():
        w = make_worker()
        w.ready_meta = {"voice_cloning": True}
        w._reset(keep_meta=True)
        assert w.ready_meta == {"voice_cloning": True}, "a deliberate stop keeps capabilities"
        w._reset()
        assert w.ready_meta == {}, "a crash clears them — they're genuinely unknown again"

    test("_reset keeps capabilities across an unload, drops them on a crash", case_reset_keeps_meta_only_when_deliberate)

    async def case_wake_racing_the_unload_is_not_a_crash():
        # A render arriving in the window between the idle terminate and run()
        # observing the exit clears `cold` legitimately. run() must still read
        # that exit as the stop IT asked for — otherwise it logs a crash and
        # sits through a restart backoff before the caller's engine comes back.
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        w.RUN_BACKOFF_S = 5.0  # long enough that taking the crash path shows up
        runner = asyncio.create_task(w.run())
        try:
            await wait_for(lambda: w.ready, what="first load")
            procs[0].hold_exit = asyncio.Event()  # freeze run() inside proc.wait()
            w.loaded_at = server.time.monotonic() - 601.0
            w.IDLE_TICK_S = 0.01
            idler = asyncio.create_task(w.idle_loop())
            try:
                await wait_for(lambda: w.cold, what="the idle unload")
            finally:
                idler.cancel()
                await asyncio.gather(idler, return_exceptions=True)
            assert w._stopped_by_idle, "the idle unload latched its own stop"

            w.warm()  # the racing render, before run() has seen the exit
            assert not w.cold, "the wake cleared `cold`, which run() must NOT read"
            procs[0].hold_exit.set()  # now let the supervisor see the exit

            await wait_for(lambda: len(procs) == 2, timeout=1.0, what="an immediate respawn")
            assert w.ready_meta != {}, "the deliberate stop kept its capabilities"
        finally:
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("a wake racing the unload doesn't read as a crash", lambda: run_async(case_wake_racing_the_unload_is_not_a_crash()))

    # --- /speak -------------------------------------------------------------
    async def case_speak_503_on_dead_engine():
        server.ENABLED_ENGINES = ["chatterbox", "pocket-tts"]
        w = server.WORKERS["chatterbox"]
        saved = (w.ready, w.cold, w.idle_unload_s)
        try:
            w.ready, w.cold, w._loading = False, False, False  # down
            try:
                await server.speak(
                    server.SpeakRequest(
                        engine="chatterbox", text="hi", voice="", reference_wav="",
                        out="/tmp/subwave-tts-test.wav",
                    )
                )
                raise AssertionError("expected an HTTPException")
            except HTTPException as e:
                assert e.status_code == 503, (
                    f"an engine that can't render is 'service unavailable', not a 500 "
                    f"(got {e.status_code}) — the controller reads it and falls through "
                    "to its rescue voice"
                )
        finally:
            w.ready, w.cold, w.idle_unload_s = saved

    test("/speak on an engine that won't load answers 503", lambda: run_async(case_speak_503_on_dead_engine()))

    async def case_warm_endpoint():
        server.ENABLED_ENGINES = ["chatterbox"]
        cb = server.WORKERS["chatterbox"]
        saved = (cb.ready, cb.cold)
        try:
            cb.ready, cb.cold = False, True
            body = await server.warm(server.WarmRequest(engine=""))
            assert body["warming"] == ["chatterbox"], "an empty engine warms everything enabled"
            body = await server.warm(server.WarmRequest(engine=""))
            assert body["warming"] == [], "a second warm reports it started nothing"
            try:
                await server.warm(server.WarmRequest(engine="nope"))
                raise AssertionError("expected an HTTPException")
            except HTTPException as e:
                assert e.status_code == 400
        finally:
            cb.ready, cb.cold = saved

    test("/warm arms cold engines and rejects unknown ones", lambda: run_async(case_warm_endpoint()))


if __name__ == "__main__":
    sys.exit(main())
