"""
subwave-tts-heavy — optional Chatterbox + PocketTTS sidecar for SUB/WAVE.

The controller (audio/chatterbox.ts, audio/pocketTts.ts) talks to this over
HTTP when TTS_HEAVY_URL is set. A thin FastAPI shim over two long-lived
subprocesses — the SAME stdio workers the controller runs in-process
(controller/scripts/{chatterbox,pocket_tts}_worker.py), one venv each because
the two packages have incompatible pip resolutions. One JSON object per line
over stdin/stdout; an asyncio.Lock per worker serialises requests. No audio
over the wire — the sidecar writes the WAV to the absolute `out` path on the
shared /var/sub-wave volume and the controller hands that path to Liquidsoap.

Engines do not stay resident forever: after TTS_HEAVY_IDLE_UNLOAD_S without
a render the supervisor stops that engine's worker and reloads it on the next
/speak (or ahead of one, on /warm). See the idle-unload block below for why
the reclaim is a process exit rather than an in-process release (#1579).

Endpoints:
  GET  /health   → {ok, engines, cold, chatterbox_loaded, pocket_loaded}
  POST /speak    → {ok, path, duration_s}
    body: {engine, text, voice?, reference_wav?, out}
  POST /warm     → {ok, warming, disabled, loaded, cold}
    body: {engine?}   (omitted / empty = every enabled engine)
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

CHATTERBOX_PYTHON = os.environ.get("CHATTERBOX_PYTHON", "/opt/chatterbox/venv/bin/python")
CHATTERBOX_WORKER = os.environ.get("CHATTERBOX_WORKER", "/app/workers/chatterbox_worker.py")
POCKET_TTS_PYTHON = os.environ.get("POCKET_TTS_PYTHON", "/opt/pocket-tts/venv/bin/python")
POCKET_TTS_WORKER = os.environ.get("POCKET_TTS_WORKER", "/app/workers/pocket_tts_worker.py")

DEVICE = os.environ.get("TTS_HEAVY_DEVICE", "cpu").lower()
POCKET_TTS_DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "alba")

# Per-worker HF cache homes so the engines don't fight over one directory;
# each is a named volume in compose, so first-boot weight downloads survive
# recreates. Passed into each worker's env via env_extra.
CHATTERBOX_HF_HOME = os.environ.get("CHATTERBOX_HF_HOME", "/opt/chatterbox/hf-cache")
POCKET_HF_HOME = os.environ.get("POCKET_HF_HOME", "/opt/pocket-tts/hf-cache")

# Max bytes of one worker stdout line. TTS responses are small, but keep in
# step with the analyzer sidecar so a future payload can't hit asyncio's
# 64 KiB default and LimitOverrunError (#996).
WORKER_STDOUT_LIMIT = 16 * 1024 * 1024

# Which engines to load. BOTH are baked into the image, but each costs RAM +
# a multi-GB first-boot download + 30-60s startup, so operators can narrow the
# comma-separated list. Unknown/empty entries are ignored; an empty result
# falls back to both so a typo never silently disables all TTS.
_ALL_ENGINES = ("chatterbox", "pocket-tts")
ENABLED_ENGINES = [
    e
    for e in (
        s.strip().lower()
        for s in os.environ.get("TTS_HEAVY_ENGINES", "chatterbox,pocket-tts").split(",")
    )
    if e in _ALL_ENGINES
]
if not ENABLED_ENGINES:
    ENABLED_ENGINES = list(_ALL_ENGINES)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("tts-heavy")

# --- idle unload (#1579) ----------------------------------------------------
# Chatterbox is ~4GB resident — weights plus, on CUDA, torch's context — and it
# used to be held for the life of the container whether or not the station had
# spoken in twelve hours. The programme's idle pause (stream.idleAfterMinutes)
# stands the MUSIC down when the room empties but has no reach in here, which
# is the specific surprise operators hit. So each worker gets its own idle
# clock: after this many seconds without a render, stop it; reload on the next
# /speak, or ahead of one on /warm.
#
# The reclaim is a PROCESS EXIT, not an in-process `del model`, and that is the
# whole design. #1204 established on the analyzer that dropping the model
# singletons leaves torch's imported modules — and on CUDA its context —
# resident until the process ends, so an in-process release hands back only
# part of the memory and the operator still sees gigabytes pinned. Exiting is
# also nearly free here: run() is already a restart supervisor, so "unload"
# is one terminate away and the workers themselves need no idle protocol.
#
# The window must sit well ABOVE the station's natural talk cadence or the
# reload becomes the new normal: the talk scheduler can offer the segment
# director a minute every five, so a five-minute window would thrash a station
# that is merely between links rather than idle. Thirty minutes of total
# silence is three times the idle-pause default and unreachable by a station
# that is on air and talking. CUDA is tighter than CPU because VRAM contention
# is urgent in a way that host RAM is not, and a GPU reload is the fast one.
IDLE_UNLOAD_CUDA_S = 1800.0
IDLE_UNLOAD_CPU_S = 3600.0

# Per-engine, not per-sidecar: this container carries both engines, and an
# operator who uses one and not the other should not have the unused engine's
# idle behaviour decide the used one's. A specific var beats the shared one,
# which beats the device-aware default; 0 (or negative) means always resident,
# i.e. the pre-#1579 behaviour.
_IDLE_ENV_BY_ENGINE = {
    "chatterbox": "CHATTERBOX_IDLE_UNLOAD_S",
    "pocket-tts": "POCKET_TTS_IDLE_UNLOAD_S",
}


# The operator-facing env knobs, DECLARED rather than inferred from the reads
# below (they go through helpers now, so grepping for os.environ finds only
# half of them). This service has no `env_file:` — its `environment:` list in
# each compose file is the entire surface — so a name here that is missing from
# one of those files is a setting the operator can put in the root .env and
# watch do nothing. #1579 shipped exactly that with TTS_HEAVY_LOAD_TIMEOUT_S.
# scripts/tts_heavy_idle_test.py drives all three compose copies off this tuple.
#
# Everything else server.py reads is an image-internal path (the per-worker
# CHATTERBOX_PYTHON / _WORKER / _HF_HOME set in env_extra or the Dockerfile),
# not something an operator sets. CHATTERBOX_REFERENCE_WAV is the one judgement
# call: it is read here as the worker's built-in default, but in sidecar mode
# every /speak carries the persona's own reference_wav in its body, so the env
# default is unreachable in practice and has never been forwarded or
# documented. Left as it was — widening it is its own change, not #1579's.
OPERATOR_ENV_KNOBS = (
    "TTS_HEAVY_DEVICE",
    "TTS_HEAVY_ENGINES",
    "POCKET_TTS_VOICE",
    "TTS_HEAVY_IDLE_UNLOAD_S",
    "CHATTERBOX_IDLE_UNLOAD_S",
    "POCKET_TTS_IDLE_UNLOAD_S",
    "TTS_HEAVY_LOAD_TIMEOUT_S",
)


def _parse_seconds(name: str) -> float | None:
    """One seconds-valued env var, or None when it is unset or unparseable.

    EVERY seconds knob in this file reads through here, and none of them may
    raise. A container that refuses to boot over `TTS_HEAVY_LOAD_TIMEOUT_S=90s`
    takes BOTH engines down and the station loses its heavy voices entirely,
    which is strictly worse than one knob quietly reading its default. Warn,
    coerce to the pre-existing behaviour, keep serving — the same posture the
    state bootstrap takes for the same reason.
    """
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        log.warning(f"{name}={raw!r} is not a number; ignoring")
        return None


def idle_unload_seconds(engine: str) -> float:
    """Resolve one engine's idle window in seconds. 0 disables."""
    for name in (_IDLE_ENV_BY_ENGINE.get(engine), "TTS_HEAVY_IDLE_UNLOAD_S"):
        if not name:
            continue
        value = _parse_seconds(name)
        # A junk value falls through to the next source rather than disabling
        # the feature: an unreadable window is no window at all, not zero.
        if value is not None:
            return max(0.0, value)
    # PocketTTS' venv is CPU-torch by construction (see Dockerfile.tts-heavy),
    # so chatterbox is the only engine TTS_HEAVY_DEVICE can actually move.
    if engine == "chatterbox" and DEVICE == "cuda":
        return IDLE_UNLOAD_CUDA_S
    return IDLE_UNLOAD_CPU_S


# How long /speak waits for a cold worker to finish loading before giving up
# and letting the caller fall through the controller's rescue chain. Chatterbox
# is 30-60s from a warm HF cache; the ceiling leaves the rest of the client's
# 180s TTS_HEAVY_TIMEOUT_MS budget for the inference that follows.
_LOAD_TIMEOUT_ENV = _parse_seconds("TTS_HEAVY_LOAD_TIMEOUT_S")
# Floored rather than read raw: 0 would 503 every cold /speak (no load lands in
# no time at all), turning the idle unload into "the heavy voices stop working
# once the station goes quiet". An operator who wants the engines pinned says
# so with TTS_HEAVY_IDLE_UNLOAD_S=0, which is the honest way to ask for it.
LOAD_TIMEOUT_S = max(5.0, _LOAD_TIMEOUT_ENV) if _LOAD_TIMEOUT_ENV is not None else 90.0


class TtsWorker:
    """Async wrapper around a long-lived stdio TTS worker subprocess.

    Same line protocol as the controller's in-process TS clients; no
    multiplexing — one request in flight per worker, gated by a lock. run()
    supervises the lifecycle so a crash (OOM, fatal model error) recovers
    without bouncing the container, and so an idle unload (#1579) can stop the
    worker and park the supervisor until something needs the engine again.
    """

    # START_BACKOFF applies when start() itself fails (model load error,
    # missing venv); RUN_BACKOFF when the worker exited after a clean start.
    START_BACKOFF_S = 5.0
    RUN_BACKOFF_S = 2.0
    # How often the idle clock is checked. Coarse on purpose: the windows are
    # tens of minutes, and every tick that finds nothing to do is pure noise.
    IDLE_TICK_S = 30.0

    def __init__(
        self,
        name: str,
        python: str,
        script: str,
        env_extra: dict[str, str] | None = None,
        idle_unload_s: float = 0.0,
    ):
        self.name = name
        self.python = python
        self.script = script
        self.env_extra = env_extra or {}
        self.idle_unload_s = idle_unload_s
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.ready = False
        # Ready message minus the `ready` flag — per-engine capability
        # metadata (e.g. pocket-tts' voice_cloning, #238). Cleared on a crash,
        # KEPT across an idle unload — see _reset().
        self.ready_meta: dict[str, Any] = {}
        # Idle-unload state. `cold` is "stopped on purpose, loadable on
        # demand", which is a different thing from `not ready` ("booting, or
        # crash-looping, and not usable"). They cannot share one flag because
        # /health has to keep advertising a cold engine to the controller
        # while still hiding a broken one — see health().
        self.cold = False
        # Latched by the idle unload, consumed by run() when it sees the exit.
        # run() cannot read `cold` for this: a /speak or /warm arriving in the
        # milliseconds between the terminate and the exit being observed
        # clears `cold` legitimately, and the supervisor would then log a
        # crash and sit through a restart backoff for a stop it asked for.
        self._stopped_by_idle = False
        self.unloads = 0
        self.last_spoke: float | None = None
        self.loaded_at: float | None = None
        self._wake = asyncio.Event()
        # True between arming a reload and that load landing (or failing).
        # Lets a second caller that arrives mid-load wait for it instead of
        # being told the worker is down.
        self._loading = False
        # Renders that have claimed this worker but not finished. An unload
        # must never race one: it would kill a render mid-flight and cost the
        # caller a rescue, for memory the next tick would have freed anyway.
        self._inflight = 0

    async def run(self) -> None:
        """Keep the worker alive; on cancellation (lifespan teardown) terminate
        the running subprocess before bubbling up.

        A worker parked cold by the idle unload waits here — no process, no
        memory — until ensure_ready()/warm() sets the wake event."""
        try:
            while True:
                if self.cold:
                    await self._wake.wait()
                self._wake.clear()
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    # The load attempt is over. Callers waiting on it are
                    # released to their rescue voice now rather than sitting
                    # through the backoff and a second attempt.
                    self._loading = False
                    self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                assert self.proc is not None
                code = await self.proc.wait()
                deliberate = self._stopped_by_idle
                self._stopped_by_idle = False
                if deliberate:
                    # We asked for this exit: no warning, no backoff, and no
                    # respawn until the engine is wanted again (which, if a
                    # render woke it while it was dying, has already happened
                    # and the next loop starts it straight back up).
                    log.info(
                        f"[{self.name}] worker stopped (idle unload) — memory released",
                    )
                    self._reset(keep_meta=True)
                    continue
                log.warning(
                    f"[{self.name}] worker exited with code={code}; restarting in {self.RUN_BACKOFF_S}s",
                )
                self._reset()
                await asyncio.sleep(self.RUN_BACKOFF_S)
        except asyncio.CancelledError:
            self._terminate()
            raise

    def _reset(self, keep_meta: bool = False) -> None:
        self.ready = False
        self.proc = None
        self.loaded_at = None
        # ready_meta survives a DELIBERATE stop (keep_meta). What it carries
        # (pocket-tts' voice_cloning, #238) is a property of the image, not of
        # this process, and the controller reads a missing flag as "unknown"
        # and drops the operator warning that cloned voices won't take effect.
        # Flickering that off every idle window would make the admin UI worse
        # about a fact that did not change. A crash still clears it — there the
        # capability genuinely is unknown until the worker re-reports it.
        if not keep_meta:
            self.ready_meta = {}

    def _terminate(self) -> None:
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass

    async def start(self) -> None:
        log.info(f"[{self.name}] starting worker: {self.python} {self.script}")
        env = {**os.environ, **self.env_extra}
        self.proc = await asyncio.create_subprocess_exec(
            self.python,
            self.script,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=WORKER_STDOUT_LIMIT,
        )
        # Pump stderr to our log so model load progress / fatal errors land in
        # the container logs. Exits when the worker closes stderr on death.
        asyncio.create_task(self._pump_stderr())

        # Read until {"ready": true}, skipping non-JSON stdout noise (perth —
        # chatterbox's watermarker — bare-print()s a load message). Chatterbox
        # can take 30+ seconds even from a warm cache, so no timeout — run()'s
        # restart loop is the upstream safety net.
        try:
            msg = await self._await_message()
            if msg.get("fatal"):
                raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
            if not msg.get("ready"):
                raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        except Exception:
            # Terminate the half-booted process so run() doesn't pile orphans
            # up across retry cycles.
            self._terminate()
            raise
        self.ready_meta = {k: v for k, v in msg.items() if k != "ready"}
        log.info(f"[{self.name}] ready {self.ready_meta or ''}".rstrip())
        # Seeds the idle clock: a worker that loads and is never asked to speak
        # is idle from the moment it came up, not from an unset stamp.
        self.loaded_at = time.monotonic()
        self._loading = False
        self.ready = True

    async def _await_message(self) -> dict[str, Any]:
        """Read worker stdout until a parseable JSON object arrives."""
        assert self.proc and self.proc.stdout
        while True:
            line = await self.proc.stdout.readline()
            if not line:
                raise RuntimeError(f"[{self.name}] worker exited before message")
            text = line.decode().strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                # Noise from a transitive dep — visible but not a protocol
                # failure.
                log.info(f"[{self.name}] non-JSON on stdout: {text!r}")
                continue
            return msg

    async def _pump_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        proc = self.proc
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            log.info(f"[{self.name}] {line.decode().rstrip()}")

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            # Fail fast when the worker is down — the controller's dispatcher
            # falls back to Piper, preferable to blocking the HTTP request on
            # an unhealthy worker.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                raise RuntimeError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            # _await_message skips post-ready print() noise too — without
            # that, any stray stdout would crash the next /speak call.
            return await self._await_message()

    async def speak(self, payload: dict[str, Any]) -> dict[str, Any]:
        """One render, loading the worker first if the idle unload parked it."""
        # Claimed before anything can await, so an idle tick that is already
        # running sees the claim and stands down instead of unloading the
        # worker out from under this call.
        self._inflight += 1
        try:
            await self.ensure_ready()
            return await self.request(payload)
        finally:
            # The idle clock tracks DEMAND, not success: a run of failing
            # renders is the worst moment to unload the engine underneath the
            # retries, and a caller that asked is a caller that may ask again.
            self.last_spoke = time.monotonic()
            self._inflight -= 1

    async def ensure_ready(self, timeout_s: float | None = None) -> None:
        """Wake a cold worker and wait out its load. No-op when already up.

        Only a COLD worker (or one already loading for someone else) is worth
        waiting for. A worker that is merely not ready is booting or
        crash-looping, and that caller has to hear it AT ONCE: the controller's
        rescue chain is what keeps the station talking, and a minute and a half
        of silence before reaching it is far worse than the cold start this
        wait exists to cover. That is also the pre-#1579 behaviour for a
        sidecar whose engine is down, and it should not change.

        Deliberately OUTSIDE the request lock, for the same reason: a wake that
        never arrives must fail its caller rather than park an HTTP request on
        a lock behind a model that is not coming back."""
        if self.ready:
            return
        # warm() is the side effect, not the predicate: it clears `cold`, arms
        # `_loading` and wakes the supervisor. Hoisted out of the `if` so that
        # is visible to the next reader.
        started = self.warm()
        if not (started or self._loading):
            raise RuntimeError(f"[{self.name}] worker not ready")
        deadline = time.monotonic() + (LOAD_TIMEOUT_S if timeout_s is None else timeout_s)
        while time.monotonic() < deadline:
            if self.ready:
                return
            if not self._loading:
                # The supervisor gave up on this load — start() raised (missing
                # venv, fatal model error, OOM) and cleared the flag. Sitting
                # out the rest of the ceiling would hold the caller in silence
                # waiting for a load that is not coming; degrade NOW, which is
                # what the rescue chain is for and what a worker that was
                # merely down has always done. start() clears the flag and sets
                # `ready` in one synchronous run, so a load that SUCCEEDED can
                # never be observed through this branch.
                raise RuntimeError(f"[{self.name}] worker failed to load")
            await asyncio.sleep(0.25)
        raise RuntimeError(f"[{self.name}] worker did not load in time")

    def warm(self) -> bool:
        """Start a cold worker's reload WITHOUT waiting for it. True when this
        call is what started it.

        Synchronous and non-blocking on purpose: the controller fires it when
        the programme's idle pause releases, so the load overlaps with the room
        filling up instead of landing on the first spoken line."""
        if not self.cold:
            return False
        log.info(f"[{self.name}] cold — loading on demand")
        # Cleared BEFORE the event so run(), which re-checks the flag at the
        # top of its loop, cannot go back to sleep on a stale read.
        self.cold = False
        self._loading = True
        self._wake.set()
        return True

    def routable(self) -> bool:
        """Whether the controller may still send this engine a /speak.

        Three states qualify, and the third is the one that is easy to miss:
        READY (obviously), COLD (one on-demand load away — dropping it is the
        one-way door /health's comment describes), and RELOADING. A worker
        between `warm()` and the load landing has had `cold` cleared and
        `ready` not yet set, so it belonged to neither list and fell out of
        `engines` entirely — for the whole 30-60s of a real Chatterbox reload
        the controller stopped routing to it and the DJ took its rescue voice,
        across exactly the window /warm exists to make inaudible and on
        exactly the line the talk scheduler warmed the sidecar for. /speak
        already handles this state correctly: ensure_ready() waits the load
        out.

        A worker that has never loaded still stays out, which is the whole
        point of splitting `cold` from `not ready`. `_loading` is only set by
        warm(), warm() only runs on a `cold` worker, and only the idle unload
        makes one cold — so `_loading` implies this engine came up
        successfully at least once. A booting or crash-looping worker has it
        False and is advertised exactly as before.
        """
        return self.ready or self.cold or self._loading

    def idle_for(self) -> float:
        """Seconds since this worker last had something to do.

        The LATER of the two stamps, never `last_spoke` alone. A RELOAD resets
        this clock, and it has to: `last_spoke` still holds the render from
        before the unload, which is by definition already past the window —
        that gap is what unloaded the worker in the first place. Reading it
        alone meant a worker /warm had just brought back measured as idle
        immediately and was dropped again on the very next tick, so the warm
        bought a full model load and gave nothing back. The /speak path hid
        this, because it stamps `last_spoke` on its way out.
        """
        stamps = [t for t in (self.last_spoke, self.loaded_at) if t is not None]
        return 0.0 if not stamps else time.monotonic() - max(stamps)

    def should_unload(self) -> bool:
        """Whether an idle tick may stop this worker right now. Pure, so the
        precedence between the guards is unit-pinned rather than inferred from
        the loop."""
        if self.idle_unload_s <= 0:
            return False
        if not self.ready or self.cold:
            return False
        if self._inflight:
            return False
        return self.idle_for() >= self.idle_unload_s

    async def idle_loop(self) -> None:
        """Stop the worker after idle_unload_s without a render, so run() parks
        it cold and the memory goes back to the host. Never respawns eagerly —
        the reload is paid by whoever next wants the engine."""
        if self.idle_unload_s <= 0:
            return
        while True:
            await asyncio.sleep(self.IDLE_TICK_S)
            if not self.should_unload():
                continue
            async with self.lock:
                # Re-check under the lock: a render may have landed, or
                # claimed the worker, while we waited to acquire it.
                if not self.should_unload():
                    continue
                log.info(
                    f"[{self.name}] idle {int(self.idle_unload_s)}s without a render — "
                    "unloading; reloads on the next /speak or /warm",
                )
                self.unloads += 1
                # Latch first, then flip the flags, then kill: run() reads the
                # latch to tell this exit from a crash, and request() must stop
                # admitting work before the process goes away under it.
                self._stopped_by_idle = True
                self.cold = True
                self.ready = False
                self._terminate()


chatterbox_worker = TtsWorker(
    name="chatterbox",
    python=CHATTERBOX_PYTHON,
    script=CHATTERBOX_WORKER,
    env_extra={
        "CHATTERBOX_DEVICE": DEVICE,
        "CHATTERBOX_REFERENCE_WAV": os.environ.get("CHATTERBOX_REFERENCE_WAV", ""),
        "HF_HOME": CHATTERBOX_HF_HOME,
    },
    idle_unload_s=idle_unload_seconds("chatterbox"),
)

pocket_worker = TtsWorker(
    name="pocket-tts",
    python=POCKET_TTS_PYTHON,
    script=POCKET_TTS_WORKER,
    env_extra={
        "POCKET_TTS_VOICE": POCKET_TTS_DEFAULT_VOICE,
        "HF_HOME": POCKET_HF_HOME,
    },
    idle_unload_s=idle_unload_seconds("pocket-tts"),
)

# Name → worker, so /health, /speak and /warm all resolve an engine the same
# way instead of each carrying its own if/elif over the two names.
WORKERS: dict[str, TtsWorker] = {
    "chatterbox": chatterbox_worker,
    "pocket-tts": pocket_worker,
}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background tasks so uvicorn binds :8080 immediately — chatterbox's
    # 30-60s cold load would otherwise block the bind and the controller's
    # probe would see "connection refused" for the entire boot.
    log.info(f"enabled engines: {', '.join(ENABLED_ENGINES)}")
    tasks = []
    for name in ENABLED_ENGINES:
        worker = WORKERS[name]
        tasks.append(asyncio.create_task(worker.run(), name=f"{name}-run"))
        # Engines start loaded — an operator who restarts the container is
        # asking for a station that can talk, not one that pays a cold load on
        # its first line. The idle clock takes it from there.
        if worker.idle_unload_s > 0:
            tasks.append(asyncio.create_task(worker.idle_loop(), name=f"{name}-idle"))
            log.info(
                f"[{name}] idle unload armed — releases after "
                f"{int(worker.idle_unload_s)}s without a render",
            )
        else:
            log.info(f"[{name}] idle unload disabled — model stays resident")
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        # Let the supervisors terminate their subprocesses before uvicorn
        # exits; the container-stop SIGKILL is the fallback if this hangs.
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="subwave-tts-heavy", lifespan=lifespan)


class SpeakRequest(BaseModel):
    engine: str
    text: str
    voice: str = ""
    reference_wav: str = ""
    out: str


class WarmRequest(BaseModel):
    # Empty means every enabled engine — the controller fires /warm on a
    # station-wide event (the idle pause releasing) and does not track which
    # persona will speak first.
    engine: str = ""


@app.get("/health")
async def health():
    # `engines` lists engines the controller may ROUTE TO, which is not the
    # same as engines loaded right now. Its probe (audio/ttsHeavyClient.ts)
    # keys availability on `engines.includes(<name>)` and caches the result,
    # and tts.ts reads that cached boolean to decide whether the engine is a
    # usable voice slot at all. So:
    #
    #   - a still-booting or crash-looping engine stays OUT, as before —
    #     advertising it would buy failed /speak calls instead of clean
    #     fall-throughs to Piper;
    #   - an engine parked COLD by the idle unload stays IN, because it is
    #     one on-demand load away from speaking. Dropping it here would be a
    #     one-way door: the controller would reroute to the rescue chain,
    #     never call /speak again, and so never wake the engine — memory
    #     freed, voice gone for good (#1579).
    #
    # `cold` and the *_loaded booleans are the operator's view of the same
    # state: what is resident right now, and what is merely loadable.
    ready_engines: list[str] = []
    cold_engines: list[str] = []
    routable_engines: list[str] = []
    for name in ENABLED_ENGINES:
        worker = WORKERS[name]
        if worker.ready:
            ready_engines.append(name)
        elif worker.cold:
            cold_engines.append(name)
        # Routability is the worker's own question and includes a THIRD state
        # neither list above covers — mid-reload. See TtsWorker.routable().
        if worker.routable():
            routable_engines.append(name)
    return {
        "ok": True,
        "engines": routable_engines,
        # What TTS_HEAVY_ENGINES asked for, regardless of load state.
        "enabled": ENABLED_ENGINES,
        # Unloaded by the idle policy — usable, but the next line pays a load.
        "cold": cold_engines,
        # Per-engine idle window in seconds (0 = always resident), and how
        # many times each has been released, so an operator can confirm the
        # reclaim is happening rather than inferring it from `docker stats`.
        "idle_unload_s": {name: WORKERS[name].idle_unload_s for name in ENABLED_ENGINES},
        "unloads": {name: WORKERS[name].unloads for name in ENABLED_ENGINES},
        "chatterbox_loaded": chatterbox_worker.ready,
        "pocket_loaded": pocket_worker.ready,
        # PocketTTS zero-shot cloning capability — false when the gated
        # weights weren't available at load (no HF_TOKEN), so cloned .wav
        # voices don't silently revert to a built-in (#238). None until the
        # worker has reported once; a cold worker keeps its last answer
        # (_reset) because the image's capabilities didn't change with it.
        "pocket_voice_cloning": (
            pocket_worker.ready_meta.get("voice_cloning")
            if (pocket_worker.ready or pocket_worker.cold)
            else None
        ),
    }


@app.post("/speak")
async def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if not req.out:
        raise HTTPException(400, "missing 'out' path")
    Path(req.out).parent.mkdir(parents=True, exist_ok=True)

    # A known engine this sidecar was told not to load: fail clearly so the
    # dispatcher falls back to Piper instead of blocking on a worker that
    # will never become ready.
    if req.engine in _ALL_ENGINES and req.engine not in ENABLED_ENGINES:
        raise HTTPException(
            503,
            f"engine '{req.engine}' is disabled on this sidecar "
            f"(TTS_HEAVY_ENGINES={','.join(ENABLED_ENGINES)})",
        )

    if req.engine == "chatterbox":
        payload = {
            "id": "1",
            "text": text,
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        }
    elif req.engine == "pocket-tts":
        payload = {
            "id": "1",
            "text": text,
            "voice": req.voice or POCKET_TTS_DEFAULT_VOICE,
            # Reference WAV for zero-shot cloning (#213); the worker treats an
            # empty value as "use the built-in voice".
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        }
    else:
        raise HTTPException(400, f"unknown engine: {req.engine}")

    # speak() loads the worker first when the idle unload parked it (#1579).
    # A worker that is down, or one whose load doesn't arrive inside
    # LOAD_TIMEOUT_S, becomes a 503 rather than an unhandled 500: the
    # controller reads any non-2xx the same way, but a "service unavailable"
    # is what actually happened and is what the operator needs to see in the
    # log next to the Piper line that replaced it.
    try:
        msg = await WORKERS[req.engine].speak(payload)
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "worker failed")
    return {
        "ok": True,
        "path": msg["path"],
        "duration_s": msg.get("duration_s", 0),
        # PocketTTS' per-call voice substitution (#238) so the controller can
        # log when the requested voice/clone wasn't honoured. Absent for
        # engines that don't report it.
        "voice_used": msg.get("voice_used"),
        "fell_back": msg.get("fell_back", False),
        "fell_back_reason": msg.get("fell_back_reason"),
    }


@app.post("/warm")
async def warm(req: WarmRequest):
    """Start reloading any cold engine, without waiting for the load.

    This is what keeps the idle unload from being heard. The controller calls
    it when the programme's idle pause releases (broadcast/stream-idle.ts), so
    a room that has just filled up reloads the model while the music comes
    back rather than stalling the first spoken line. Returns immediately and
    is safe to call at any time — an engine that is already up is a no-op,
    and a load that then fails is handled exactly as a cold /speak would be.
    """
    wanted = [req.engine] if req.engine else list(ENABLED_ENGINES)
    unknown = [e for e in wanted if e not in WORKERS]
    if unknown:
        raise HTTPException(400, f"unknown engine: {unknown[0]}")
    # A name this image knows but TTS_HEAVY_ENGINES did not ask for has no
    # worker to wake. Reported rather than just missing from `warming`, where
    # it read identically to "already warm" — the one answer an operator
    # checking why their engine never comes back must not be given.
    disabled = [e for e in wanted if e not in ENABLED_ENGINES]
    warming = [e for e in wanted if e in ENABLED_ENGINES and WORKERS[e].warm()]
    return {
        "ok": True,
        # Engines this call actually started loading (already-warm ones are
        # absent, which is the answer to "did I need to do this?").
        "warming": warming,
        # Named, known, but not enabled in this container — nothing to warm,
        # and not an error.
        "disabled": disabled,
        # Residency right now, the same thing /health's *_loaded booleans say.
        # Deliberately NOT called `engines`: on /health that key means
        # ROUTABLE and includes a cold engine, and one name answering two
        # questions is how a caller ends up reading the wrong one.
        "loaded": [e for e in ENABLED_ENGINES if WORKERS[e].ready],
        "cold": [e for e in ENABLED_ENGINES if WORKERS[e].cold],
    }
