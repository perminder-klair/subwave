#!/usr/bin/env python3
"""
Kokoro TTS worker — line-protocol child process.

The Node side (controller/src/kokoro.js) spawns this once and keeps it alive,
because loading the ONNX model takes 2-5 seconds and we'd rather not eat that
on every DJ link. Protocol is one JSON object per line over stdin/stdout.

Request:  {"id": "<any>", "text": "...", "voice": "bm_george", "out": "/path/to.wav", "speed": 1.0}
Response: {"id": "<echoed>", "ok": true,  "path": "/path/to.wav", "duration_s": 3.4}
       |  {"id": "<echoed>", "ok": false, "error": "..."}

`lang` is fixed to "en-gb" for British English — kokoro-onnx picks a phonemizer
based on this, and the misaki package needs espeak-ng installed in the image.
"""

import json
import os
import sys
import traceback
from pathlib import Path

MODEL = os.environ.get("KOKORO_MODEL", "/opt/kokoro/models/kokoro-v1.0.onnx")
VOICES = os.environ.get("KOKORO_VOICES", "/opt/kokoro/models/voices-v1.0.bin")
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "bm_george")
DEFAULT_LANG = os.environ.get("KOKORO_LANG", "en-gb")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    # Anything on stderr is captured by the Node parent as plain log lines.
    sys.stderr.write(f"[kokoro-worker] {msg}\n")
    sys.stderr.flush()


def main():
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"import failed: {e}"})
        sys.exit(1)

    log(f"loading model: {MODEL}")
    log(f"loading voices: {VOICES}")
    try:
        kokoro = Kokoro(MODEL, VOICES)
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"model load failed: {e}"})
        sys.exit(1)

    log("ready")
    emit({"id": None, "ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            text = (req.get("text") or "").strip()
            if not text:
                raise ValueError("empty text")
            voice = req.get("voice") or DEFAULT_VOICE
            lang = req.get("lang") or DEFAULT_LANG
            speed = float(req.get("speed") or 1.0)
            out = req.get("out")
            if not out:
                raise ValueError("missing 'out' path")
            Path(out).parent.mkdir(parents=True, exist_ok=True)

            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            sf.write(out, samples, sample_rate)

            duration = float(len(samples)) / float(sample_rate)
            emit({"id": req_id, "ok": True, "path": out, "duration_s": round(duration, 3)})
        except Exception as e:
            log(f"request failed: {e}\n{traceback.format_exc()}")
            emit({"id": req_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
