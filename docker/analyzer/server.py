"""
subwave-analyzer — optional acoustic-analysis sidecar for SUB/WAVE.

Split out of docker/tts-heavy/server.py so operators who only want acoustic
analysis (bpm / key / intro / loudness, plus optional CLAP "sounds-like"
embeddings and Demucs vocal-activity ranges) don't have to pull the ~6GB
Chatterbox + PocketTTS image. The wire contract is identical to tts-heavy's
/health + /analyze, so the controller's analyzer client
(controller/src/music/analyzer.ts) treats the two interchangeably — it probes
ANALYZE_URL first, then TTS_HEAVY_URL, and uses whichever reports the 'analyze'
engine. No audio over the wire — only metadata; the worker reads tracks from a
stream URL or a path on the shared /var/sub-wave volume.

Architecture: a thin FastAPI shim over one long-lived Python subprocess — the
SAME stdio worker the controller + tts-heavy use
(controller/scripts/analyze_worker.py), running in the librosa venv at
/opt/analyzer/venv. The worker speaks one JSON object per line over stdin/stdout
(emits {"ready": true} once loaded, then one response per request line). run()
supervises it: start → wait-for-exit → respawn, so a crash (OOM, fatal model
error) recovers without bouncing the container.

Endpoints:
  GET  /health   → {ok, engines, analyze_loaded, analyze_audio_capable, analyze_vocal_capable}
  POST /analyze  → {ok, bpm, key, intro_ms, confidence, ...}
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Acoustic analysis (bpm/key/intro) — its own librosa venv, driven by the same
# stdio worker the offline CLI uses (controller/scripts/analyze_worker.py).
ANALYZE_PYTHON = os.environ.get("ANALYZE_PYTHON", "/opt/analyzer/venv/bin/python")
ANALYZE_WORKER = os.environ.get("ANALYZE_WORKER", "/app/workers/analyze_worker.py")
# 40s is enough for stable BPM (beat_track) / key (chroma); intro detection only
# needs the first ~20-30s. Env-overridable (empty = unset — compose forwards
# this as ${ANALYZE_SECONDS:-}); Demucs cost scales linearly with the window.
# Keep in sync with analyze_worker.py and controller config.ts.
ANALYZE_SECONDS = os.environ.get("ANALYZE_SECONDS", "").strip() or "40"
# The analyzer only touches HF when CLAP embeddings are enabled
# (ANALYZE_AUDIO_EMBEDDING=1 with a WITH_CLAP=1 image) and no local
# CLAP_MODEL_PATH is given — transformers then pulls the CLAP weights here. The
# compose files mount a named volume over it so the download survives recreates.
ANALYZER_HF_HOME = os.environ.get("ANALYZER_HF_HOME", "/opt/analyzer/hf-cache")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("analyzer")


class StdioWorker:
    """Async wrapper around a long-lived stdio worker subprocess.

    The worker speaks one JSON object per line over stdin/stdout — the same
    protocol used by controller/src/music/analyzer.ts and docker/tts-heavy.
    We don't multiplex: one request in flight, gated by a lock.

    Lifecycle is supervised by run() — a long-running coroutine kicked off from
    the FastAPI lifespan as a background task. run() loops on
    start → wait-for-exit → respawn with a short backoff, so a worker that
    crashes mid-session (OOM, fatal model error) comes back without anyone
    bouncing the container.
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
        # The worker's ready message, minus the `ready` flag — carries per-engine
        # capability metadata (audio_embedding_capable / vocal_activity_capable).
        # Cleared on every restart cycle.
        self.ready_meta: dict[str, Any] = {}

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
        )
        # Pump stderr to our log so the operator sees model load progress / fatal
        # errors in the container logs. The task exits when the worker closes
        # stderr on death.
        asyncio.create_task(self._pump_stderr())

        # Read until {"ready": true}. Loading CLAP/Demucs the first time can take
        # a while (lazy weight download), so no timeout here — run()'s restart
        # loop is the upstream safety net if a load hangs forever. Non-JSON noise
        # on stdout from transitive deps is skipped (see _await_message).
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
        log.info(f"[{self.name}] ready {self.ready_meta or ''}".rstrip())
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
            log.info(f"[{self.name}] {line.decode().rstrip()}")

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            # Fail fast if the worker isn't up — the /analyze handler turns this
            # into an HTTP error and the controller's client falls through
            # cleanly (analysis row stays NULL), preferable to blocking on an
            # unhealthy worker.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                raise RuntimeError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            return await self._await_message()


analyzer_worker = StdioWorker(
    name="analyze",
    python=ANALYZE_PYTHON,
    script=ANALYZE_WORKER,
    env_extra={"ANALYZE_SECONDS": ANALYZE_SECONDS, "HF_HOME": ANALYZER_HF_HOME},
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Kick the worker supervisor as a background task so uvicorn binds :8080
    # immediately — otherwise a cold CLAP/Demucs load would block the port bind
    # and the controller's probe would see "connection refused" during boot.
    task = asyncio.create_task(analyzer_worker.run(), name="analyze-run")
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


app = FastAPI(title="subwave-analyzer", lifespan=lifespan)


@app.get("/health")
async def health():
    # `engines` is the list of engines *currently ready*, not the static set
    # this sidecar supports — the controller's probe
    # (analyzer.ts:sidecarReachable) uses `engines.includes("analyze")` as its
    # readiness signal, so advertising it while the worker is still booting (or
    # crashed) would cause failed /analyze calls instead of a clean fall-through.
    ready_engines: list[str] = []
    if analyzer_worker.ready:
        ready_engines.append("analyze")
    return {
        "ok": True,
        "engines": ready_engines,
        "analyze_loaded": analyzer_worker.ready,
        # Whether the worker can emit CLAP "sounds-like" audio embeddings — true
        # only when built WITH_CLAP=1. The controller surfaces this so the admin
        # UI warns to rebuild *before* a fruitless run. None until ready.
        "analyze_audio_capable": (
            analyzer_worker.ready_meta.get("audio_embedding_capable") if analyzer_worker.ready else None
        ),
        # Likewise for Demucs vocal-activity ranges — true only when built
        # WITH_DEMUCS=1. None until ready.
        "analyze_vocal_capable": (
            analyzer_worker.ready_meta.get("vocal_activity_capable") if analyzer_worker.ready else None
        ),
        # Whether the worker can embed TEXT through the CLAP text tower (same
        # 512-d space as the audio vectors) — powers "sounds like ..." search
        # and zero-shot mood scoring. Needs torch, so lean images report false.
        "analyze_text_capable": (
            analyzer_worker.ready_meta.get("text_embedding_capable") if analyzer_worker.ready else None
        ),
    }


class AnalyzeRequest(BaseModel):
    # Either a remote stream url (the worker downloads it) or a local path on the
    # shared /var/sub-wave volume the controller pre-fetched into. The
    # controller's prefetch pipeline sends `path` to overlap network I/O with the
    # sidecar's single-threaded compute; `url` stays as the fallback.
    url: str | None = None
    path: str | None = None
    # Per-request CLAP opt-in (the controller's admin toggle). True makes the
    # worker lazy-load CLAP even without ANALYZE_AUDIO_EMBEDDING in its env; None
    # keeps the worker's env-driven default.
    embed: bool | None = None
    # Same, for Demucs vocal-activity ranges (ANALYZE_VOCAL_ACTIVITY default).
    vocal: bool | None = None


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if req.path:
        payload: dict[str, Any] = {"id": "1", "path": req.path}
    elif req.url:
        payload = {"id": "1", "url": req.url}
    else:
        raise HTTPException(400, "missing 'url' or 'path'")
    if req.embed is not None:
        payload["embed"] = req.embed
    if req.vocal is not None:
        payload["vocal"] = req.vocal
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
    # Optional perceptual loudness + structural fields — present only when the
    # worker computed them. Pass through; omitted otherwise so the client maps
    # them to null.
    for k in (
        "loudness_lufs", "peak_db", "sections", "vocal_ranges",
        "pace_curve", "beats", "bars", "key_ranges",
    ):
        if k in msg:
            out[k] = msg[k]
    # Optional CLAP audio embedding — present only when the worker has the model
    # loaded (ANALYZE_AUDIO_EMBEDDING + CLAP weights). Omitted otherwise.
    if "audio_embedding" in msg:
        out["audio_embedding"] = msg["audio_embedding"]
    return out


class EmbedTextRequest(BaseModel):
    # 1-64 non-empty strings (the worker enforces the same envelope). One
    # request = one worker round-trip, so mood-vocabulary batches go in a
    # single call.
    texts: list[str]


@app.post("/embed-text")
async def embed_text(req: EmbedTextRequest):
    """CLAP text-tower embeddings — 512-d vectors in the SAME space as the
    audio vectors, so the controller can cosine them against stored track
    embeddings (natural-language "sounds like ..." search, zero-shot mood
    scoring). 500s cleanly on a lean build (no torch); the controller's client
    treats any failure as "text embedding unavailable"."""
    if not req.texts:
        raise HTTPException(400, "missing 'texts'")
    msg = await analyzer_worker.request({"id": "1", "texts": req.texts})
    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "embed-text failed")
    return {"ok": True, "embeddings": msg.get("text_embeddings") or []}
