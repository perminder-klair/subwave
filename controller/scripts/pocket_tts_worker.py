#!/usr/bin/env python3
"""
PocketTTS worker — line-protocol child process.

The Node side (controller/src/audio/pocketTts.ts) spawns this once and keeps
it alive: kyutai-labs/pocket-tts loads a ~100M-param model on first call and
caching it across requests turns ~6x real-time inference into the actual cost
per line. Protocol mirrors kokoro_worker.py and chatterbox_worker.py — one
JSON object per line over stdin/stdout.

Request:  {"id": "...", "text": "...", "voice": "alba",
           "reference_wav": "/path/to/ref.wav",  # optional, empty = built-in
           "out": "/path/to.wav"}
Response: {"id": "...", "ok": true,  "path": "/path/to.wav", "duration_s": 3.4}
       |  {"id": "...", "ok": false, "error": "..."}

Voice selection (issue #213):
  - "voice" only (built-in id like alba, anna, charles, estelle, giovanni,
    juergen, lola, rafael) → curated voice plays directly.
  - "reference_wav" set     → zero-shot cloning from the WAV. The base voice
    is still passed so the model has a speaker prior if the reference load
    fails — the worker logs the failure and falls back instead of erroring.

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
    # Reference-WAV clones cache under their absolute path; built-in ids
    # cache under their id, so the two namespaces never collide.
    voice_states = {}

    def voice_state(key):
        st = voice_states.get(key)
        if st is None:
            st = model.get_state_for_audio_prompt(key)
            voice_states[key] = st
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
            ref = (req.get("reference_wav") or "").strip()
            out = req.get("out")
            if not out:
                raise ValueError("missing 'out' path")

            # Prefer a reference WAV when one is supplied — same API call as
            # built-in voices, just with an absolute path instead of an id.
            # On failure, log and fall back to the built-in default so a stale
            # / missing clone never silences a segment.
            state = None
            if ref:
                if not os.path.exists(ref):
                    log(f"reference_wav {ref!r} not found; falling back to {DEFAULT_VOICE!r}")
                else:
                    try:
                        state = voice_state(ref)
                    except Exception as e:
                        log(f"reference_wav {ref!r} failed ({e}); falling back to {DEFAULT_VOICE!r}")
            if state is None:
                try:
                    state = voice_state(voice)
                except Exception as e:
                    # Unknown voice id — fall back to the default rather than
                    # 500 the request, mirroring how chatterbox falls back to
                    # its built-in voice when a reference clip is missing.
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
            # Loudness. PocketTTS is the operator's chosen on-air voice and was
            # perceived quiet on the (ducked) music bed, so we drive it
            # deliberately hot: RMS-normalize to a high target, then soft-limit
            # peaks instead of hard-clipping — so the louder level never chops
            # into harsh clipping. POCKET_TTS_TARGET_RMS tunes it without a code
            # change (0.245 linear ≈ -12.2 dBFS RMS, ~+2 dB over the old -14.3).
            target_rms = float(os.environ.get("POCKET_TTS_TARGET_RMS", "0.245"))
            rms = float(np.sqrt(np.mean(audio * audio))) if audio.size else 0.0
            if rms > 0:
                audio = audio * (target_rms / rms)
            # Soft-knee limiter: transparent below `knee`, then tanh-shaped up to
            # `ceiling` (~-0.26 dBFS). Tames the hotter signal's peaks smoothly
            # and adds a touch of presence, where a hard clip would distort.
            knee, ceiling = 0.70, 0.97
            mag = np.abs(audio)
            over = mag > knee
            audio[over] = np.sign(audio[over]) * (
                knee + (ceiling - knee) * np.tanh((mag[over] - knee) / (ceiling - knee))
            )
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
