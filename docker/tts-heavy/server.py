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

DEVICE = os.environ.get("TTS_HEAVY_DEVICE", "cpu").lower()
POCKET_TTS_DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "alba")

# Per-worker HF cache homes so the two engines don't fight over the same
# directory. The Dockerfile pre-warms each cache; the env vars below tell
# huggingface_hub where to look at runtime.
CHATTERBOX_HF_HOME = os.environ.get("CHATTERBOX_HF_HOME", "/opt/chatterbox/hf-cache")
POCKET_HF_HOME = os.environ.get("POCKET_HF_HOME", "/opt/pocket-tts/hf-cache")

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
    """

    def __init__(self, name: str, python: str, script: str, env_extra: dict[str, str] | None = None):
        self.name = name
        self.python = python
        self.script = script
        self.env_extra = env_extra or {}
        self.proc: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.ready = False

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
        # docker logs.
        asyncio.create_task(self._pump_stderr())

        # Read until we see {"ready": true}. Workers emit some non-JSON noise
        # on stdout during model load — perth (chatterbox's watermarker) prints
        # "loaded PerthNet (Implicit) at step 250,000" via a bare print().
        # Mirror the controller's TS code (controller/src/audio/chatterbox.ts
        # handleMessage) and silently skip anything that doesn't parse — the
        # workers themselves only emit JSON for protocol messages. Chatterbox
        # can take 30+ seconds to instantiate ChatterboxTurboTTS even from a
        # warm cache, so no timeout here — uvicorn + the container restart
        # policy are the upstream safety net.
        msg = await self._await_message(expect_ready=True)
        if msg.get("fatal"):
            raise RuntimeError(f"[{self.name}] fatal: {msg.get('error')}")
        if not msg.get("ready"):
            raise RuntimeError(f"[{self.name}] expected ready, got: {msg}")
        log.info(f"[{self.name}] ready")
        self.ready = True

    async def _await_message(self, expect_ready: bool = False) -> dict[str, Any]:
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
        while True:
            line = await self.proc.stderr.readline()
            if not line:
                break
            log.info(f"[{self.name}] {line.decode().rstrip()}")

    async def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self.lock:
            if not self.proc or self.proc.returncode is not None:
                raise RuntimeError(f"[{self.name}] worker is not running")
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Boot both workers in parallel. They independently load models (3-15s
    # each from a warm cache) and emit {"ready": true} when they're done.
    # gather() means the slower one gates startup, but both run concurrently.
    await asyncio.gather(chatterbox_worker.start(), pocket_worker.start())
    yield
    # No graceful drain on shutdown — workers get SIGKILL'd by the container
    # stop and the controller's probe loop will see /health go away.


app = FastAPI(title="subwave-tts-heavy", lifespan=lifespan)


class SpeakRequest(BaseModel):
    engine: str
    text: str
    voice: str = ""
    reference_wav: str = ""
    out: str


@app.get("/health")
async def health():
    return {
        "ok": True,
        "engines": ["chatterbox", "pocket-tts"],
        "chatterbox_loaded": chatterbox_worker.ready,
        "pocket_loaded": pocket_worker.ready,
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
    }
