"""
subwave-tts-heavy — optional Chatterbox + PocketTTS sidecar for SUB/WAVE.

The controller (controller/src/audio/chatterbox.ts, audio/pocketTts.ts) talks
to this service over HTTP when TTS_HEAVY_URL is set in its environment. The
shared /var/sub-wave volume is mounted in both containers, so the sidecar
writes the WAV to the absolute `out` path the controller asks for, and the
controller hands the same path to Liquidsoap via next.txt / say.txt /
intro.txt. No audio over the wire — only metadata.

Architecture: this is a thin FastAPI shim. The real inference happens in two
long-lived Python subprocesses — the SAME stdio worker scripts the controller
uses for its in-process build (controller/scripts/{chatterbox,pocket_tts}_
worker.py). Each runs in its own venv (/opt/chatterbox/venv,
/opt/pocket-tts/venv) because chatterbox-tts and pocket-tts have incompatible
pip resolutions in a single env. asyncio.Lock per worker serialises requests
so two simultaneous DJ lines don't interleave.

Endpoints:
  GET  /health   → {ok, engines, chatterbox_loaded, pocket_loaded}
  POST /speak    → {ok, path, duration_s}
    body: {engine, text, voice?, reference_wav?, out}
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

CHATTERBOX_PYTHON = os.environ.get("CHATTERBOX_PYTHON", "/opt/chatterbox/venv/bin/python")
CHATTERBOX_WORKER = os.environ.get("CHATTERBOX_WORKER", "/app/workers/chatterbox_worker.py")
POCKET_TTS_PYTHON = os.environ.get("POCKET_TTS_PYTHON", "/opt/pocket-tts/venv/bin/python")
POCKET_TTS_WORKER = os.environ.get("POCKET_TTS_WORKER", "/app/workers/pocket_tts_worker.py")
# Acoustic analysis (bpm/key/intro) — its own librosa venv, driven by the same
# stdio worker the offline CLI uses (controller/scripts/analyze_worker.py).
ANALYZE_PYTHON = os.environ.get("ANALYZE_PYTHON", "/opt/analyzer/venv/bin/python")
ANALYZE_WORKER = os.environ.get("ANALYZE_WORKER", "/app/workers/analyze_worker.py")
# 60s is enough for stable BPM (beat_track) / key (chroma); intro
# detection only needs the first ~20-30s. Env-overridable.
ANALYZE_SECONDS = os.environ.get("ANALYZE_SECONDS", "60")

DEVICE = os.environ.get("TTS_HEAVY_DEVICE", "cpu").lower()
POCKET_TTS_DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "alba")

# Per-worker HF cache homes so the two engines don't fight over the same
# directory. Each is a named volume in the compose files, so the weights a
# worker downloads on its first boot survive container recreates. The env vars
# below tell huggingface_hub where to look at runtime (and are passed into each
# worker's env via env_extra below).
CHATTERBOX_HF_HOME = os.environ.get("CHATTERBOX_HF_HOME", "/opt/chatterbox/hf-cache")
POCKET_HF_HOME = os.environ.get("POCKET_HF_HOME", "/opt/pocket-tts/hf-cache")
# The analyzer only touches HF when CLAP embeddings are enabled
# (ANALYZE_AUDIO_EMBEDDING=1 with a WITH_CLAP=1 image) and no local
# CLAP_MODEL_PATH is given — transformers then pulls the CLAP weights here.
ANALYZER_HF_HOME = os.environ.get("ANALYZER_HF_HOME", "/opt/analyzer/hf-cache")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
log = logging.getLogger("tts-heavy")


class TtsWorker:
    """Async wrapper around a long-lived stdio TTS worker subprocess.

    The worker scripts speak one JSON object per line over stdin/stdout —
    same protocol used by controller/src/audio/{chatterbox,pocketTts}.ts.
    We don't multiplex: one request in flight per worker, gated by a lock.

    Lifecycle is supervised by run() — a long-running coroutine kicked off
    from the FastAPI lifespan as a background task. run() loops on
    start → wait-for-exit → respawn with a short backoff, mirroring the
    auto-restart behaviour in the controller-side TS workers. This is what
    lets a worker that crashes mid-session (OOM, fatal model error) come
    back without anyone bouncing the container.
    """

    # Backoff between restart cycles. Short — we'd rather see the worker try
    # again quickly than babysit a long retry window. start_backoff applies
    # when start() itself fails (model load error, missing venv); run_backoff
    # applies when start() succeeded but the worker exited later.
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
        # The worker's ready message, minus the `ready` flag — carries
        # per-engine capability metadata (e.g. pocket-tts' voice_cloning,
        # issue #238). Cleared on every restart cycle.
        self.ready_meta: dict[str, Any] = {}

    async def run(self) -> None:
        """Keep the worker alive forever (or until cancelled).

        Cancellation comes from the lifespan teardown. We catch it once to
        terminate the running subprocess cleanly before bubbling up.
        """
        try:
            while True:
                try:
                    await self.start()
                except Exception as e:
                    log.error(f"[{self.name}] start failed: {e}")
                    self._reset()
                    await asyncio.sleep(self.START_BACKOFF_S)
                    continue
                # Worker is ready. Block until it exits, then respawn.
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
        """Clear ready/proc between restart cycles."""
        self.ready = False
        self.proc = None
        self.ready_meta = {}

    def _terminate(self) -> None:
        """Best-effort kill the current subprocess (used on shutdown)."""
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
        # Pump stderr to our log so the operator sees the worker's startup
        # output (model load progress, fatal errors, etc.) in tts-heavy's
        # docker logs. The task exits naturally when the worker closes stderr
        # on death, so there's one pump task per active subprocess.
        asyncio.create_task(self._pump_stderr())

        # Read until we see {"ready": true}. Workers emit some non-JSON noise
        # on stdout during model load — perth (chatterbox's watermarker) prints
        # "loaded PerthNet (Implicit) at step 250,000" via a bare print().
        # Mirror the controller's TS code (controller/src/audio/chatterbox.ts
        # handleMessage) and silently skip anything that doesn't parse — the
        # workers themselves only emit JSON for protocol messages. Chatterbox
        # can take 30+ seconds to instantiate ChatterboxTurboTTS even from a
        # warm cache, so no timeout here — run()'s restart loop is the
        # upstream safety net if a load hangs forever.
        try:
            msg = await self._await_message()
            if msg.get("fatal"):
                raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
            if not msg.get("ready"):
                raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        except Exception:
            # Failed to reach ready — terminate the half-booted process so
            # run() doesn't pile orphans up across retry cycles.
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
                # Almost certainly noise from a transitive dep (perth's
                # PerthNet load message, etc.). Log at info so it's visible
                # but don't fail the protocol.
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
            # Fail fast if the worker isn't currently up. The /speak handler
            # turns this into an HTTP error and the controller's dispatcher
            # falls back to Piper — preferable to blocking the HTTP request
            # while we wait for an unhealthy worker to come back.
            if not self.ready or not self.proc or self.proc.returncode is not None:
                raise RuntimeError(f"[{self.name}] worker not ready")
            assert self.proc.stdin
            req = json.dumps(payload, ensure_ascii=False)
            self.proc.stdin.write((req + "\n").encode())
            await self.proc.stdin.drain()
            # _await_message skips non-JSON stdout chatter — same fix as in
            # start(). Without it, any post-ready print() from the workers
            # would crash the next /speak call.
            return await self._await_message()


chatterbox_worker = TtsWorker(
    name="chatterbox",
    python=CHATTERBOX_PYTHON,
    script=CHATTERBOX_WORKER,
    env_extra={
        "CHATTERBOX_DEVICE": DEVICE,
        "CHATTERBOX_REFERENCE_WAV": os.environ.get("CHATTERBOX_REFERENCE_WAV", ""),
        "HF_HOME": CHATTERBOX_HF_HOME,
    },
)

pocket_worker = TtsWorker(
    name="pocket-tts",
    python=POCKET_TTS_PYTHON,
    script=POCKET_TTS_WORKER,
    env_extra={
        "POCKET_TTS_VOICE": POCKET_TTS_DEFAULT_VOICE,
        "HF_HOME": POCKET_HF_HOME,
    },
)

# Acoustic-analysis worker — same stdio protocol as the TTS workers (emits
# {"ready": true}, then one JSON response per request line), so it reuses
# TtsWorker. It fetches the track from the stream URL the controller sends and
# returns bpm/key/intro_ms.
analyzer_worker = TtsWorker(
    name="analyze",
    python=ANALYZE_PYTHON,
    script=ANALYZE_WORKER,
    env_extra={"ANALYZE_SECONDS": ANALYZE_SECONDS, "HF_HOME": ANALYZER_HF_HOME},
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Kick the worker supervisors as background tasks so uvicorn binds :8080
    # immediately. Without this, chatterbox's 30-60s cold load would block
    # the port bind and the controller's probe would see "connection refused"
    # for the entire boot — leading operators to think the sidecar is broken
    # when it's just still loading.
    tasks = [
        asyncio.create_task(chatterbox_worker.run(), name="chatterbox-run"),
        asyncio.create_task(pocket_worker.run(), name="pocket-tts-run"),
        asyncio.create_task(analyzer_worker.run(), name="analyze-run"),
    ]
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        # Give the supervisors a moment to terminate their subprocesses
        # cleanly before uvicorn exits. SIGKILL from the container stop is
        # the upstream fallback if any of this hangs.
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="subwave-tts-heavy", lifespan=lifespan)


class SpeakRequest(BaseModel):
    engine: str
    text: str
    voice: str = ""
    reference_wav: str = ""
    out: str


@app.get("/health")
async def health():
    # `engines` is the list of engines that are *currently ready*, not the
    # static set this sidecar supports. The controller's probe loop in
    # controller/src/audio/ttsHeavyClient.ts uses `engines.includes(<name>)`
    # as its readiness signal, so reporting an engine here while its worker
    # is still booting (or has crashed mid-session) would cause failed
    # /speak calls instead of clean fall-throughs to Piper. The boolean
    # *_loaded fields are kept for operator diagnostics.
    ready_engines: list[str] = []
    if chatterbox_worker.ready:
        ready_engines.append("chatterbox")
    if pocket_worker.ready:
        ready_engines.append("pocket-tts")
    # Advertised as a capability the controller's analyzer client probes for
    # (music/analyzer.ts checks engines.includes("analyze")).
    if analyzer_worker.ready:
        ready_engines.append("analyze")
    return {
        "ok": True,
        "engines": ready_engines,
        "chatterbox_loaded": chatterbox_worker.ready,
        "pocket_loaded": pocket_worker.ready,
        # Whether PocketTTS can do zero-shot voice cloning. False when the
        # gated kyutai/pocket-tts weights weren't available at load (no
        # HF_TOKEN) — the controller surfaces this so cloned .wav voices don't
        # silently revert to a built-in (issue #238). None until the worker is
        # ready and has reported its capability.
        "pocket_voice_cloning": (
            pocket_worker.ready_meta.get("voice_cloning") if pocket_worker.ready else None
        ),
        "analyze_loaded": analyzer_worker.ready,
        # Whether the analyze worker can emit CLAP "sounds-like" audio
        # embeddings — true only when the image was built WITH_CLAP=1 (the torch
        # + transformers stack is present). The controller surfaces this so the
        # admin UI warns to rebuild the sidecar *before* a fruitless run rather
        # than after the fingerprint bar stays at 0. None until the worker is
        # ready and has reported its capability.
        "analyze_audio_capable": (
            analyzer_worker.ready_meta.get("audio_embedding_capable") if analyzer_worker.ready else None
        ),
        # Likewise for Demucs vocal-activity ranges — true only when built
        # WITH_DEMUCS=1. None until the worker is ready.
        "analyze_vocal_capable": (
            analyzer_worker.ready_meta.get("vocal_activity_capable") if analyzer_worker.ready else None
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

    if req.engine == "chatterbox":
        msg = await chatterbox_worker.request({
            "id": "1",
            "text": text,
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        })
    elif req.engine == "pocket-tts":
        msg = await pocket_worker.request({
            "id": "1",
            "text": text,
            "voice": req.voice or POCKET_TTS_DEFAULT_VOICE,
            # Issue #213 — forward the reference WAV path for zero-shot
            # cloning. Mirrors the chatterbox branch above; the worker treats
            # an empty value as "use the built-in voice".
            "reference_wav": req.reference_wav or "",
            "out": req.out,
        })
    else:
        raise HTTPException(400, f"unknown engine: {req.engine}")

    if not msg.get("ok"):
        raise HTTPException(500, msg.get("error") or "worker failed")
    return {
        "ok": True,
        "path": msg["path"],
        "duration_s": msg.get("duration_s", 0),
        # Surface PocketTTS' per-call voice substitution (issue #238) so the
        # controller can log when the requested voice/clone wasn't honoured.
        # Absent for engines that don't report it (chatterbox).
        "voice_used": msg.get("voice_used"),
        "fell_back": msg.get("fell_back", False),
        "fell_back_reason": msg.get("fell_back_reason"),
    }


class AnalyzeRequest(BaseModel):
    # Either a remote stream url (the worker downloads it) or a local path on
    # the shared /var/sub-wave volume the controller pre-fetched into. The
    # controller's prefetch pipeline sends `path` to overlap network I/O with
    # the sidecar's single-threaded compute; `url` stays as the fallback.
    url: str | None = None
    path: str | None = None
    # Per-request CLAP opt-in (the controller's admin toggle). True makes the
    # worker lazy-load CLAP even without ANALYZE_AUDIO_EMBEDDING in its env;
    # None keeps the worker's env-driven default.
    embed: bool | None = None
    # Same, for Demucs vocal-activity ranges (ANALYZE_VOCAL_ACTIVITY default).
    vocal: bool | None = None


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    if req.path:
        payload = {"id": "1", "path": req.path}
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
    out = {
        "ok": True,
        "bpm": msg.get("bpm"),
        "key": msg.get("key"),
        "intro_ms": msg.get("intro_ms"),
        "confidence": msg.get("confidence"),
    }
    # Optional perceptual loudness + structural sections — present only when the
    # worker computed them. Pass through; omitted otherwise so the client maps
    # them to null (unity gain / no structure).
    for k in ("loudness_lufs", "peak_db", "sections", "vocal_ranges", "pace_curve"):
        if k in msg:
            out[k] = msg[k]
    # Optional CLAP audio embedding — present only when the worker has the model
    # loaded (ANALYZE_AUDIO_EMBEDDING + CLAP weights). Pass it straight through;
    # omitted otherwise so the controller's analyzer client maps it to null.
    if "audio_embedding" in msg:
        out["audio_embedding"] = msg["audio_embedding"]
    return out
