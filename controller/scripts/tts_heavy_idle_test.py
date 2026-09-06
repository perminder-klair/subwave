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
#     90-second stall before the rescue voice is worse than no wait at all —
#     and so does one whose load the supervisor has ABANDONED, which is the
#     same silence arriving by a different route;
#   - a RELOAD restarts the idle clock, so a worker /warm has just brought back
#     survives the next tick. Without that the warm buys a whole model load and
#     the tick 30s later throws it away, leaving the first line after the pause
#     paying the cold start anyway — the feature's whole point, undone;
#   - the window resolves per ENGINE, so an operator using one engine doesn't
#     have the other's idle behaviour decided for them;
#   - every knob the sidecar reads is forwarded by all three compose files —
#     there is no env_file: here, so an unwired knob is one an operator sets
#     and watches do nothing;
#   - a malformed seconds value warns and reads its default rather than raising
#     at import, which would take the whole container (both engines) down.

import asyncio
import importlib.util
import json
import os
import re
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


def reload_server(**env):
    """Re-exec server.py under a given env and hand back the fresh module.

    The seconds knobs are read at IMPORT time, so the blast radius of a bad
    value is "the sidecar never boots" — and the only way to test that is to
    boot it. Returns a module object independent of the one the rest of the
    file uses; nothing is started until a lifespan runs.
    """
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        spec_ = importlib.util.spec_from_file_location("subwave_tts_heavy_reload", server_path)
        assert spec_ and spec_.loader
        mod = importlib.util.module_from_spec(spec_)
        spec_.loader.exec_module(mod)
        return mod
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


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

    def case_junk_ceiling_never_stops_the_boot():
        # Read at import time, so a typo here doesn't misconfigure one knob —
        # it stops the container, and BOTH engines go with it. Strictly worse
        # than quietly reading the default.
        assert reload_server(TTS_HEAVY_LOAD_TIMEOUT_S="90s").LOAD_TIMEOUT_S == 90.0, (
            "an unparseable ceiling reads the default instead of raising"
        )
        assert reload_server(TTS_HEAVY_LOAD_TIMEOUT_S="45").LOAD_TIMEOUT_S == 45.0
        # EMPTY is the important one, and it is not a typo — it is what every
        # compose file supplies by default: `${TTS_HEAVY_LOAD_TIMEOUT_S:-}`
        # sets the var to "", and os.environ.get(name, "90") returns "" rather
        # than the default for a var that IS set. A bare float("") raises, so
        # forwarding this knob (which is the other half of the same fix) would
        # have crash-looped the sidecar on every stock install. Verified
        # against the pre-fix module end to end: it never bound its port.
        assert reload_server(TTS_HEAVY_LOAD_TIMEOUT_S="").LOAD_TIMEOUT_S == 90.0, (
            "an empty var is 'not set', which is what compose passes by default"
        )
        for var in ("TTS_HEAVY_IDLE_UNLOAD_S", "CHATTERBOX_IDLE_UNLOAD_S", "POCKET_TTS_IDLE_UNLOAD_S"):
            mod = reload_server(**{var: ""})
            assert mod.idle_unload_seconds("chatterbox") == mod.IDLE_UNLOAD_CPU_S, (
                f"{var}= (empty, the compose default) must read as unset, not 0"
            )
        assert reload_server(TTS_HEAVY_LOAD_TIMEOUT_S="0").LOAD_TIMEOUT_S >= 5.0, (
            "0 would 503 every cold /speak — no load lands in no time at all — "
            "turning the idle unload into 'heavy voices stop working when the "
            "station goes quiet'. TTS_HEAVY_IDLE_UNLOAD_S=0 is how you ask for "
            "pinned engines."
        )

    test("a junk load ceiling never stops the sidecar booting", case_junk_ceiling_never_stops_the_boot)

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

    def case_reload_restarts_the_idle_clock():
        w = make_worker(idle_unload_s=60.0)
        w.ready = True
        # Spoke once, then the station went quiet long enough to be released.
        w.last_spoke = server.time.monotonic() - 601.0
        w.loaded_at = None
        assert w.should_unload(), "the gap that causes the unload in the first place"
        # …and the reload landed. `last_spoke` still holds the render from
        # BEFORE the unload, which is by definition past the window — that gap
        # is what unloaded the worker. Reading it alone made a freshly warmed
        # engine measure as instantly idle.
        w.loaded_at = server.time.monotonic()
        assert not w.should_unload(), (
            "a reload restarts the idle clock — otherwise /warm buys a whole "
            "model load, the next tick throws it away, and the first line "
            "after the pause pays the cold start anyway"
        )

    test("a reload restarts the idle clock", case_reload_restarts_the_idle_clock)

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

    async def case_warm_survives_the_next_idle_tick():
        # End to end for the clock reset above: the whole point of /warm is
        # that the engine is READY when the room fills up. An idle loop that
        # still measures from the pre-unload render undoes it within one tick,
        # and the operator pays a 4GB load for nothing.
        procs = install_fake_spawn([])
        w = make_worker(idle_unload_s=60.0)
        w.IDLE_TICK_S = 0.01
        runner = asyncio.create_task(w.run())
        idler = asyncio.create_task(w.idle_loop())
        try:
            await wait_for(lambda: w.ready, what="first load")
            await w.speak({"id": "1", "text": "hi", "out": "/tmp/x.wav"})
            # BOTH stamps age, because the clock is the later of the two — a
            # station that has been quiet since the container booted.
            w.last_spoke = server.time.monotonic() - 601.0
            w.loaded_at = server.time.monotonic() - 700.0
            await wait_for(lambda: w.cold, what="the idle unload")
            assert w.unloads == 1

            assert w.warm() is True, "the idle pause releasing arms the reload"
            await wait_for(lambda: w.ready, what="the warm reload")
            # Many ticks' worth at 10ms. Nothing may take the model away.
            await asyncio.sleep(0.2)
            assert w.ready and not w.cold, (
                "a warmed engine survives the idle ticks — it was reloaded "
                "seconds ago in anticipation of a room filling up"
            )
            assert w.unloads == 1, "and `unloads` didn't invent a second release"
            assert len(procs) == 2, "one boot, one reload — no thrash"
        finally:
            runner.cancel()
            idler.cancel()
            await asyncio.gather(runner, idler, return_exceptions=True)

    test("a warmed engine survives the idle ticks", lambda: run_async(case_warm_survives_the_next_idle_tick()))

    async def case_abandoned_load_fails_before_the_ceiling():
        # A cold worker whose start() cannot succeed (missing venv, fatal model
        # error, OOM) must fail its caller the moment the supervisor gives up,
        # NOT at LOAD_TIMEOUT_S. Waiting out the ceiling holds the DJ in
        # silence for a load that is not coming, when the rescue chain was
        # ready the whole time — and a worker that was merely down has always
        # failed at once.
        async def failing_exec(*_args, **_kwargs):
            raise OSError("no such venv: /opt/chatterbox/bin/python")

        saved_exec = asyncio.create_subprocess_exec
        saved_ceiling = server.LOAD_TIMEOUT_S
        asyncio.create_subprocess_exec = failing_exec
        server.LOAD_TIMEOUT_S = 5.0
        w = make_worker(idle_unload_s=60.0)
        w.START_BACKOFF_S = 5.0  # long enough that a retry can't rescue the wait
        w.cold = True
        runner = asyncio.create_task(w.run())
        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            try:
                await w.speak({"id": "1", "text": "hi", "out": "/tmp/x.wav"})
                raise AssertionError("a load that cannot start must fail the render")
            except RuntimeError:
                pass
            elapsed = loop.time() - started
            assert elapsed < 2.0, (
                f"the caller waited {elapsed:.1f}s of a {server.LOAD_TIMEOUT_S}s "
                "ceiling for a load the supervisor had already abandoned"
            )
        finally:
            server.LOAD_TIMEOUT_S = saved_ceiling
            asyncio.create_subprocess_exec = saved_exec
            runner.cancel()
            await asyncio.gather(runner, return_exceptions=True)

    test("an abandoned load fails its caller without waiting out the ceiling", lambda: run_async(case_abandoned_load_fails_before_the_ceiling()))

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

    # --- operator surface ---------------------------------------------------
    def case_every_knob_reaches_the_container():
        # The service has NO `env_file:` — each compose file's `environment:`
        # list is the whole surface — so a knob the sidecar reads but compose
        # never forwards is one an operator can set in the root .env and watch
        # do nothing, silently. #1579 shipped exactly that: three of its four
        # new vars were wired up and TTS_HEAVY_LOAD_TIMEOUT_S was documented in
        # .env.example and docs/tts-heavy.md but forwarded nowhere.
        #
        # One table (server.OPERATOR_ENV_KNOBS), three copies, same shape as
        # max-listeners.test.ts and state-bootstrap.test.ts.
        repo = Path(__file__).parents[2]
        knobs = server.OPERATOR_ENV_KNOBS
        assert len(knobs) >= 6, "the declared knob set looks truncated"

        source = (repo / "docker" / "tts-heavy" / "server.py").read_text()
        stale = [k for k in knobs if f'"{k}"' not in source]
        assert not stale, f"declared but no longer read by the sidecar: {stale}"

        for name in ("docker-compose.yml", "docker-compose.dev.yml", "docker-compose.byo.yml"):
            text = (repo / name).read_text()
            block = text.split("\n  tts-heavy:\n", 1)
            assert len(block) == 2, f"{name} has no tts-heavy service"
            # Up to the next top-level service key (two-space indent).
            service = re.split(r"\n  [a-z][a-z0-9-]*:\n", block[1])[0]
            missing = [k for k in knobs if f"- {k}=" not in service]
            assert not missing, (
                f"{name} does not pass {', '.join(missing)} into tts-heavy, so "
                "setting it in the root .env does nothing. Add it to the "
                "service's environment: list and re-run "
                "`npm --prefix cli run embed-assets`."
            )

    test("every operator knob reaches the container in all three composes", case_every_knob_reaches_the_container)

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

    async def case_reloading_engine_stays_routable():
        # A worker mid-RELOAD must stay in /health's `engines`. warm() clears
        # `cold` and sets `_loading`, so between the wake and the load landing
        # the engine was in NEITHER list and dropped out of `engines`
        # altogether. The controller caches that list and routes on it, so for
        # the 30-60s of a real Chatterbox reload it stopped routing to the
        # engine and sent the DJ to its rescue voice — across exactly the
        # window /warm exists to make inaudible, and on exactly the line the
        # talk scheduler warmed the sidecar for. Seen live in the controller
        # log as a `sidecar unavailable` / `available` flap around every warm.
        #
        # A worker that has NEVER loaded still stays out, which is the
        # distinction the cold/not-ready split was drawn for: `_loading` is
        # only set by warm(), warm() only runs on a `cold` worker, and only the
        # idle unload makes one cold — so `_loading` implies the engine came up
        # successfully at least once in this container's life. A booting or
        # crash-looping worker has `_loading` False and is unaffected.
        server.ENABLED_ENGINES = ["chatterbox", "pocket-tts"]
        cb, pk = server.WORKERS["chatterbox"], server.WORKERS["pocket-tts"]
        saved = [(w.ready, w.cold, w._loading) for w in (cb, pk)]
        try:
            cb.ready, cb.cold, cb._loading = False, False, True   # mid-reload
            pk.ready, pk.cold, pk._loading = False, False, False  # never loaded
            body = await server.health()
            assert "chatterbox" in body["engines"], (
                "an engine that is RELOADING must stay routable — /speak waits "
                "out the load, and dropping it sends the DJ to its rescue voice "
                "for the whole window /warm exists to hide"
            )
            assert "pocket-tts" not in body["engines"], (
                "a worker that has never loaded still stays out"
            )
            assert body["cold"] == [], "reloading is not the same as released"
            assert body["chatterbox_loaded"] is False, "and it is not resident yet"
        finally:
            for w, (ready, cold, loading) in zip((cb, pk), saved):
                w.ready, w.cold, w._loading = ready, cold, loading

    test("an engine mid-reload stays routable", lambda: run_async(case_reloading_engine_stays_routable()))

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
        saved_enabled = list(server.ENABLED_ENGINES)
        server.ENABLED_ENGINES = ["chatterbox"]
        cb = server.WORKERS["chatterbox"]
        saved = (cb.ready, cb.cold)
        try:
            cb.ready, cb.cold = False, True
            body = await server.warm(server.WarmRequest(engine=""))
            assert body["warming"] == ["chatterbox"], "an empty engine warms everything enabled"
            assert body["loaded"] == [] and body["cold"] == [], (
                "residency is REPORTED, not promised — warm() cleared `cold` "
                "and the load hasn't landed yet"
            )
            body = await server.warm(server.WarmRequest(engine=""))
            assert body["warming"] == [], "a second warm reports it started nothing"

            # A name this image knows but TTS_HEAVY_ENGINES never loaded. It
            # must not read as "already warm" — that is the one answer an
            # operator asking why their engine won't come back must not get.
            body = await server.warm(server.WarmRequest(engine="pocket-tts"))
            assert body["warming"] == [] and body["disabled"] == ["pocket-tts"]

            try:
                await server.warm(server.WarmRequest(engine="nope"))
                raise AssertionError("expected an HTTPException")
            except HTTPException as e:
                assert e.status_code == 400, "a typo is still a 400, not a quiet no-op"
        finally:
            cb.ready, cb.cold = saved
            server.ENABLED_ENGINES = saved_enabled

    test("/warm arms cold engines, names disabled ones, rejects unknown ones", lambda: run_async(case_warm_endpoint()))


if __name__ == "__main__":
    sys.exit(main())
