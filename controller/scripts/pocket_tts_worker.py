#!/usr/bin/env python3
"""
PocketTTS worker — line-protocol child process.

The Node side (controller/src/audio/pocketTts.ts) spawns this once and keeps
it alive: kyutai-labs/pocket-tts loads a ~100M-param model on first call and
caching it across requests turns ~6x real-time inference into the actual cost
per line. Protocol mirrors kokoro_worker.py and chatterbox_worker.py — one
JSON object per line over stdin/stdout.

Request:  {"id": "...", "text": "...", "voice": "alba", "out": "/path/to.wav"}
Response: {"id": "...", "ok": true,  "path": "/path/to.wav", "duration_s": 3.4}
       |  {"id": "...", "ok": false, "error": "..."}

Built-in voices only in v1 (alba, anna, charles, estelle, giovanni, juergen,
lola, rafael). PocketTTS also supports zero-shot cloning from a reference WAV,
but the engine wrapper deliberately doesn't expose it yet — settings ship the
curated voice list, no reference-dir scan, no per-persona WAV upload UI.

The model is bundled into the controller image only when it is built with
`--build-arg WITH_POCKETTTS=1` (see docker/Dockerfile.controller). Weights live
under the Hugging Face cache (HF_HOME), pre-warmed at image build time.
"""

import json
import os
import sys
import traceback

DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "alba")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    # Anything on stderr is captured by the Node parent as plain log lines.
    sys.stderr.write(f"[pocket-tts-worker] {msg}\n")
    sys.stderr.flush()


def main():
    try:
        from pocket_tts import TTSModel
        import scipy.io.wavfile as wavfile
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"import failed: {e}"})
        sys.exit(1)

    log("loading TTSModel")
    try:
        model = TTSModel.load_model()
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"model load failed: {e}"})
        sys.exit(1)

    # get_state_for_audio_prompt() does meaningful work (loads the speaker
    # embedding) — cache per voice id so repeat lines don't pay it again.
    voice_states = {}

    def voice_state(name):
        st = voice_states.get(name)
        if st is None:
            st = model.get_state_for_audio_prompt(name)
            voice_states[name] = st
        return st

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
            out = req.get("out")
            if not out:
                raise ValueError("missing 'out' path")

            try:
                state = voice_state(voice)
            except Exception as e:
                # Unknown voice id — fall back to the default rather than 500
                # the request, mirroring how chatterbox falls back to its
                # built-in voice when a reference clip is missing.
                log(f"voice {voice!r} failed ({e}); using default {DEFAULT_VOICE!r}")
                voice = DEFAULT_VOICE
                state = voice_state(voice)

            audio = model.generate_audio(state, text)
            # generate_audio returns a torch tensor; coerce to a numpy float32
            # array in roughly [-1, 1].
            if hasattr(audio, "numpy"):
                audio = audio.numpy()
            import numpy as np
            audio = np.asarray(audio, dtype=np.float32)
            # PocketTTS' raw output has wider dynamic range than Piper / Kokoro
            # for the same line — peak sits ~-2 dBFS and mean RMS ~-19 dB,
            # versus Piper at 0 / -14 — so it feels muffled against the
            # (ducked) music bed. RMS-normalize to ~-14 dB so spoken loudness
            # matches the other local engines, then hard-clip at -0.5 dBFS as
            # a safety net (occasional peaks above target).
            rms = float(np.sqrt(np.mean(audio * audio))) if audio.size else 0.0
            if rms > 0:
                gain = 0.193 / rms       # 0.193 linear ≈ -14.3 dBFS RMS
                audio = audio * gain
            audio = np.clip(audio, -0.944, 0.944)   # -0.5 dBFS ceiling
            # Save as 16-bit PCM (matches the other engines' output format).
            audio_i16 = (audio * 32767.0).astype(np.int16)
            sample_rate = int(getattr(model, "sample_rate", 24000))
            wavfile.write(out, sample_rate, audio_i16)

            duration = float(len(audio)) / float(sample_rate)
            emit({"id": req_id, "ok": True, "path": out, "duration_s": round(duration, 3)})
        except Exception as e:
            log(f"request failed: {e}\n{traceback.format_exc()}")
            emit({"id": req_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
