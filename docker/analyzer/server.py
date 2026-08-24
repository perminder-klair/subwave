"""
subwave-analyzer — acoustic-analysis sidecar for SUB/WAVE.

A thin FastAPI shim over one long-lived subprocess: the SAME stdio worker the
controller runs in-process (controller/scripts/analyze_worker.py), speaking one
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
from typing import Any

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

    async def run(self) -> None:
        """Keep the worker alive forever (or until cancelled)."""
        try:
            while True:
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                assert self.proc is not None
                code = await self.proc.wait()
                log.warning(
                    f"[{self.name}] worker exited with code={code}; restarting in {self.RUN_BACKOFF_S}s",
                )
                self._reset()
                await asyncio.sleep(self.RUN_BACKOFF_S)
        except asyncio.CancelledError:
            self._terminate()
            raise

    def _reset(self) -> None:
        self.ready = False
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
                raise RuntimeError(f"[{self.name}] worker not ready")
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
        own model release. Holding the lock across the respawn means a racing
        request queues and then runs against the new worker instead of 500ing."""
        while True:
            await asyncio.sleep(60)
            if not self.ready or self.last_heavy is None:
                continue
            if time.monotonic() - self.last_heavy < idle_s:
                continue
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
                self.ready = False
                self._terminate()
                # Wait (bounded) for run() to respawn and re-ready before
                # releasing the lock. On timeout, release anyway — queued
                # requests then fail fast as for a crashed worker, and run()
                # keeps retrying upstream.
                deadline = time.monotonic() + 180.0
                while time.monotonic() < deadline and not self.ready:
                    await asyncio.sleep(0.5)
                if not self.ready:
                    log.warning(f"[{self.name}] worker not back within 180s of recycle")


analyzer_worker = StdioWorker(
    name="analyze",
    python=ANALYZE_PYTHON,
    script=ANALYZE_WORKER,
    env_extra={"ANALYZE_SECONDS": ANALYZE_SECONDS, "HF_HOME": ANALYZER_HF_HOME},
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Background task so uvicorn binds :8080 immediately — a cold CLAP/Demucs
    # load would otherwise block the bind and the controller's probe would see
    # "connection refused" during boot.
    tasks = [asyncio.create_task(analyzer_worker.run(), name="analyze-run")]
    if RECYCLE_IDLE_S > 0:
        tasks.append(
            asyncio.create_task(
                analyzer_worker.recycle_loop(RECYCLE_IDLE_S), name="analyze-recycle"
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
    ready_engines: list[str] = []
    if analyzer_worker.ready:
        ready_engines.append("analyze")
    return {
        "ok": True,
        "engines": ready_engines,
        "analyze_loaded": analyzer_worker.ready,
        # CLAP "sounds-like" capability (WITH_CLAP=1 builds only) — the admin
        # UI warns to rebuild before a fruitless run. None until ready. Reads
        # through capability(), so a model that failed to LOAD reports false
        # here rather than the ready line's install-time guess.
        "analyze_audio_capable": analyzer_worker.capability(
            "audio_embedding_capable", "audio_embedding"
        ),
        # Demucs vocal-activity capability (WITH_DEMUCS=1). None until ready.
        "analyze_vocal_capable": analyzer_worker.capability(
            "vocal_activity_capable", "vocal_activity"
        ),
        # WHY a capability is false, when the reason is a failed load rather
        # than a lean build (null in every other case). The distinction is the
        # actionable part: "rebuild with the heavy image" and "give this host
        # reach to huggingface.co" are opposite instructions, and a bare false
        # can't tell them apart.
        "analyze_audio_error": analyzer_worker.capability_errors.get("audio_embedding"),
        "analyze_vocal_error": analyzer_worker.capability_errors.get("vocal_activity"),
        # Tail vocal ranges — a worker-version signal as much as a capability:
        # workers predating the feature never emit the key, so this stays None
        # on stale images and the controller's backfill widening (which
        # requires === true) can't churn against them. Demucs failing to load
        # takes the tail down with it — same model, same separation.
        "analyze_tail_vocal_capable": analyzer_worker.capability(
            "tail_vocal_capable", "vocal_activity"
        ),
        # CLAP text tower (same 512-d space as the audio vectors) — powers
        # "sounds like ..." search and zero-shot moods. Needs torch, so lean
        # images report false. Shares CLAP's load, so it shares its failure.
        "analyze_text_capable": analyzer_worker.capability(
            "text_embedding_capable", "audio_embedding"
        ),
        # Best-effort residency (#1204): whether CLAP/Demucs are believed
        # loaded right now — lets an operator confirm the idle release
        # without grepping logs. None while the worker is down.
        "analyze_models_resident": analyzer_worker.models_resident if analyzer_worker.ready else None,
        # Seconds since the last completed heavy request against THIS worker
        # process; null when none has run since it spawned.
        "analyze_heavy_idle_s": (
            round(time.monotonic() - analyzer_worker.last_heavy, 1)
            if analyzer_worker.ready and analyzer_worker.last_heavy is not None
            else None
        ),
        "analyze_worker_recycles": analyzer_worker.recycles,
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
    msg = await analyzer_worker.request(payload)
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
    the shared volume. Fast (a mix, not a separation) but still serialized
    behind the single worker lock — the controller's render deadline handles
    a render stuck behind a bulk analyze item."""
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
    msg = await analyzer_worker.request(payload)
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
    msg = await analyzer_worker.request({"id": "1", "texts": req.texts})
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "embed-text failed")
    return {"ok": True, "embeddings": msg.get("text_embeddings") or []}
