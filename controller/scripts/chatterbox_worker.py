#!/usr/bin/env python3
"""
Chatterbox TTS worker — line-protocol child process.

The Node side (controller/src/audio/chatterbox.ts) spawns this once and keeps
it alive, because loading the Chatterbox Turbo model takes ~10-30s and we don't
want to eat that on every DJ link. Protocol is one JSON object per line over
stdin/stdout, identical in shape to kokoro_worker.py.

Request:  {"id": "...", "text": "...", "out": "/path/to.wav",
           "reference_wav": "/optional/reference.wav"}
Response: {"id": "...", "ok": true,  "path": "/path/to.wav", "duration_s": 3.4}
       |  {"id": "...", "ok": false, "error": "..."}

Uses the official `chatterbox-tts` PyPI package — `ChatterboxTurboTTS` from
`chatterbox.tts_turbo`. There is no turn-key ONNX runtime package, so this is
the PyTorch path; it runs on CPU (slow) or CUDA. The model + weights are baked
into the controller image only when it is built with
`--build-arg WITH_CHATTERBOX=1` (see docker/Dockerfile.controller). Weights are
resolved through the Hugging Face cache (HF_HOME), pre-warmed at image build.
"""

import json
import os
import re
import sys
import traceback
from pathlib import Path

DEVICE = os.environ.get("CHATTERBOX_DEVICE", "cpu").lower()
DEFAULT_REFERENCE = os.environ.get("CHATTERBOX_REFERENCE_WAV", "")

# --- long-input chunking (issue #1130) -------------------------------------
# Chatterbox is autoregressive: one generate() over a long block accumulates
# drift and comes out jumbled/garbled somewhere past ~2 sentences (~300 chars),
# with NO error thrown — the well-known Chatterbox long-input failure mode, not
# anything SUB/WAVE-specific. Piper/Kokoro don't hit it (they aren't
# autoregressive). The mitigation is to synthesise long segments a chunk at a
# time so the model never sees a block long enough to drift, then stitch the
# audio back together. Short lines (station IDs, one-line links — the common
# case) stay a single chunk, so their output is byte-identical to before.
MAX_CHUNK_CHARS = int(os.environ.get("CHATTERBOX_MAX_CHUNK_CHARS", "280"))
# Silence inserted between stitched chunks (milliseconds) so a sentence boundary
# breathes instead of butting straight into the next chunk. Kept short — this is
# a within-segment pause, not a between-segment one.
CHUNK_GAP_MS = int(os.environ.get("CHATTERBOX_CHUNK_GAP_MS", "160"))

# Sentence boundary: a .!? followed by whitespace. Clause boundary (fallback for
# a single sentence longer than the cap): comma / semicolon / colon / dash
# followed by whitespace — where a speaker would naturally pause.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")
_CLAUSE_SPLIT = re.compile(r"(?<=[,;:—-])\s+")


def _hard_wrap(fragment, max_chars):
    """Last-resort split for a fragment longer than max_chars with no usable
    punctuation boundary — break on the last space before the cap, else split
    mid-word. Only reached by pathological input (a single unpunctuated run
    past the cap); normal DJ copy never gets here."""
    out = []
    s = fragment.strip()
    while len(s) > max_chars:
        cut = s.rfind(" ", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        out.append(s[:cut].strip())
        s = s[cut:].strip()
    if s:
        out.append(s)
    return out


def chunk_text(text, max_chars=MAX_CHUNK_CHARS):
    """Pack a spoken segment into <=max_chars chunks on sentence boundaries.

    Never cuts mid-sentence unless a single sentence itself exceeds max_chars —
    then it falls back to clause boundaries, then a hard word wrap. A line at or
    under the cap comes back as a single unchanged chunk (the common case, no
    behaviour change). Pure string logic — no torch/audio deps — so it is
    unit-testable without loading the model (see test_chatterbox_chunk.py).
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    chunks = []
    current = ""

    def flush():
        nonlocal current
        if current:
            chunks.append(current)
            current = ""

    def add(piece):
        nonlocal current
        piece = piece.strip()
        if not piece:
            return
        if not current:
            current = piece
        elif len(current) + 1 + len(piece) <= max_chars:
            current = f"{current} {piece}"
        else:
            flush()
            current = piece

    for sentence in (s.strip() for s in _SENTENCE_SPLIT.split(text) if s.strip()):
        if len(sentence) <= max_chars:
            add(sentence)
            continue
        # Sentence alone busts the cap — break it on clause boundaries, and hard
        # wrap any clause that is still too long, before packing the pieces.
        for clause in (c.strip() for c in _CLAUSE_SPLIT.split(sentence) if c.strip()):
            if len(clause) <= max_chars:
                add(clause)
            else:
                for piece in _hard_wrap(clause, max_chars):
                    add(piece)
    flush()
    return chunks


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    # Anything on stderr is captured by the Node parent as plain log lines.
    sys.stderr.write(f"[chatterbox-worker] {msg}\n")
    sys.stderr.flush()


def main():
    try:
        import numpy as np
        import torch
        import soundfile as sf
        from chatterbox.tts_turbo import ChatterboxTurboTTS
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"import failed: {e}"})
        sys.exit(1)

    # --- torch >= 2.9 float64 guard (RTX 50-series / Blackwell) ----------------
    # The CUDA build for newer cards (sm_120) runs chatterbox-tts — which is
    # built against torch 2.6 — on torch >= 2.9, and 2.9 is strict about dtype
    # mismatches. In ChatterboxTurboTTS.prepare_conditionals the reference clip
    # is loudness-normalised by multiplying with a pyloudnorm float64 gain, which
    # upcasts the waveform to float64; that array then flows through
    # librosa.resample into the voice encoder as a Double tensor and trips
    # "expected scalar type Float but found Double" (torch 2.6 silently promoted
    # it). Coerce librosa's audio output back to float32 at the source. No-op on
    # the CPU / older-GPU paths, where the audio is already float32.
    try:
        import librosa

        _orig_load = librosa.load
        _orig_resample = librosa.resample

        def _load_f32(*args, **kwargs):
            y, sr = _orig_load(*args, **kwargs)
            if hasattr(y, "dtype") and y.dtype != "float32":
                y = y.astype("float32")
            return y, sr

        def _resample_f32(*args, **kwargs):
            y = _orig_resample(*args, **kwargs)
            if hasattr(y, "dtype") and y.dtype != "float32":
                y = y.astype("float32")
            return y

        librosa.load = _load_f32
        librosa.resample = _resample_f32
    except Exception as e:
        log(f"librosa float32 guard not applied: {e}")

    device = DEVICE
    if device == "cuda" and not torch.cuda.is_available():
        log("CUDA requested but unavailable — falling back to cpu")
        device = "cpu"

    log(f"loading ChatterboxTurboTTS on device={device}")
    try:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    except Exception as e:
        emit({"id": None, "ok": False, "fatal": True, "error": f"model load failed: {e}"})
        sys.exit(1)

    sample_rate = model.sr

    def to_mono_f32(wav):
        """Reduce a generate() tensor [channels, samples] to a numpy float32
        array — mono [samples], or [samples, channels] for the rare multichannel
        case — ready for concatenate + soundfile.write."""
        if hasattr(wav, "detach"):
            wav = wav.detach()
        if hasattr(wav, "cpu"):
            wav = wav.cpu()
        samples = wav.numpy() if hasattr(wav, "numpy") else wav
        if getattr(samples, "ndim", 1) == 2:
            # [channels, samples] -> mono [samples] or [samples, channels]
            samples = samples[0] if samples.shape[0] == 1 else samples.T
        if hasattr(samples, "astype") and getattr(samples, "dtype", None) != "float32":
            samples = samples.astype("float32")
        return samples

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
            out = req.get("out")
            if not out:
                raise ValueError("missing 'out' path")
            reference_wav = req.get("reference_wav") or DEFAULT_REFERENCE
            if reference_wav and not Path(reference_wav).is_file():
                log(f"reference_wav not found, using built-in voice: {reference_wav}")
                reference_wav = ""
            Path(out).parent.mkdir(parents=True, exist_ok=True)

            # Chunk long input so Chatterbox never sees a block long enough to
            # drift (issue #1130), synthesise each chunk, and stitch. A short
            # line is a single chunk, so this is a no-op for the common case.
            # Voice cloning is opt-in per request: passing audio_prompt_path
            # clones the reference clip — the SAME clip on every chunk, so the
            # cloned voice stays consistent across the stitch; omitting it uses
            # the built-in voice.
            pieces = []
            gap = None
            for chunk in chunk_text(text):
                if reference_wav:
                    wav = model.generate(chunk, audio_prompt_path=reference_wav)
                else:
                    wav = model.generate(chunk)
                samples = to_mono_f32(wav)
                if pieces:
                    if gap is None:
                        gap_len = max(0, int(sample_rate * CHUNK_GAP_MS / 1000.0))
                        gap = (
                            np.zeros((gap_len, samples.shape[1]), dtype="float32")
                            if samples.ndim == 2
                            else np.zeros(gap_len, dtype="float32")
                        )
                    if gap.size:
                        pieces.append(gap)
                pieces.append(samples)

            # Each piece is already a numpy [samples] (mono) or [samples,
            # channels] float32 array (see to_mono_f32). Write via soundfile
            # (libsndfile) rather than torchaudio.save: torch >= 2.8 routes
            # torchaudio.save through torchcodec — an extra native dep that isn't
            # in the image and whose libnvrtc mismatches the cu128 wheels on the
            # GPU build. soundfile is already present (librosa depends on it) and
            # writes the same WAV.
            samples = np.concatenate(pieces, axis=0) if len(pieces) > 1 else pieces[0]
            sf.write(out, samples, sample_rate)

            duration = float(samples.shape[0]) / float(sample_rate)
            emit({"id": req_id, "ok": True, "path": out, "duration_s": round(duration, 3)})
        except Exception as e:
            log(f"request failed: {e}\n{traceback.format_exc()}")
            emit({"id": req_id, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
