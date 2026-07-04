#!/usr/bin/env python3
"""
Kokoro TTS worker — line-protocol child process.

The Node side (controller/src/audio/kokoro.js) spawns this once and keeps it alive,
because loading the ONNX model takes 2-5 seconds and we'd rather not eat that
on every DJ link. Protocol is one JSON object per line over stdin/stdout.

Request:  {"id": "<any>", "text": "...", "voice": "bm_george", "out": "/path/to.wav", "speed": 1.0}
Response: {"id": "<echoed>", "ok": true,  "path": "/path/to.wav", "duration_s": 3.4}
       |  {"id": "<echoed>", "ok": false, "error": "..."}

`lang` (optional) explicitly overrides the phonemizer language (e.g. "en-gb").
When provided, the voice's audio/timbre is preserved but the phonemes are
generated for the given language (e.g. a Japanese voice reading English text).
When absent, the language is auto-detected from the voice code prefix character.
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
        import misaki
        from misaki import espeak
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

    lang_mapping = {
        "a": "en-us",
        "b": "en-gb",
        "e": "es",
        "i": "it",
        "f": "fr",
        "h": "hi",
        "p": "pt-br",
        "j": "ja",
        "z": "cmn",
    }
    # EspeakG2P construction isn't free, and there are only a handful of
    # languages, so build each phonemizer once and reuse it across requests.
    g2p_cache = {}

    def _phonemize(voice_code, lang=None):
        """Return a cached language-aware phonemizer. When `lang` is explicitly
        provided use it directly (voice timbre, accent preserved); otherwise
        auto-detect from the voice code prefix character."""
        if not lang or lang not in lang_mapping.values():
            lang = lang_mapping.get(voice_code[0], "en-gb")  # british english fallback
        g2p = g2p_cache.get(lang)
        if g2p is None:
            g2p = espeak.EspeakG2P(language=lang)
            g2p_cache[lang] = g2p
        return g2p


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
            lang = (req.get("lang") or "").strip() or None
            speed = float(req.get("speed") or 1.0)
            out = req.get("out")
            if not out:
                raise ValueError("missing 'out' path")
            Path(out).parent.mkdir(parents=True, exist_ok=True)

            phonemes, _ = _phonemize(voice, lang)(text)

            samples, sample_rate = kokoro.create(phonemes, voice=voice, speed=speed, is_phonemes=True)
            sf.write(out, samples, sample_rate)

            duration = float(len(samples)) / float(sample_rate)
            emit({"id": req_id, "ok": True, "path": out, "duration_s": round(duration, 3)})
        except Exception as e:
            log(f"request failed: {e}\n{traceback.format_exc()}")
            emit({"id": req_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
