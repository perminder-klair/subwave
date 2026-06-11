#!/usr/bin/env python3
"""
Acoustic-analysis worker — line-protocol child process.

The Node side (controller/src/music/analyzer.ts) spawns this once and keeps it
alive, because importing librosa takes a couple of seconds and we don't want to
eat that per track in a bulk pass. Protocol is one JSON object per line over
stdin/stdout, same shape as the Kokoro/PocketTTS workers.

Request:  {"id": "<song id>", "url": "<http stream url>"}   (worker downloads)
       |  {"id": "<song id>", "path": "<local file path>"}  (caller owns it)
Response: {"id": "<echoed>", "ok": true, "bpm": 122.0, "key": "8A",
           "intro_ms": 8200, "confidence": 0.71,
           "audio_embedding": [/* 512 floats, OPTIONAL */]}
       |  {"id": "<echoed>", "ok": false, "error": "..."}

`audio_embedding` is present ONLY when ANALYZE_AUDIO_EMBEDDING is enabled AND a
CLAP model loaded — a 512-d, L2-normalised vector of how the track SOUNDS
(timbre / instrumentation / production), derived from the waveform itself. When
disabled or the model is absent the field is omitted entirely and the worker
behaves exactly as it did before (bpm/key/intro only) — never a hard failure.

This deliberately lives OUTSIDE the controller image — librosa pulls in
numba/scipy/soundfile, which the controller must stay lean of. It runs in the
tts-heavy sidecar's analyzer venv, or in a standalone offline venv on the
operator's machine. Audio is fetched from the Subsonic stream URL (auth baked
into the query string) to a temp file, then only the first ANALYZE_SECONDS are
decoded — enough for tempo/key and the intro estimate, a fraction of the bytes.
"""

import json
import os
import sys
import tempfile
import urllib.request

# 60s is enough for stable BPM (beat_track) / key (chroma); intro
# detection only needs the first ~20-30s. Env-overridable.
ANALYZE_SECONDS = float(os.environ.get("ANALYZE_SECONDS", "60"))
ANALYZE_SR = int(os.environ.get("ANALYZE_SR", "22050"))
FETCH_TIMEOUT_S = float(os.environ.get("ANALYZE_FETCH_TIMEOUT_S", "60"))

# --- CLAP audio embedding (optional, opt-in) -------------------------------
# Off unless ANALYZE_AUDIO_EMBEDDING is truthy. CLAP wants 48 kHz mono; the
# embedding dim is fixed by the model (LAION-CLAP audio projection = 512).
EMBED_ENABLED = os.environ.get("ANALYZE_AUDIO_EMBEDDING", "").strip().lower() in (
    "1", "true", "yes",
)
CLAP_SR = 48000
CLAP_EMBED_DIM = 512

# Krumhansl-Kessler key profiles (major/minor), indexed from the tonic.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# Camelot code per pitch class (C=0 … B=11), one table per mode.
MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[analyze-worker] {msg}\n")
    sys.stderr.flush()


def _pearson(a, b):
    n = len(a)
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    da = sum((a[i] - ma) ** 2 for i in range(n)) ** 0.5
    db = sum((b[i] - mb) ** 2 for i in range(n)) ** 0.5
    if da == 0 or db == 0:
        return 0.0
    return num / (da * db)


def estimate_key(chroma_mean):
    """Krumhansl-Schmuckler: correlate the mean chroma against all 24 keys.
    Returns (camelot_code, separation) where separation (best - 2nd best
    correlation, 0..1-ish) is a rough confidence in the key call."""
    scores = []  # (corr, camelot)
    for tonic in range(12):
        rotated = [chroma_mean[(tonic + i) % 12] for i in range(12)]
        scores.append((_pearson(MAJOR_PROFILE, rotated), MAJOR_CAMELOT[tonic]))
        scores.append((_pearson(MINOR_PROFILE, rotated), MINOR_CAMELOT[tonic]))
    scores.sort(reverse=True, key=lambda s: s[0])
    best_corr, best_code = scores[0]
    separation = max(0.0, min(1.0, best_corr - scores[1][0]))
    return best_code, separation


def estimate_intro_ms(y, sr, librosa):
    """Rough intro length: the first time the short-term energy rises and stays
    above a fraction of the track's typical loud level — i.e. where the track
    'comes in' after any quiet count-in. This is an energy heuristic, NOT true
    vocal-onset detection, so callers treat it as a soft budget, never a gate."""
    import numpy as np

    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    if rms.size == 0:
        return None
    loud = float(np.percentile(rms, 80))
    if loud <= 0:
        return None
    threshold = 0.30 * loud
    times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=512)
    # First frame that crosses the threshold and stays above it for ~0.5s.
    sustain_frames = max(1, int(0.5 * sr / 512))
    for i in range(rms.size):
        if rms[i] >= threshold:
            window = rms[i : i + sustain_frames]
            if window.size and float(np.mean(window)) >= threshold:
                return max(0.0, float(times[i]) * 1000.0)
    return 0.0


# ---------------------------------------------------------------------------
# CLAP embedder — two backends, decided at load time:
#   * ONNX (lean): CLAP_MODEL_PATH points at an exported audio-encoder .onnx;
#     run via onnxruntime. Feature extraction still goes through transformers'
#     ClapProcessor so the mel preprocessing is exactly what CLAP expects (the
#     genuinely fiddly part), regardless of how the encoder runs.
#   * transformers (fallback): no .onnx → load the full ClapModel from a HF id
#     (CLAP_MODEL, default laion/clap-htsat-unfused) and call get_audio_features.
# Both produce the same 512-d L2-normalised vector. All heavy imports are lazy
# so a worker with embeddings DISABLED never needs torch/transformers/onnx and
# the librosa-only venv keeps working.
# ---------------------------------------------------------------------------
class ClapEmbedder:
    def __init__(self):
        self.mode = None
        self.processor = None
        self.session = None   # onnx
        self.input_name = None
        self.model = None     # transformers

    def load(self):
        from transformers import ClapProcessor

        # Empty strings count as unset — the compose files pass these through
        # as `${CLAP_MODEL:-}` etc., which exports "" when the operator hasn't
        # set them in the root .env.
        onnx_path = os.environ.get("CLAP_MODEL_PATH", "").strip()
        hf_id = os.environ.get("CLAP_MODEL", "").strip() or "laion/clap-htsat-unfused"
        # The processor (feature extraction) is keyed to a HF model; default to
        # the same id as the encoder, override with CLAP_FEATURE_MODEL when the
        # .onnx was exported from a differently-named checkpoint.
        feat_id = os.environ.get("CLAP_FEATURE_MODEL", "").strip() or hf_id

        if onnx_path and os.path.exists(onnx_path):
            import onnxruntime as ort

            self.processor = ClapProcessor.from_pretrained(feat_id)
            self.session = ort.InferenceSession(
                onnx_path, providers=["CPUExecutionProvider"]
            )
            self.input_name = self.session.get_inputs()[0].name
            self.mode = "onnx"
            log(f"CLAP onnx encoder loaded: {onnx_path} (features: {feat_id})")
        else:
            if onnx_path:
                log(f"CLAP_MODEL_PATH set but missing ({onnx_path}); using transformers")
            from transformers import ClapModel

            self.model = ClapModel.from_pretrained(hf_id)
            self.model.eval()
            self.processor = ClapProcessor.from_pretrained(hf_id)
            self.mode = "transformers"
            log(f"CLAP transformers model loaded: {hf_id}")

    def embed(self, y48, sr):
        import numpy as np

        return_tensors = "np" if self.mode == "onnx" else "pt"
        # transformers renamed the ClapProcessor audio kwarg `audios` → `audio`
        # and turned the old name into a hard error (not just a warning) in
        # recent releases. Try the new name, fall back to the old one so this
        # works against whatever transformers the analyzer venv resolved.
        try:
            inputs = self.processor(
                audio=y48, sampling_rate=sr, return_tensors=return_tensors
            )
        except (TypeError, ValueError):
            inputs = self.processor(
                audios=y48, sampling_rate=sr, return_tensors=return_tensors
            )
        feats = inputs["input_features"]

        if self.mode == "onnx":
            feats_np = np.asarray(feats, dtype=np.float32)
            out = self.session.run(None, {self.input_name: feats_np})
            vec = np.asarray(out[0]).reshape(-1)
        else:
            import torch

            with torch.no_grad():
                emb = self.model.get_audio_features(input_features=feats)
            # transformers ≤4.x returns the projected 512-d audio-features
            # tensor directly; 5.x returns a BaseModelOutputWithPooling whose
            # .pooler_output is that same projected embedding. Unwrap the new
            # shape so this works against whatever the analyzer venv resolved.
            if hasattr(emb, "pooler_output"):
                emb = emb.pooler_output
            vec = emb.cpu().numpy().reshape(-1)

        if vec.shape[0] != CLAP_EMBED_DIM:
            raise RuntimeError(
                f"unexpected CLAP embedding dim {vec.shape[0]} (want {CLAP_EMBED_DIM})"
            )
        # L2-normalise so the vec0 table's cosine distance is well-conditioned.
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec = vec / norm
        return [float(x) for x in vec]


# Lazily loaded, at most once. None means "no embeddings this run" — either
# disabled or a load failure (which we log once and then never retry, so one bad
# model can't make every track fail).
_embedder = None
_embed_failed = False


def get_embedder(force=False):
    global _embedder, _embed_failed
    # `force` is the per-request opt-in (the controller's admin toggle sends
    # "embed": true) — it lazy-loads CLAP even when ANALYZE_AUDIO_EMBEDDING
    # isn't in this process's env. A previous load failure still wins: one bad
    # model can't make every subsequent track retry the load.
    if _embed_failed or not (EMBED_ENABLED or force):
        return None
    if _embedder is None:
        try:
            e = ClapEmbedder()
            e.load()
            _embedder = e
        except Exception as ex:  # noqa: BLE001 — degrade, never crash the worker
            log(f"CLAP load failed ({ex}); audio embeddings disabled for this run")
            _embed_failed = True
            return None
    return _embedder


def fetch_audio(url):
    suffix = ".audio"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="swanalyze_")
    os.close(fd)
    req = urllib.request.Request(url, headers={"User-Agent": "subwave-analyzer/1"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp, open(path, "wb") as out:
        # Cap the download so we don't pull whole albums of bytes for a
        # 120-second analysis window — ~3 MB covers 2 min of most codecs.
        max_bytes = int(os.environ.get("ANALYZE_MAX_BYTES", str(12 * 1024 * 1024)))
        read = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)
            read += len(chunk)
            if read >= max_bytes:
                break
    return path


def analyze(librosa, url=None, path=None, embed=None):
    import numpy as np

    # A controller-provided path is pre-fetched onto the shared volume and
    # owned by the caller; only files fetch_audio downloads here are ours to
    # remove. Keeps the url path behaviour identical for back-compat.
    owned = path is None
    if owned:
        path = fetch_audio(url)
    audio_embedding = None
    try:
        y, sr = librosa.load(path, sr=ANALYZE_SR, mono=True, duration=ANALYZE_SECONDS)
        # CLAP wants 48 kHz mono — decode a second copy at that rate from the
        # SAME file (still present here, before the finally removes owned temps).
        # A model/feature failure on one track never fails the whole analyze:
        # we log and emit bpm/key without the embedding.
        # Per-request `embed` wins over the env default in the ON direction
        # only: True forces a (lazy) CLAP load, None/absent keeps the env-driven
        # behaviour. False is never sent by the controller today.
        embedder = None if embed is False else get_embedder(force=embed is True)
        if embedder is not None:
            try:
                y48, _sr48 = librosa.load(
                    path, sr=CLAP_SR, mono=True, duration=ANALYZE_SECONDS
                )
                if y48 is not None and len(y48) > 0:
                    audio_embedding = embedder.embed(y48, CLAP_SR)
            except Exception as e:  # noqa: BLE001 — embedding is best-effort
                log(f"audio embedding failed: {e}")
                audio_embedding = None
    finally:
        if owned:
            try:
                os.remove(path)
            except OSError:
                pass

    if y is None or len(y) == 0:
        raise RuntimeError("decoded empty audio")

    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = [float(x) for x in np.mean(chroma, axis=1)]
    key, key_sep = estimate_key(chroma_mean)

    intro_ms = estimate_intro_ms(y, sr, librosa)

    # Overall confidence: dominated by how cleanly the key resolved, nudged by
    # whether we got a plausible tempo. Kept conservative on purpose.
    confidence = round(0.5 * key_sep + (0.5 if 40 <= bpm <= 220 else 0.0), 3)

    result = {
        "bpm": round(bpm, 1),
        "key": key,
        "intro_ms": int(intro_ms) if intro_ms is not None else None,
        "confidence": confidence,
    }
    # Only carry the embedding when we actually produced one — its absence is
    # how every downstream consumer knows to behave as today.
    if audio_embedding is not None:
        result["audio_embedding"] = audio_embedding
    return result


def main():
    try:
        import librosa  # noqa: F401
        import numpy  # noqa: F401
    except Exception as e:  # pragma: no cover
        emit({"id": None, "ok": False, "fatal": True, "error": f"import failed: {e}"})
        sys.exit(1)

    # Pre-warm the CLAP model (when enabled) BEFORE announcing ready, so the
    # one-time model download / load is paid during boot rather than on the
    # first /analyze — which would otherwise risk the request timeout and a
    # cascade while later requests queue behind a still-loading worker. A load
    # failure here just disables embeddings (get_embedder caught it); the worker
    # still boots and analyses bpm/key. The sidecar imposes no ready timeout; a
    # local-venv boot that exceeds its ready window simply restarts and finds
    # the weights cached the second time.
    if EMBED_ENABLED:
        log("ANALYZE_AUDIO_EMBEDDING on — loading CLAP model...")
        get_embedder()

    log("ready")
    emit({"id": None, "ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"id": None, "ok": False, "error": f"bad json: {e}"})
            continue
        rid = req.get("id")
        url = req.get("url")
        path = req.get("path")
        if not url and not path:
            emit({"id": rid, "ok": False, "error": "missing url or path"})
            continue
        try:
            import librosa

            result = analyze(librosa, url=url, path=path, embed=req.get("embed"))
            emit({"id": rid, "ok": True, **result})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
