"""
subwave-analyzer — acoustic-analysis sidecar for SUB/WAVE.

A thin FastAPI shim over a bounded pool of long-lived subprocesses: the SAME
stdio worker the controller runs in-process
(controller/scripts/analyze_worker.py), speaking one
JSON object per line ({"ready": true} once loaded, then one response per
request). run() supervises it — start → wait-for-exit → respawn — so a crash
(OOM, fatal model error) recovers without bouncing the container. No audio
over the wire: the worker reads tracks from a stream URL or a path on the
shared /var/sub-wave volume.

Endpoints:
  GET  /health   → {ok, engines, analyze_loaded, analyze_audio_capable, analyze_vocal_capable}
  POST /analyze  → {ok, bpm, key, intro_ms, confidence, ...}
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

ANALYZE_PYTHON = os.environ.get("ANALYZE_PYTHON", "/opt/analyzer/venv/bin/python")
ANALYZE_WORKER = os.environ.get("ANALYZE_WORKER", "/app/workers/analyze_worker.py")
# 40s is enough for stable BPM/key; keep in sync with analyze_worker.py and
# controller config.ts. Compose forwards ${ANALYZE_SECONDS:-} (empty = unset).
ANALYZE_SECONDS = os.environ.get("ANALYZE_SECONDS", "").strip() or "40"
# Only touched when CLAP is enabled without a local CLAP_MODEL_PATH; compose
# mounts a named volume over it so the weight download survives recreates.
ANALYZER_HF_HOME = os.environ.get("ANALYZER_HF_HOME", "/opt/analyzer/hf-cache")


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logging.getLogger("analyzer").warning(
            f"{name}={raw!r} is not a whole number; using {default}"
        )
        return default
    if value < minimum or value > maximum:
        logging.getLogger("analyzer").warning(
            f"{name}={raw!r} must be between {minimum} and {maximum}; using {default}"
        )
        return default
    return value


ANALYZE_CONCURRENCY = _bounded_int_env("ANALYZE_CONCURRENCY", 1, 1, 8)

# Idle worker recycle (#1204 follow-up). The worker's own idle release drops
# the CLAP/Demucs singletons, but ~1GB of librosa/numba/torch scratch stays
# resident — restarting the worker is the only full reclaim. After this many
# seconds with no HEAVY use (lean bpm/key traffic doesn't count, same clock as
# the worker's release) the shim terminates it and run() respawns. Default
# sits above the worker's largest release window so the cheap release always
# fires first; 0 disables.
_RECYCLE_ENV = os.environ.get("ANALYZE_RECYCLE_IDLE_S", "").strip()
try:
    RECYCLE_IDLE_S = float(_RECYCLE_ENV) if _RECYCLE_ENV else 3600.0
except ValueError:
    logging.getLogger("analyzer").warning(
        f"ANALYZE_RECYCLE_IDLE_S={_RECYCLE_ENV!r} is not a number; using 3600"
    )
    RECYCLE_IDLE_S = 3600.0

# Mirror of the worker's env-default flags (same truthy set) — with either on,
# the worker loads models even for requests that don't ask, so every /analyze
# counts as heavy use.
def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


EMBED_DEFAULT = _env_flag("ANALYZE_AUDIO_EMBEDDING")
VOCAL_DEFAULT = _env_flag("ANALYZE_VOCAL_ACTIVITY")

# Max bytes of one worker stdout line. asyncio's default 64 KiB StreamReader
# limit is blown by a batch /embed-text response (~150 KB on one line) —
# readline() then raises LimitOverrunError and the endpoint 500s (#996).
WORKER_STDOUT_LIMIT = 16 * 1024 * 1024

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("analyzer")


class WorkerUnavailableError(RuntimeError):
    """A selected worker became unusable before accepting the request."""


class StdioWorker:
    """Async wrapper around a long-lived stdio worker subprocess.

    No multiplexing — one request in flight, gated by a lock. run() drives the
    lifecycle from the FastAPI lifespan.
    """

    START_BACKOFF_S = 5.0
    RUN_BACKOFF_S = 2.0

    def __init__(self, name: str, python: str, script: str, env_extra: dict[str, str] | None = None):
        self.name = name
        self.python = python
        self.script = script
        self.env_extra = env_extra or {}
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.ready = False
        self._reserved = False
        self._recycling = False
        self._state_listener: Callable[[], Awaitable[None]] | None = None
        # Ready message minus the `ready` flag — per-engine capability
        # metadata. Cleared on every restart cycle.
        self.ready_meta: dict[str, Any] = {}
        # Heavy-use bookkeeping for /health residency + the idle recycle.
        # last_heavy = monotonic time of the last completed model-using
        # request (None = none since this spawn); models_resident is
        # best-effort — set on a heavy completion, cleared when the worker's
        # idle-release log line goes by (_pump_stderr) or the worker restarts.
        self.last_heavy: float | None = None
        self.models_resident = False
        self.recycles = 0
        # Capabilities the worker advertised at ready but LOST when the model
        # was actually asked to load — {"audio_embedding": "<why>"}, harvested
        # from every response (analyze_worker.capability_loss). Deliberately
        # NOT cleared by _reset(): the worker's own latch dies with the
        # process, and recycle_loop respawns that process every idle hour, so
        # an in-worker-only latch would reset itself and the controller would
        # re-widen its backfill to the same doomed tracks forever (#1300 bug
        # 3). Cleared only by restarting THIS container — which is also the
        # operator's retry after fixing the cause.
        self.capability_errors: dict[str, str] = {}

    def set_state_listener(self, listener: Callable[[], Awaitable[None]]) -> None:
        self._state_listener = listener

    async def _state_changed(self) -> None:
        if self._state_listener is not None:
            await self._state_listener()

    async def _set_ready(self, ready: bool) -> None:
        if self.ready == ready:
            return
        self.ready = ready
        await self._state_changed()

    async def _set_recycling(self, recycling: bool) -> None:
        if self._recycling == recycling:
            return
        self._recycling = recycling
        await self._state_changed()

    @property
    def available(self) -> bool:
        return self.ready and not self._recycling

    @property
    def recycling(self) -> bool:
        """This worker is mid-recycle: unselectable now, but coming back.

        recycle_loop's `finally` always clears the claim (bounded by its own
        180s respawn deadline), so a pool waiter blocked on this flag is
        guaranteed to be woken — see AnalyzerWorkerPool._acquire_worker.
        """
        return self._recycling

    def reserve_if_available(self) -> bool:
        # No await: selection and recycle's `_recycling = True` transition are
        # atomic relative to one another on the asyncio event loop.
        if not self.available or self._reserved:
            return False
        self._reserved = True
        return True

    def release_reservation(self) -> None:
        self._reserved = False

    async def run(self) -> None:
        """Keep the worker alive forever (or until cancelled)."""
        try:
            while True:
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    await self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                assert self.proc is not None
                code = await self.proc.wait()
                log.warning(
                    f"[{self.name}] worker exited with code={code}; restarting in {self.RUN_BACKOFF_S}s",
                )
                await self._reset()
                await asyncio.sleep(self.RUN_BACKOFF_S)
        except asyncio.CancelledError:
            await self._set_ready(False)
            self._terminate()
            raise

    async def _reset(self) -> None:
        await self._set_ready(False)
        self.proc = None
        self.ready_meta = {}
        # A fresh worker holds no models; clearing last_heavy also stands the
        # recycle loop down until the next heavy request.
        self.last_heavy = None
        self.models_resident = False

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

        # Read until {"ready": true}. A first-time CLAP/Demucs load (lazy
        # weight download) can take a while, so no timeout — run()'s restart
        # loop is the upstream safety net.
        try:
            msg = await self._await_message()
            if msg.get("fatal"):
                raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
            if not msg.get("ready"):
                raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        except Exception:
            self._terminate()
            raise
        self.ready_meta = {k: v for k, v in msg.items() if k != "ready"}
        # A pre-warm (env-enabled) model load fails BEFORE ready, so the ready
        # line itself can already carry a loss.
        self._note_capability_loss(msg)
        log.info(f"[{self.name}] ready {self.ready_meta or ''}".rstrip())
        # With an env flag on, the worker pre-warms that model BEFORE ready —
        # count it as resident (and heavy use, so the recycle clock runs)
        # unless the capability probe says the load failed.
        if (EMBED_DEFAULT and self.ready_meta.get("audio_embedding_capable")) or (
            VOCAL_DEFAULT and self.ready_meta.get("vocal_activity_capable")
        ):
            self.models_resident = True
            self.last_heavy = time.monotonic()
        await self._set_ready(True)

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
            text = line.decode().rstrip()
            log.info(f"[{self.name}] {text}")
            # The worker announces its idle release on stderr (wording pinned
            # by a keep-in-sync note at analyze_worker._release_models).
            # Unsolicited stdout would corrupt the one-request-in-flight
            # protocol, so stderr is the only channel — best-effort by design.
            if "released" in text and "reloads on next use" in text:
                self.models_resident = False

    def _note_capability_loss(self, msg: dict[str, Any]) -> None:
        """Record a capability the worker just reported it can no longer do.

        First observation per capability is logged at WARNING — a load failure
        that only ever showed up as a missing field in an ok=true response is
        precisely how this went unnoticed for so long.
        """
        lost = msg.get("capability_loss")
        if not isinstance(lost, dict):
            return
        for name, why in lost.items():
            reason = str(why)[:400]
            if self.capability_errors.get(name) == reason:
                continue
            self.capability_errors[name] = reason
            log.warning(f"[{self.name}] {name} unavailable: {reason}")

    def capability(self, meta_key: str, loss_key: str) -> bool | None:
        """Advertised capability, corrected by anything observed since.

        `ready_meta` answers the question the worker could answer BEFORE
        loading anything ("are the libraries installed"); an observed load
        failure answers the one that matters ("can it actually produce this").
        The observation wins, and only ever downward — a capability the worker
        never claimed stays unclaimed."""
        if not self.ready:
            return None
        if loss_key in self.capability_errors:
            return False
        value = self.ready_meta.get(meta_key)
        return value if isinstance(value, bool) else None

    @staticmethod
    def _wants_models(payload: dict[str, Any]) -> bool:
        """Whether this request can load/use CLAP or Demucs. Texts always force
        CLAP; a render_transition mixes already-cached stems (no model); an
        analyze counts when it opts in per-request OR the worker's env default
        flags opt every request in."""
        if payload.get("texts") is not None:
            return True
        if payload.get("op"):
            return False
        return bool(
            payload.get("embed") or payload.get("vocal") or payload.get("stems_dir")
            or EMBED_DEFAULT or VOCAL_DEFAULT
        )

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            # Fail fast when the worker is down — the controller's client
            # falls through cleanly (analysis row stays NULL), preferable to
            # blocking on an unhealthy worker.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                await self._set_ready(False)
                raise WorkerUnavailableError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            msg = await self._await_message()
            self._note_capability_loss(msg)
            # Stamp heavy use from what actually came back, not what was
            # asked: an analyze whose CLAP load failed still answers ok=true
            # (graceful degrade) but carries no model-derived fields, and must
            # not read as "models resident".
            if self._wants_models(payload) and (
                (payload.get("texts") is not None and msg.get("ok"))
                or any(k in msg for k in ("audio_embedding", "vocal_ranges", "stems_cached"))
            ):
                self.last_heavy = time.monotonic()
                self.models_resident = True
            return msg

    async def recycle_loop(self, idle_s: float) -> None:
        """Terminate the worker after `idle_s` seconds without heavy use so
        run() respawns it fresh — the full-memory counterpart to the worker's
        own model release. A pool reservation wins over recycling; once recycle
        claims the worker, new requests route to another available member — or,
        when this IS the only member (the ANALYZE_CONCURRENCY=1 default), queue
        in _acquire_worker until the respawn re-readies it. Either way a racing
        request runs against the new worker instead of 500ing, which is what
        holding the request lock across the respawn used to buy."""
        while True:
            await asyncio.sleep(60)
            if not self.ready or self.last_heavy is None:
                continue
            if time.monotonic() - self.last_heavy < idle_s:
                continue
            # A pool reservation is made without yielding, as is this recycling
            # claim. Whichever happens first wins: admitted work completes on
            # this worker, or the pool sees it as unavailable and picks another.
            if self._reserved:
                continue
            await self._set_recycling(True)
            try:
                async with self.lock:
                    # Re-check under the lock: a heavy request may have completed
                    # while we waited to acquire it.
                    if self.last_heavy is None or time.monotonic() - self.last_heavy < idle_s:
                        continue
                    log.info(
                        f"[{self.name}] idle {int(idle_s)}s without heavy use — recycling worker "
                        "for a full memory reclaim (re-pays imports on next request)"
                    )
                    self.recycles += 1
                    await self._set_ready(False)
                    self._terminate()
                    # Wait (bounded) for run() to respawn and re-ready before
                    # releasing the lock. The pool routes new requests to other
                    # available members during this window.
                    deadline = time.monotonic() + 180.0
                    while time.monotonic() < deadline and not self.ready:
                        await asyncio.sleep(0.5)
                    if not self.ready:
                        log.warning(f"[{self.name}] worker not back within 180s of recycle")
            finally:
                await self._set_recycling(False)


class AnalyzerWorkerPool:
    """Facade over independent single-flight stdio workers."""

    def __init__(self, workers: list[StdioWorker]):
        self.workers = workers
        self._available = asyncio.Condition()
        self._busy: set[StdioWorker] = set()
        self._next = 0
        for worker in self.workers:
            worker.set_state_listener(self._worker_state_changed)

    async def _worker_state_changed(self) -> None:
        async with self._available:
            self._available.notify_all()

    @property
    def ready_workers(self) -> list[StdioWorker]:
        return [worker for worker in self.workers if worker.available]

    @property
    def ready(self) -> bool:
        return bool(self.ready_workers)

    @property
    def recycling(self) -> bool:
        return any(worker.recycling for worker in self.workers)

    def capability(self, meta_key: str, loss_key: str) -> bool | None:
        # Aggregate across the SELECTABLE members only. A booting, crashed or
        # recycling member has no opinion — reading it would report `None` for
        # the whole pool every time one member cycles, and the controller's
        # tail-vocal backfill (which requires === true) would read a healthy
        # heavy pool as a stale analyzer image.
        #
        # A capability is `False` only when EVERY selectable member has lost it
        # — that is the lean-image case, where they all share one build. One
        # member latching a load failure (capability_errors survives its own
        # respawn by design) leaves the pool `None`: some member can still serve
        # it, so `True` would be a lie, and `False` would switch the feature off
        # station-wide over one worker's bad hour.
        ready = self.ready_workers
        if not ready:
            return None
        values = [worker.capability(meta_key, loss_key) for worker in ready]
        if all(value is True for value in values):
            return True
        if all(value is False for value in values):
            return False
        return None

    def capability_error(self, loss_key: str) -> str | None:
        # Selectable members only, matching capability() — a long-dead member's
        # latched reason is not why the pool is degraded now.
        errors = [
            worker.capability_errors[loss_key]
            for worker in self.ready_workers
            if loss_key in worker.capability_errors
        ]
        return errors[0] if errors else None

    async def _acquire_worker(self) -> StdioWorker:
        """Reserve one selectable member, waiting while the pool can recover.

        Three states, and the difference between the last two is load-bearing.
        A member is free → take it. Every member is busy → wait. NO member is
        selectable → it depends on why: a member that is merely RECYCLING is
        being respawned and will re-ready (or time out) within recycle_loop's
        own 180s budget, and its `finally` always clears the claim, so waiting
        here is bounded and the request is served by the fresh worker. This is
        what the single worker's request lock used to do implicitly — it was
        held across the respawn precisely so a racing request queued and then
        ran against the new worker instead of 500ing, and at the default
        ANALYZE_CONCURRENCY=1 that recycle window is the whole pool.

        Nothing ready and nothing recycling is the boot/crash case, where
        blocking would help no one: fail fast so the controller falls through
        cleanly (the analysis row stays NULL and is retried next pass).
        """
        async with self._available:
            while True:
                count = len(self.workers)
                for offset in range(count):
                    index = (self._next + offset) % count
                    worker = self.workers[index]
                    if worker not in self._busy and worker.reserve_if_available():
                        self._busy.add(worker)
                        self._next = (index + 1) % count
                        return worker
                if not self.ready and not self.recycling:
                    raise WorkerUnavailableError("[analyze] no worker ready")
                await self._available.wait()

    async def _release_worker(self, worker: StdioWorker) -> None:
        async with self._available:
            worker.release_reservation()
            self._busy.discard(worker)
            self._available.notify_all()

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        while True:
            worker: StdioWorker | None = None
            try:
                worker = await self._acquire_worker()
                return await worker.request(payload)
            except WorkerUnavailableError:
                # Selection itself failing (worker is still None) is the pool's
                # considered verdict that nothing is ready and nothing is coming
                # back — retrying would spin on the same answer, so it rides out
                # to the caller as the single worker's "not ready" always did.
                if worker is None:
                    raise
                # Past selection, readiness can still change before the worker
                # lock (notably when recycle wins that race). Release the stale
                # reservation and pick another member instead of failing a
                # request the pool can still serve.
            finally:
                if worker is not None:
                    await self._release_worker(worker)


analyzer_workers = [
    StdioWorker(
        name=f"analyze-{index + 1}",
        python=ANALYZE_PYTHON,
        script=ANALYZE_WORKER,
        env_extra={"ANALYZE_SECONDS": ANALYZE_SECONDS, "HF_HOME": ANALYZER_HF_HOME},
    )
    for index in range(ANALYZE_CONCURRENCY)
]
analyzer_pool = AnalyzerWorkerPool(analyzer_workers)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background task so uvicorn binds :8080 immediately — a cold CLAP/Demucs
    # load would otherwise block the bind and the controller's probe would see
    # "connection refused" during boot.
    tasks = []
    for index, worker in enumerate(analyzer_workers, start=1):
        tasks.append(asyncio.create_task(worker.run(), name=f"analyze-run-{index}"))
        if RECYCLE_IDLE_S > 0:
            tasks.append(
                asyncio.create_task(
                    worker.recycle_loop(RECYCLE_IDLE_S), name=f"analyze-recycle-{index}"
                )
            )
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="subwave-analyzer", lifespan=lifespan)


@app.get("/health")
async def health():
    # `engines` lists engines *currently ready*, not the static set — the
    # controller's probe (analyzer.ts:sidecarReachable) keys readiness on
    # `engines.includes("analyze")`, so advertising it while booting/crashed
    # would cause failed /analyze calls instead of a clean fall-through.
    ready = analyzer_pool.ready_workers
    ready_engines: list[str] = ["analyze"] if ready else []
    heavy_times = [worker.last_heavy for worker in ready if worker.last_heavy is not None]
    return {
        "ok": True,
        "engines": ready_engines,
        "analyze_loaded": bool(ready),
        # CLAP "sounds-like" capability (WITH_CLAP=1 builds only) — the admin
        # UI warns to rebuild before a fruitless run. None until ready. Reads
        # through capability(), so a model that failed to LOAD reports false
        # here rather than the ready line's install-time guess.
        "analyze_audio_capable": analyzer_pool.capability(
            "audio_embedding_capable", "audio_embedding"
        ),
        # Demucs vocal-activity capability (WITH_DEMUCS=1). None until ready.
        "analyze_vocal_capable": analyzer_pool.capability(
            "vocal_activity_capable", "vocal_activity"
        ),
        # WHY a capability is false, when the reason is a failed load rather
        # than a lean build (null in every other case). The distinction is the
        # actionable part: "rebuild with the heavy image" and "give this host
        # reach to huggingface.co" are opposite instructions, and a bare false
        # can't tell them apart.
        "analyze_audio_error": analyzer_pool.capability_error("audio_embedding"),
        "analyze_vocal_error": analyzer_pool.capability_error("vocal_activity"),
        # Tail vocal ranges — a worker-version signal as much as a capability:
        # workers predating the feature never emit the key, so this stays None
        # on stale images and the controller's backfill widening (which
        # requires === true) can't churn against them. Demucs failing to load
        # takes the tail down with it — same model, same separation.
        "analyze_tail_vocal_capable": analyzer_pool.capability(
            "tail_vocal_capable", "vocal_activity"
        ),
        # CLAP text tower (same 512-d space as the audio vectors) — powers
        # "sounds like ..." search and zero-shot moods. Needs torch, so lean
        # images report false. Shares CLAP's load, so it shares its failure.
        "analyze_text_capable": analyzer_pool.capability(
            "text_embedding_capable", "audio_embedding"
        ),
        # Best-effort residency (#1204): whether CLAP/Demucs are believed
        # loaded right now — lets an operator confirm the idle release
        # without grepping logs. None while the worker is down.
        "analyze_models_resident": (
            all(worker.models_resident for worker in ready) if ready else None
        ),
        # Conservative pool aggregate: seconds since the most recently completed
        # heavy request on any ready member (null when none has run).
        "analyze_heavy_idle_s": (
            round(time.monotonic() - max(heavy_times), 1) if heavy_times else None
        ),
        "analyze_worker_recycles": sum(worker.recycles for worker in analyzer_workers),
    }


class AnalyzeRequest(BaseModel):
    # Remote stream url, or a local path on the shared volume the controller
    # pre-fetched into (overlaps network I/O with the sidecar's compute).
    url: str | None = None
    path: str | None = None
    # Per-request CLAP opt-in (the admin toggle); None keeps the worker's
    # env-driven default.
    embed: bool | None = None
    # Same, for Demucs vocal-activity ranges.
    vocal: bool | None = None
    # Whether `path` holds the COMPLETE file. False vetoes outro analysis (a
    # truncated file's "tail" is mid-song audio); None = unknown, the worker's
    # decode-length check guards.
    complete: bool | None = None
    # Stem-cache target dir (stem-blend transitions). When set, the worker
    # persists the Demucs stems it already computes as FLAC into this dir —
    # implies the separation pass even when `vocal` wasn't requested.
    stems_dir: str | None = None
    # CLAP backfill for a track whose baseline analysis is already current.
    # Skips every non-embedding feature in the worker.
    embedding_only: bool = False


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if req.path:
        # A controller can reach this sidecar over HTTP without sharing its
        # state mount. Name that boundary failure before handing it to the
        # worker, so the controller can retry by URL without also retrying
        # genuine decode/model failures.
        if not os.path.isfile(req.path) or not os.access(req.path, os.R_OK):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "path_unavailable",
                    "message": f"analyzer cannot read controller path: {req.path}",
                },
            )
        payload: dict[str, Any] = {"id": "1", "path": req.path}
    elif req.url:
        payload = {"id": "1", "url": req.url}
    else:
        raise HTTPException(400, "missing 'url' or 'path'")
    if req.embed is not None:
        payload["embed"] = req.embed
    if req.vocal is not None:
        payload["vocal"] = req.vocal
    if req.complete is not None:
        payload["complete"] = req.complete
    if req.stems_dir is not None:
        payload["stems_dir"] = req.stems_dir
    if req.embedding_only:
        payload["embedding_only"] = True
    msg = await analyzer_pool.request(payload)
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "analyze failed")
    out: dict[str, Any] = {
        "ok": True,
        "bpm": msg.get("bpm"),
        "key": msg.get("key"),
        "intro_ms": msg.get("intro_ms"),
        "confidence": msg.get("confidence"),
    }
    # Optional fields — passed through only when the worker computed them, so
    # the client maps omissions to null.
    for k in (
        "loudness_lufs", "peak_db", "sections", "vocal_ranges",
        "pace_curve", "beats", "bars", "key_ranges", "outro", "stems_cached",
        "lead_silence_ms", "tail_silence_ms", "tail_start_ms",
    ):
        if k in msg:
            out[k] = msg[k]
    if "audio_embedding" in msg:
        out["audio_embedding"] = msg["audio_embedding"]
    return out


class RenderTransitionRequest(BaseModel):
    # Stem-blend transition render. The controller supplies per-track
    # alignment data straight from library.db — the worker never re-detects.
    # Cache-hit-only: missing stems → ok=false.
    out: dict[str, Any]
    in_: dict[str, Any] = Field(alias="in")
    out_dir: str
    clip_name: str | None = None
    target_lufs: float | None = None

    model_config = {"populate_by_name": True}


@app.post("/render-transition")
async def render_transition(req: RenderTransitionRequest):
    """Mix a pre-rendered transition WAV from two tracks' cached stems onto
    the shared volume. Fast (a mix, not a separation) and bounded by the same
    pool, so an idle member can serve it without waiting behind every bulk job."""
    payload: dict[str, Any] = {
        "id": "1",
        "op": "render_transition",
        "out": req.out,
        "in": req.in_,
        "out_dir": req.out_dir,
    }
    if req.clip_name is not None:
        payload["clip_name"] = req.clip_name
    if req.target_lufs is not None:
        payload["target_lufs"] = req.target_lufs
    msg = await analyzer_pool.request(payload)
    if not msg.get("ok"):
        # A clean miss (stems absent, degenerate grids) is an expected
        # outcome, not a server fault — pass the reason through as 200 so the
        # controller can distinguish fallback from failure.
        return {"ok": False, "error": msg.get("error") or "render failed"}
    return {
        "ok": True,
        "path": msg.get("path"),
        "blend_start_sec": msg.get("blend_start_sec"),
        "in_cue_sec": msg.get("in_cue_sec"),
        "clip_sec": msg.get("clip_sec"),
    }


class EmbedTextRequest(BaseModel):
    # 1-64 non-empty strings (the worker enforces the same envelope). One
    # request = one worker round-trip, so mood-vocabulary batches go in one call.
    texts: list[str]


@app.post("/embed-text")
async def embed_text(req: EmbedTextRequest):
    """CLAP text-tower embeddings — 512-d vectors in the SAME space as the
    audio vectors ("sounds like ..." search, zero-shot mood scoring). 500s
    cleanly on a lean build (no torch); the controller treats any failure as
    "text embedding unavailable"."""
    if not req.texts:
        raise HTTPException(400, "missing 'texts'")
    msg = await analyzer_pool.request({"id": "1", "texts": req.texts})
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "embed-text failed")
    return {"ok": True, "embeddings": msg.get("text_embeddings") or []}
