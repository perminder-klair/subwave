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
(The CLAP embedding additionally decodes a mid-song and a late window from the
same file — see embed_windows — so the vector reflects the whole track, not
just its intro.)

The embedder also answers text requests ({"texts": [...]}) with CLAP
text-tower embeddings in the SAME 512-d space, which is what makes
natural-language "sounds like ..." search and zero-shot mood scoring against
the stored audio vectors possible.
"""

import importlib.util
import json
import os
import sys
import tempfile
import urllib.request

# 40s is enough for stable BPM (beat_track) / key (chroma); intro detection
# only needs the first ~20-30s. Env-overridable; the window is shared by
# bpm/key, CLAP and Demucs, and Demucs cost scales linearly with it (60→40
# measured ~1.5x faster) — keep the three defaults (here, config.ts,
# docker/analyzer/server.py) in sync.
#
# Every env read here treats an EMPTY value as unset (`.strip() or default`,
# like the CLAP_MODEL reads below): compose passes these through as
# `VAR=${VAR:-}`, which injects empty strings for anything the operator didn't
# set — a plain get(name, default) then returns "" and float("")/get_model("")
# crash or corrupt the download path (the '' checkpoint hit Errno 21).
ANALYZE_SECONDS = float(os.environ.get("ANALYZE_SECONDS", "").strip() or "40")
ANALYZE_SR = int(os.environ.get("ANALYZE_SR", "").strip() or "22050")
FETCH_TIMEOUT_S = float(os.environ.get("ANALYZE_FETCH_TIMEOUT_S", "").strip() or "60")

# --- CLAP audio embedding (optional, opt-in) -------------------------------
# Off unless ANALYZE_AUDIO_EMBEDDING is truthy. CLAP wants 48 kHz mono; the
# embedding dim is fixed by the model (LAION-CLAP audio projection = 512).
EMBED_ENABLED = os.environ.get("ANALYZE_AUDIO_EMBEDDING", "").strip().lower() in (
    "1", "true", "yes",
)
CLAP_SR = 48000
CLAP_EMBED_DIM = 512
# How many windows the CLAP embed averages over (clamped 1..3): 3 = start/mid/
# late (default), 2 = start/mid, 1 = the pre-multi-window leading-window-only
# behaviour. CLAP cost per track scales linearly — this is the speed lever for
# the embedding pass (ANALYZE_SECONDS scales everything else too).
CLAP_WINDOWS = int(os.environ.get("ANALYZE_CLAP_WINDOWS", "").strip() or "3")

# --- Outro analysis ---------------------------------------------------------
# Tail window (seconds) decoded from the END of the file for the outro
# features (wind-down start, fade-vs-cold ending, tail loudness/tempo/bars).
# Only runs when the local file is COMPLETE — a byte-capped download's tail is
# the middle of the song, so the caller passes a completeness flag and an
# unknown/short tail simply omits the field (consumers treat absence as "no
# outro signal, behave as today").
OUTRO_SECONDS = float(os.environ.get("ANALYZE_OUTRO_SECONDS", "").strip() or "20")

# --- Vocal-activity ranges (optional, opt-in) ------------------------------
# Off unless ANALYZE_VOCAL_ACTIVITY is truthy. Runs Demucs source separation to
# isolate the vocal stem, then thresholds its energy envelope into present/
# absent ranges. Heavy (a real torch model) — gated like CLAP. Demucs wants
# 44.1 kHz stereo.
VOCAL_ENABLED = os.environ.get("ANALYZE_VOCAL_ACTIVITY", "").strip().lower() in (
    "1", "true", "yes",
)
DEMUCS_SR = 44100
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "").strip() or "htdemucs"

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


# Enharmonic-preserving spelling isn't recoverable from chroma; use sharps.
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _score_key(chroma_vec):
    """Krumhansl-Schmuckler over all 24 keys for one chroma vector. Returns
    (camelot_code, separation, tonic_pc, mode) — separation (best - 2nd best
    correlation, 0..1-ish) is a rough confidence; mode is 'major'/'minor'."""
    scores = []  # (corr, camelot, tonic_pc, mode)
    for tonic in range(12):
        rotated = [chroma_vec[(tonic + i) % 12] for i in range(12)]
        scores.append((_pearson(MAJOR_PROFILE, rotated), MAJOR_CAMELOT[tonic], tonic, "major"))
        scores.append((_pearson(MINOR_PROFILE, rotated), MINOR_CAMELOT[tonic], tonic, "minor"))
    scores.sort(reverse=True, key=lambda s: s[0])
    best_corr, best_code, tonic_pc, mode = scores[0]
    separation = max(0.0, min(1.0, best_corr - scores[1][0]))
    return best_code, separation, tonic_pc, mode


def estimate_key(chroma_mean):
    """Whole-window key as (camelot_code, separation), for the scalar field."""
    code, separation, _tonic, _mode = _score_key(chroma_mean)
    return code, separation


def estimate_key_ranges(chroma, sr, librosa, window_s=10.0):
    """Per-region key (tonic + mode) over time. Windows the already-computed
    chroma (~window_s each), scores
    each, and merges adjacent windows sharing a key. Returns
    [{startMs,endMs,tonic,mode}] or None. Best-effort: any failure → None."""
    import numpy as np

    try:
        hop = 512
        n_frames = chroma.shape[1]
        if n_frames < 8:
            return None
        frames_per_win = max(1, int(round(window_s * sr / hop)))
        ranges = []
        for start in range(0, n_frames, frames_per_win):
            chunk = chroma[:, start : start + frames_per_win]
            if chunk.shape[1] == 0:
                continue
            vec = [float(x) for x in np.mean(chunk, axis=1)]
            _code, _sep, tonic_pc, mode = _score_key(vec)
            tonic = PITCH_NAMES[tonic_pc]
            start_ms = int(round(start * hop / sr * 1000.0))
            end_ms = int(round(min(start + frames_per_win, n_frames) * hop / sr * 1000.0))
            if end_ms <= start_ms:
                continue
            if ranges and ranges[-1]["tonic"] == tonic and ranges[-1]["mode"] == mode:
                ranges[-1]["endMs"] = end_ms  # merge a run of the same key
            else:
                ranges.append({"startMs": start_ms, "endMs": end_ms, "tonic": tonic, "mode": mode})
        return ranges or None
    except Exception as e:  # noqa: BLE001 — key ranges are best-effort
        log(f"key-range estimation failed: {e}")
        return None


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


def estimate_sections(y, sr, librosa, chroma=None):
    """Coarse structural segmentation over the DECODED window (the first
    ANALYZE_SECONDS only — so this is reliable for the intro / leading sections,
    not a full-song outro). librosa agglomerative clustering on a chroma+MFCC
    feature stack → a handful of contiguous {startMs,endMs} spans. Best-effort:
    any failure returns None and the field is omitted, so a
    consumer treats absence as 'no structure, behave as today'. `chroma` may be
    passed in to avoid recomputing the (expensive) CQT done in analyze()."""
    import numpy as np

    try:
        hop = 512  # librosa default for chroma_cqt / mfcc; ties frames→time
        if chroma is None:
            chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
        mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop)
        # Trim to a common frame count (CQT vs mel framing can differ by one).
        n_frames = min(chroma.shape[1], mfcc.shape[1])
        if n_frames < 8:
            return None
        feat = np.vstack([
            librosa.util.normalize(chroma[:, :n_frames], axis=0),
            librosa.util.normalize(mfcc[:, :n_frames], axis=0),
        ])
        dur_s = n_frames * hop / sr
        # ~1 section per 15s of decoded audio, clamped to a sane 2..8.
        k = int(max(2, min(8, round(dur_s / 15.0))))
        if k >= n_frames:
            return None
        # Left-boundary frames of each segment; always includes 0.
        bounds = librosa.segment.agglomerative(feat, k)
        times = librosa.frames_to_time(bounds, sr=sr, hop_length=hop)
        edges = [float(t) for t in times] + [dur_s]
        sections = []
        for i in range(len(edges) - 1):
            start_ms = int(round(edges[i] * 1000.0))
            end_ms = int(round(edges[i + 1] * 1000.0))
            if end_ms > start_ms:
                sections.append({"startMs": start_ms, "endMs": end_ms})
        return sections or None
    except Exception as e:  # noqa: BLE001 — structure is best-effort
        log(f"structure segmentation failed: {e}")
        return None


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
        self.text_model = None  # lazy text tower for onnx mode

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

    def _resolve_text_model(self):
        """The CLAP text tower. In transformers mode it's the loaded ClapModel;
        in onnx mode the on-disk export is the AUDIO encoder only, so the text
        tower is lazily loaded via ClapTextModelWithProjection (torch required
        — a lean venv without torch raises here and the caller degrades)."""
        if self.mode == "transformers":
            return self.model
        if self.text_model is None:
            from transformers import ClapTextModelWithProjection

            hf_id = os.environ.get("CLAP_MODEL", "").strip() or "laion/clap-htsat-unfused"
            feat_id = os.environ.get("CLAP_FEATURE_MODEL", "").strip() or hf_id
            m = ClapTextModelWithProjection.from_pretrained(feat_id)
            m.eval()
            self.text_model = m
            log(f"CLAP text tower loaded: {feat_id}")
        return self.text_model

    def embed_texts(self, texts):
        """CLAP text-tower embeddings — 512-d, L2-normalised, in the SAME space
        as the audio vectors (CLAP is trained contrastively on audio–text
        pairs), so cosine against stored audio vectors is meaningful. Powers
        natural-language "sounds like ..." search and zero-shot mood scoring."""
        import numpy as np
        import torch

        model = self._resolve_text_model()
        inputs = self.processor(text=list(texts), return_tensors="pt", padding=True)
        with torch.no_grad():
            emb = model.get_text_features(**inputs) if hasattr(model, "get_text_features") \
                else model(**inputs)
        # transformers ≤4.x returns the projected tensor directly; 5.x wraps it
        # (text_embeds on the projection model, pooler_output on ClapModel).
        if hasattr(emb, "text_embeds"):
            emb = emb.text_embeds
        elif hasattr(emb, "pooler_output"):
            emb = emb.pooler_output
        arr = np.asarray(emb.cpu().numpy(), dtype=np.float64)
        if arr.ndim == 1:
            arr = arr.reshape(1, -1)
        if arr.shape[1] != CLAP_EMBED_DIM:
            raise RuntimeError(
                f"unexpected CLAP text embedding dim {arr.shape[1]} (want {CLAP_EMBED_DIM})"
            )
        out = []
        for row in arr:
            n = float(np.linalg.norm(row))
            out.append([float(x) for x in (row / n if n > 0 else row)])
        return out


def clap_window_offsets(duration_s, window_s, max_windows=None):
    """Start offsets (seconds) of the CLAP embed windows. Short tracks keep the
    single leading window; longer tracks add a mid-song window, and genuinely
    long ones a late (~80%) window, so the vector reflects the whole track.
    `max_windows` (default CLAP_WINDOWS / ANALYZE_CLAP_WINDOWS, clamped 1..3)
    caps the count — 1 restores the old leading-window-only behaviour."""
    n = CLAP_WINDOWS if max_windows is None else max_windows
    n = max(1, min(3, n))
    if n == 1 or not duration_s or duration_s <= window_s * 1.5:
        return [0.0]
    span = duration_s - window_s
    offsets = [0.0, span * 0.5]
    if n >= 3 and duration_s >= window_s * 3.0:
        offsets.append(span * 0.8)
    return offsets


def embed_windows(embedder, path, librosa, duration_s):
    """CLAP embedding averaged over up to three windows spread across the track
    (start / middle / late), mean + L2-renormalised. A single leading window
    misrepresents any track whose intro doesn't sound like the song (a quiet
    build-up embeds as ambient); averaging windows fixes that with the same
    model, dim and storage schema. The local file may be byte-capped
    (fetch_audio / the controller's downloadCapped truncate), so its real
    decodable length can be shorter than the header duration — a non-leading
    window that decodes to under ~5s is skipped, and the worst case degrades to
    exactly the old leading-window behaviour. `duration_s` is the caller's
    header-duration probe (0.0 = unknown → leading window only)."""
    import numpy as np

    vecs = []
    for offset in clap_window_offsets(duration_s, ANALYZE_SECONDS):
        try:
            y48, _sr48 = librosa.load(
                path, sr=CLAP_SR, mono=True, offset=offset, duration=ANALYZE_SECONDS
            )
        except Exception as e:  # noqa: BLE001 — a bad window never kills the embed
            log(f"CLAP window decode at {offset:.0f}s failed: {e}")
            continue
        if y48 is None or len(y48) == 0:
            continue
        if offset > 0 and len(y48) < CLAP_SR * 5:
            continue  # truncated tail of a byte-capped download
        vecs.append(np.asarray(embedder.embed(y48, CLAP_SR), dtype=np.float64))
    if not vecs:
        return None
    mean = np.mean(vecs, axis=0)
    norm = float(np.linalg.norm(mean))
    if norm > 0:
        mean = mean / norm
    return [float(x) for x in mean]


def analyze_outro(path, librosa, duration_s):
    """Tail features for the crossfade seam — the outgoing track's ending is
    what actually decides whether a transition lands. Decodes the last
    OUTRO_SECONDS and returns
      {startMs, ending: 'fade'|'cold', lufs?, bpm?, beats?, bars?}
    with all timestamps ABSOLUTE (offset by the tail's position), or None when
    the track is too short / the tail decodes short (a truncated file's "tail"
    is mid-song audio — never emit features measured off the wrong region).
    Pure librosa (+ optional pyloudnorm), so this runs on the LEAN tier too."""
    import numpy as np

    if not duration_s or duration_s <= OUTRO_SECONDS + 1.0:
        return None  # too short to have a distinct outro
    offset = max(0.0, duration_s - OUTRO_SECONDS)
    # Channel-preserving decode for the loudness meter (the tail LUFS must be
    # comparable to the body's stereo loudness_lufs — issue #998); RMS shape
    # and the beat grid work off the mono downmix as before.
    y_src, sr = librosa.load(path, sr=ANALYZE_SR, mono=False, offset=offset)
    y = librosa.to_mono(y_src) if y_src is not None else None
    # Validation backstop for an unknown completeness: a truncated file either
    # errors here or decodes well short of the requested tail — skip it.
    if y is None or len(y) < ANALYZE_SR * OUTRO_SECONDS * 0.6:
        return None

    hop = 512
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    if rms.size == 0:
        return None
    loud = float(np.percentile(rms, 95))
    if loud <= 0:
        return None
    times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=hop)

    # Wind-down start: the LAST time the tail sits at full level (≥60% of its
    # own loud reference) — everything after it is the ending. A tail that
    # holds level to the end winds down at the very end (cold).
    thr_hi = 0.6 * loud
    last_loud = None
    for i in range(rms.size - 1, -1, -1):
        if rms[i] >= thr_hi:
            last_loud = i
            break
    wind_start_s = offset if last_loud is None else offset + float(times[last_loud])
    wind_span_s = max(0.0, duration_s - wind_start_s)

    # Ending type: a fade lands near-silent (final ~1.5s well below the tail's
    # loud level) after a real decline (≥3s wind-down); everything else — a hit,
    # a ring-out, a hard stop — reads as cold for transition purposes.
    tail_frames = max(1, int(1.5 * sr / hop))
    end_level = float(np.mean(rms[-tail_frames:]))
    ending = "fade" if (end_level < 0.15 * loud and wind_span_s >= 3.0) else "cold"

    # Tail loudness — comparable to the track's loudness_lufs, so consumers can
    # judge how hot the material under the next intro will actually be.
    lufs, _peak = measure_loudness(y_src, sr)

    # Tail tempo + grid (absolute ms) — the truer anchor for bar-aligning the
    # exit than the leading window's tempo (outros drift/ritard).
    bpm_t = None
    beats_ms = []
    bars_ms = []
    try:
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        t = float(np.atleast_1d(tempo)[0])
        bpm_t = round(t, 1) if 30 <= t <= 300 else None
        bt = librosa.frames_to_time(beat_frames, sr=sr)
        beats_ms = [int(round((offset + float(x)) * 1000.0)) for x in bt]
        bars_ms = beats_ms[::4]
    except Exception as e:  # noqa: BLE001 — the grid is garnish, never a gate
        log(f"outro beat grid failed: {e}")

    out = {"startMs": int(round(wind_start_s * 1000.0)), "ending": ending}
    if lufs is not None:
        out["lufs"] = lufs
    if bpm_t is not None:
        out["bpm"] = bpm_t
    if beats_ms:
        out["beats"] = beats_ms
    if bars_ms:
        out["bars"] = bars_ms
    return out


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


# ---------------------------------------------------------------------------
# Vocal-activity detector — Demucs source separation → vocal energy envelope →
# present/absent time ranges. All heavy imports (torch, demucs) are lazy so a
# worker with vocal activity DISABLED never needs them and the librosa-only venv
# keeps working. Same degrade-never-crash contract as the CLAP embedder.
# ---------------------------------------------------------------------------
class VocalActivityDetector:
    def __init__(self):
        self.model = None
        self.sources = None  # stem order, e.g. ['drums','bass','other','vocals']

    def load(self):
        from demucs.pretrained import get_model

        self.model = get_model(DEMUCS_MODEL)
        self.model.eval()
        self.sources = list(self.model.sources)
        if "vocals" not in self.sources:
            raise RuntimeError(f"demucs model {DEMUCS_MODEL} has no 'vocals' stem")

    def separate(self, stereo):
        """stereo: float32 array shaped (2, N) at DEMUCS_SR. One apply_model
        pass → {stem_name: float32 ndarray (channels, N)} for all model stems
        (drums/bass/other/vocals for htdemucs). The single separation is
        shared by vocal-activity detection AND the stem cache (feature:
        stem-blend transitions) — never run Demucs twice on one window."""
        import numpy as np
        import torch

        wav = torch.from_numpy(np.ascontiguousarray(stereo, dtype=np.float32))
        if wav.ndim == 1:
            wav = wav.unsqueeze(0).repeat(2, 1)
        from demucs.apply import apply_model

        with torch.no_grad():
            est = apply_model(self.model, wav.unsqueeze(0), device="cpu")[0]
        return {
            name: est[i].cpu().numpy()
            for i, name in enumerate(self.sources)
        }

    def detect(self, stereo, sr, librosa, min_loud=0.0, stems=None):
        """stereo: float32 array shaped (2, N) at DEMUCS_SR. Returns a list of
        {startMs,endMs} where the isolated vocal stem is active — possibly empty
        (an instrumental). Raises on failure; the caller degrades to None.
        `min_loud` is an absolute RMS floor on the stem's loud reference: the
        relative threshold below self-scales, so a window that is pure
        separation bleed (a vocal-free fading outro) would otherwise emit
        artefact ranges — the floor turns those into a clean []. 0.0 = off
        (the head window keeps its historical behaviour).
        `stems` (optional): a pre-computed separate() result for this window,
        so a caller that also caches stems pays for one separation, not two."""
        import numpy as np

        if stems is None:
            stems = self.separate(stereo)
        vocals = stems["vocals"].mean(axis=0)

        # RMS envelope of the vocal stem, thresholded against its own loud level
        # (40th-pct of the loud half) — robust to overall mix level. Frames where
        # vocal energy sustains above threshold become "vocal present" ranges,
        # merging gaps shorter than ~0.4s so a breath doesn't split a phrase.
        hop = 512
        rms = librosa.feature.rms(y=vocals, frame_length=2048, hop_length=hop)[0]
        if rms.size == 0:
            return []
        loud = float(np.percentile(rms, 90))
        if loud <= min_loud:
            return []
        thr = 0.15 * loud
        times = librosa.frames_to_time(np.arange(rms.size), sr=sr, hop_length=hop)
        active = rms >= thr
        ranges = []
        merge_gap_ms = 400
        i = 0
        n = rms.size
        while i < n:
            if not active[i]:
                i += 1
                continue
            j = i
            while j + 1 < n and active[j + 1]:
                j += 1
            start_ms = int(round(float(times[i]) * 1000.0))
            end_ms = int(round(float(times[min(j + 1, n - 1)]) * 1000.0))
            if ranges and start_ms - ranges[-1]["endMs"] <= merge_gap_ms:
                ranges[-1]["endMs"] = end_ms
            else:
                ranges.append({"startMs": start_ms, "endMs": end_ms})
            i = j + 1
        # Drop sub-300ms blips (separation artefacts, not sung lines).
        return [r for r in ranges if r["endMs"] - r["startMs"] >= 300]


def estimate_pace(y, sr, librosa, window_s=5.0):
    """Perceptual energy/momentum curve over the decoded window, decoupled from
    BPM (a high-tempo track can read low pace during a sparse breakdown). Mean
    onset-strength (spectral-flux) energy per ~window_s window, normalised 0..1
    by the loudest window. Span shape: [{startMs,endMs,value}]. Best-
    effort: any failure returns None and the field is omitted."""
    import numpy as np

    try:
        hop = 512
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
        if onset_env.size == 0:
            return None
        frames_per_win = max(1, int(round(window_s * sr / hop)))
        peak = float(np.max(onset_env))
        if peak <= 0:
            return None
        curve = []
        for start in range(0, onset_env.size, frames_per_win):
            chunk = onset_env[start : start + frames_per_win]
            if chunk.size == 0:
                continue
            value = round(float(np.mean(chunk)) / peak, 3)
            start_ms = int(round(start * hop / sr * 1000.0))
            end_ms = int(round(min(start + frames_per_win, onset_env.size) * hop / sr * 1000.0))
            if end_ms > start_ms:
                curve.append({"startMs": start_ms, "endMs": end_ms, "value": value})
        return curve or None
    except Exception as e:  # noqa: BLE001 — pace is best-effort
        log(f"pace estimation failed: {e}")
        return None


_vocal_detector = None
_vocal_failed = False


def get_vocal_detector(force=False):
    global _vocal_detector, _vocal_failed
    if _vocal_failed or not (VOCAL_ENABLED or force):
        return None
    if _vocal_detector is None:
        try:
            d = VocalActivityDetector()
            d.load()
            _vocal_detector = d
        # BaseException, not Exception: demucs' fatal() raises SystemExit on an
        # unusable model (e.g. a *_q quantized checkpoint without diffq), which
        # sails past `except Exception` and killed the whole worker — every
        # later request (bpm/key included) then 500'd "worker not ready".
        except BaseException as ex:  # noqa: BLE001 — degrade, never crash the worker
            log(f"Demucs load failed ({ex or type(ex).__name__}); vocal activity disabled for this run")
            _vocal_failed = True
            return None
    return _vocal_detector


def write_stems(stems, window, dest_dir):
    """Persist a separate() result as 16-bit FLAC at DEMUCS_SR into dest_dir
    as <window>-<stem>.flac (feature: stem-blend transitions — the cache that
    makes transition renders a fast mix instead of a fresh separation).
    tmp+rename per file so a crashed write never leaves a truncated stem for
    the render op to trust. Raises on failure; callers degrade."""
    import soundfile as sf

    os.makedirs(dest_dir, exist_ok=True)
    for name, data in stems.items():
        path = os.path.join(dest_dir, f"{window}-{name}.flac")
        tmp = path + ".tmp"
        sf.write(tmp, data.T, DEMUCS_SR, subtype="PCM_16", format="FLAC")
        os.replace(tmp, path)


def write_tail_meta(dest_dir, tail_start_s, duration_s):
    """Alignment sidecar for the cached tail stems. The tail window was cut at
    DECODED duration - OUTRO_SECONDS; render_transition must slice the bar
    grid against that exact offset. Re-deriving it from the library's tagged
    duration (an integer from Subsonic) disagrees by up to ~1s, which shifts
    the borrowed drum loop off the downbeat — so the true offset rides with
    the stems and a render without it is a clean cache miss."""
    path = os.path.join(dest_dir, "tail-meta.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({
            "tail_start_sec": round(float(tail_start_s), 3),
            "duration_sec": round(float(duration_s), 3),
        }, f)
    os.replace(tmp, path)


def render_transition(req):
    """Pre-rendered stem-blend transition (feature: stem-blend transitions —
    docs/stem-transitions-research.md Option B). Mixes the OUTGOING track's
    cached tail stems with the INCOMING track's cached head stems into one
    WAV that airs between them: [out cue_out at blend_start] → clip → [in
    cue_in at in_cue]. CACHE-HIT-ONLY by design — this runs inside the drain
    deadline window, so it must be a fast mix, never a fresh separation; any
    missing stem file is a clean {ok:false} and the controller falls back to
    a plain pair-aware crossfade.

    v1 preset — "beat carry": the outgoing track's last full-energy bar of
    drums (chosen from its measured tail bar grid, before the wind-down)
    keeps looping under the incoming track's opening bars, retriggered on
    the INCOMING grid so the borrowed groove locks to the new tempo; the
    incoming drums drop in hard on a downbeat; two full-mix bars later the
    clip hands off to the real track. blend_start lands on the END of the
    loop source bar, so the loop audibly continues the bar the listener
    just heard — the cut reads as a DJ move, not an edit."""
    import numpy as np
    import soundfile as sf

    out_spec = req.get("out") or {}
    in_spec = req.get("in") or {}
    out_dir = req.get("out_dir")
    clip_name = req.get("clip_name") or "transition.wav"
    target_lufs = req.get("target_lufs")
    if not out_dir or not out_spec.get("stems_dir") or not in_spec.get("stems_dir"):
        return {"ok": False, "error": "missing out/in stems_dir or out_dir"}

    stem_names = ("drums", "bass", "other", "vocals")

    def load_window(stems_dir, window):
        stems = {}
        for name in stem_names:
            p = os.path.join(stems_dir, f"{window}-{name}.flac")
            if not os.path.exists(p):
                return None
            data, sr_f = sf.read(p, dtype="float32", always_2d=True)  # (N, ch)
            if sr_f != DEMUCS_SR or data.shape[0] == 0:
                return None
            stems[name] = data
        return stems

    tail = load_window(out_spec["stems_dir"], "tail")
    head = load_window(in_spec["stems_dir"], "head")
    if tail is None or head is None:
        return {"ok": False, "error": "stems-missing"}

    sr = DEMUCS_SR
    # Alignment comes from the meta sidecar written WITH the stems (decoded
    # duration + the exact tail offset) — never from out_spec's duration_s,
    # which is the library's tagged integer and can sit ~1s off the decoded
    # timeline the bar grid was measured on. Stems without the sidecar (an
    # older cache) are a clean miss; a re-analysis pass refreshes them.
    try:
        with open(os.path.join(out_spec["stems_dir"], "tail-meta.json")) as f:
            tail_meta = json.load(f)
        tail_start_s = float(tail_meta["tail_start_sec"])
        dur_s = float(tail_meta["duration_sec"])
    except Exception:
        return {"ok": False, "error": "stems-meta-missing"}
    if dur_s <= OUTRO_SECONDS + 1.0 or tail_start_s < 0.0:
        return {"ok": False, "error": "out-track-too-short"}

    def to_stereo(x, n):
        """First n samples as (n, 2) float32, zero-padded if short."""
        a = x[:n]
        if a.shape[1] == 1:
            a = np.repeat(a, 2, axis=1)
        a = a[:, :2]
        if a.shape[0] < n:
            a = np.vstack([a, np.zeros((n - a.shape[0], 2), np.float32)])
        return a

    # --- Outgoing side: the drum-loop source bar + the blend start --------
    outro = out_spec.get("outro") or {}
    out_bars = [b / 1000.0 for b in (outro.get("bars") or [])]
    wind_down_s = float(outro.get("start_ms") or (dur_s - 10.0) * 1000.0) / 1000.0
    usable = [
        (b1, b2)
        for b1, b2 in zip(out_bars, out_bars[1:])
        if b1 >= tail_start_s + 0.05 and b2 <= min(wind_down_s, dur_s) and 0.4 < (b2 - b1) < 4.0
    ]
    if not usable:
        return {"ok": False, "error": "no-usable-out-bar"}
    loop_b1, loop_b2 = usable[-1]  # last full-energy bar before the wind-down
    blend_start_s = loop_b2        # out cue_out lands on this bar boundary
    i1 = int((loop_b1 - tail_start_s) * sr)
    i2 = int((loop_b2 - tail_start_s) * sr)
    drum_loop = to_stereo(tail["drums"], tail["drums"].shape[0])[i1:i2]
    if drum_loop.shape[0] < sr // 8:
        return {"ok": False, "error": "loop-too-short"}

    # --- Incoming side: bar grid, carry region, hand-off point ------------
    CARRY_BARS = 4       # bars of borrowed groove under the new intro
    TAIL_FULL_BARS = 2   # full-mix bars after the drop before the decoder hand-off
    in_bars = [b / 1000.0 for b in (in_spec.get("bars") or []) if 0.0 <= b / 1000.0 <= ANALYZE_SECONDS - 1.0]
    if len(in_bars) < CARRY_BARS + TAIL_FULL_BARS + 1:
        return {"ok": False, "error": "no-in-grid"}
    carry_end_s = in_bars[CARRY_BARS]
    in_cue_s = in_bars[CARRY_BARS + TAIL_FULL_BARS]
    head_len_s = min(h.shape[0] for h in head.values()) / sr
    if in_cue_s > head_len_s - 0.25:
        return {"ok": False, "error": "cue-past-window"}

    n = int(in_cue_s * sr)
    if n <= sr:  # a sub-second clip means the grids are degenerate
        return {"ok": False, "error": "clip-too-short"}

    # --- Per-source gains toward the station target (before summing, so the
    # borrowed loop and the new track each land at their own corrected level;
    # the brick-wall limiter upstream only ever sees sane material) ---------
    def gain_toward(lufs):
        if target_lufs is None or not isinstance(lufs, (int, float)):
            return 1.0
        g = 10.0 ** ((float(target_lufs) - float(lufs)) / 20.0)
        return float(min(4.0, max(0.25, g)))  # ±12 dB sanity clamp

    g_in = gain_toward(in_spec.get("lufs"))
    g_out = gain_toward(out_spec.get("lufs")) * (10.0 ** (-3.0 / 20.0))  # loop sits under the new track

    # --- Mix ---------------------------------------------------------------
    mix_buf = np.zeros((n, 2), dtype=np.float32)
    for name in ("bass", "other", "vocals"):
        mix_buf += to_stereo(head[name], n) * g_in
    dstart = int(carry_end_s * sr)
    head_drums = to_stereo(head["drums"], n) * g_in
    mix_buf[dstart:] += head_drums[dstart:]  # incoming beat drops on the downbeat

    loop_len = drum_loop.shape[0]
    for k in range(CARRY_BARS):
        b1 = int(in_bars[k] * sr)
        b2 = min(int(in_bars[k + 1] * sr), n)
        m = b2 - b1
        if m <= 0:
            continue
        reps = int(np.ceil(m / loop_len))
        piece = np.tile(drum_loop, (reps, 1))[:m] * g_out  # wrap, never a gap
        if k == CARRY_BARS - 1:  # ride out over the last carry bar
            piece = piece * np.linspace(1.0, 0.0, m, dtype=np.float32)[:, None]
        mix_buf[b1:b2] += piece

    # Peak safety toward the bus limiter's comfort zone, then 10ms edge
    # declicks (the clip meets its neighbours through ~0.3s crossfades, but a
    # hard first/last sample still clicks through them).
    peak = float(np.max(np.abs(mix_buf)))
    ceiling = 10.0 ** (-1.0 / 20.0)
    if peak > ceiling:
        mix_buf *= ceiling / peak
    e = max(1, int(0.01 * sr))
    ramp = np.linspace(0.0, 1.0, e, dtype=np.float32)[:, None]
    mix_buf[:e] *= ramp
    mix_buf[-e:] *= ramp[::-1]

    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, os.path.basename(clip_name))
    tmp = out_path + ".tmp"
    sf.write(tmp, mix_buf, sr, subtype="PCM_16", format="WAV")
    os.replace(tmp, out_path)
    return {
        "ok": True,
        "path": out_path,
        "blend_start_sec": round(blend_start_s, 3),
        "in_cue_sec": round(in_cue_s, 3),
        "clip_sec": round(n / sr, 3),
    }


def fetch_audio(url):
    """Download (capped) to a temp file. Returns (path, complete) — `complete`
    is False when the byte cap truncated the download, which vetoes outro
    analysis (the file's "tail" would be mid-song audio)."""
    suffix = ".audio"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="swanalyze_")
    os.close(fd)
    req = urllib.request.Request(url, headers={"User-Agent": "subwave-analyzer/1"})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp, open(path, "wb") as out:
        # Cap the download so we don't pull whole albums of bytes for a
        # 120-second analysis window — ~3 MB covers 2 min of most codecs.
        max_bytes = int(os.environ.get("ANALYZE_MAX_BYTES", "").strip() or str(12 * 1024 * 1024))
        read = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            out.write(chunk)
            read += len(chunk)
            if read >= max_bytes:
                break
    return path, read < max_bytes


def measure_loudness(y, sr):
    """Integrated loudness (LUFS, ITU-R BS.1770 / EBU R128) + true-ish peak in
    dBFS over the decoded window. Accepts mono (n,) or librosa's multichannel
    (channels, n) — pass the STEREO decode when available: BS.1770 sums the
    energy of both channels, so the old mono average under-read center-heavy
    mixes by up to ~3 dB and every gain computed from it aired that much hot
    (issue #998). Best-effort: pyloudnorm is an optional dep, so a missing
    import or any failure returns (None, None) and the caller simply omits the
    fields — every consumer treats NULL as "no loudness, behave as today"
    (same contract as the CLAP embedding)."""
    import numpy as np

    try:
        import pyloudnorm as pyln
    except Exception as e:  # noqa: BLE001 — optional dependency
        log(f"pyloudnorm unavailable, skipping loudness: {e}")
        return None, None

    try:
        meter = pyln.Meter(sr)  # BS.1770 meter at the decode sample rate
        # pyloudnorm wants (samples,) or (samples, channels); librosa decodes
        # multichannel as (channels, samples).
        data = y.T if getattr(y, "ndim", 1) > 1 else y
        lufs = float(meter.integrated_loudness(data))
        peak = float(np.max(np.abs(y))) if np.size(y) else 0.0
        peak_db = 20.0 * float(np.log10(peak)) if peak > 0 else None
        # integrated_loudness returns -inf for digital silence; treat as no signal.
        if not np.isfinite(lufs):
            return None, peak_db
        return round(lufs, 2), (round(peak_db, 2) if peak_db is not None else None)
    except Exception as e:  # noqa: BLE001 — loudness is best-effort
        log(f"loudness measurement failed: {e}")
        return None, None


def analyze(librosa, url=None, path=None, embed=None, vocal=None, complete=None, stems_dir=None):
    import numpy as np

    # A controller-provided path is pre-fetched onto the shared volume and
    # owned by the caller; only files fetch_audio downloads here are ours to
    # remove. Keeps the url path behaviour identical for back-compat.
    # `complete` says whether `path` holds the WHOLE file (the controller's
    # downloadCapped knows; our own fetch_audio determines it for url requests).
    # None = unknown (old caller) → outro analysis still runs, relying on its
    # decode-length validation; False = definitively truncated → skipped.
    owned = path is None
    if owned:
        path, complete = fetch_audio(url)
    audio_embedding = None
    vocal_ranges = None
    outro = None
    try:
        # One header-duration probe shared by the CLAP windows and the outro
        # tail (both need to know where the file ends). 0.0 = unknown.
        try:
            duration_s = float(librosa.get_duration(path=path))
        except Exception as e:  # noqa: BLE001 — degrade to leading-window/no-outro
            log(f"duration probe failed ({e})")
            duration_s = 0.0

        # Decode once WITH channels (a mono file still comes back 1-D): the
        # loudness meter needs real stereo for a correct BS.1770 channel sum
        # (issue #998); every other feature works off the mono downmix.
        y_src, sr = librosa.load(path, sr=ANALYZE_SR, mono=False, duration=ANALYZE_SECONDS)
        y = librosa.to_mono(y_src)
        # CLAP wants 48 kHz mono — decode fresh copies at that rate from the
        # SAME file (still present here, before the finally removes owned
        # temps), windowed across the track (see embed_windows). A model/
        # feature failure on one track never fails the whole analyze: we log
        # and emit bpm/key without the embedding.
        # Per-request `embed` wins over the env default in the ON direction
        # only: True forces a (lazy) CLAP load, None/absent keeps the env-driven
        # behaviour. False is never sent by the controller today.
        embedder = None if embed is False else get_embedder(force=embed is True)
        if embedder is not None:
            try:
                audio_embedding = embed_windows(embedder, path, librosa, duration_s)
            except Exception as e:  # noqa: BLE001 — embedding is best-effort
                log(f"audio embedding failed: {e}")
                audio_embedding = None
        # Outro (tail) features — only meaningful off a complete file; a
        # byte-capped download's "tail" is mid-song. Best-effort like the rest.
        if complete is not False:
            try:
                outro = analyze_outro(path, librosa, duration_s)
            except Exception as e:  # noqa: BLE001 — outro is best-effort
                log(f"outro analysis failed: {e}")
                outro = None
        # Vocal activity — Demucs wants 44.1 kHz stereo; decode a third copy from
        # the same file. Gated like CLAP (per-request `vocal` forces the load).
        # Best-effort: a failure leaves vocal_ranges None (field omitted). A
        # successful run with no detected vocals emits [] — the distinct "empty"
        # value tells the controller this track WAS analysed (an instrumental),
        # so the backfill scope doesn't keep re-targeting it.
        # A stems_dir request implies separation even when vocal detection
        # wasn't asked for — the stem cache and vocal ranges share one
        # apply_model pass per window. Explicit vocal=False still wins.
        detector = None if vocal is False else get_vocal_detector(force=vocal is True or bool(stems_dir))
        stems_cached = None
        if detector is not None:
            try:
                ys, _srs = librosa.load(
                    path, sr=DEMUCS_SR, mono=False, duration=ANALYZE_SECONDS
                )
                if ys is not None and np.size(ys) > 0:
                    head_stems = detector.separate(ys)
                    vocal_ranges = detector.detect(ys, DEMUCS_SR, librosa, stems=head_stems)
                    if stems_dir:
                        try:
                            write_stems(head_stems, "head", stems_dir)
                            stems_cached = True
                        except Exception as e:  # noqa: BLE001 — cache is best-effort
                            log(f"stem cache write (head) failed: {e}")
                            stems_cached = False
            except Exception as e:  # noqa: BLE001 — vocal activity is best-effort
                log(f"vocal activity failed: {e}")
                vocal_ranges = None
        # Tail vocal activity (feature: vocal-aware transitions) — the outro
        # window gets its own Demucs pass so transitions know whether the
        # ENDING is sung (the head pass above never sees the last 20s of a
        # normal-length track). Gated on the same detector AND a computed
        # outro: outro non-None already proves the file is complete and long
        # enough for a distinct tail. Spans are shifted to ABSOLUTE ms like
        # the outro's beat grid; [] = analysed instrumental tail, mirroring
        # the head semantics. The RMS floor guards against separation bleed
        # on a fading outro reading as artefact "vocals" (~-40 dBFS: genuine
        # sung tails sit well above it, bleed well below).
        if detector is not None and outro is not None:
            try:
                tail_offset = max(0.0, duration_s - OUTRO_SECONDS)
                y_tail, _srt = librosa.load(
                    path, sr=DEMUCS_SR, mono=False,
                    offset=tail_offset, duration=OUTRO_SECONDS,
                )
                if y_tail is not None and np.size(y_tail) > 0:
                    tail_stems = detector.separate(y_tail)
                    tail_vocals = detector.detect(
                        y_tail, DEMUCS_SR, librosa, min_loud=0.01, stems=tail_stems
                    )
                    if stems_dir:
                        try:
                            write_stems(tail_stems, "tail", stems_dir)
                            write_tail_meta(stems_dir, tail_offset, duration_s)
                        except Exception as e:  # noqa: BLE001 — cache is best-effort
                            log(f"stem cache write (tail) failed: {e}")
                    shift_ms = tail_offset * 1000.0
                    outro["vocalRanges"] = [
                        {
                            "startMs": int(round(r["startMs"] + shift_ms)),
                            "endMs": int(round(r["endMs"] + shift_ms)),
                        }
                        for r in tail_vocals
                    ]
            except Exception as e:  # noqa: BLE001 — tail vocals are best-effort
                log(f"tail vocal activity failed: {e}")
    finally:
        if owned:
            try:
                os.remove(path)
            except OSError:
                pass

    if y is None or len(y) == 0:
        raise RuntimeError("decoded empty audio")

    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0])

    # Per-beat timestamps (ms) — already computed by beat_track, previously
    # discarded. Downbeats are a 4/4 heuristic (every 4th beat from the first):
    # librosa gives no true downbeat, but a bar grid is enough to bar-align a
    # crossfade. Best-effort: an empty/odd grid simply yields fewer/no bars.
    beats_ms = []
    bars_ms = []
    try:
        bt = librosa.frames_to_time(beat_frames, sr=sr)
        beats_ms = [int(round(float(t) * 1000.0)) for t in bt]
        bars_ms = beats_ms[::4]
    except Exception as e:  # noqa: BLE001 — beat grid is best-effort
        log(f"beat grid failed: {e}")
        beats_ms = []
        bars_ms = []

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = [float(x) for x in np.mean(chroma, axis=1)]
    key, key_sep = estimate_key(chroma_mean)

    # Per-region key (tonic + mode) over time — reuses the chroma above.
    key_ranges = estimate_key_ranges(chroma, sr, librosa)

    intro_ms = estimate_intro_ms(y, sr, librosa)

    # When vocal activity was measured, the start of the first vocal range is a
    # truer intro than the energy heuristic (an instrumental intro is exactly
    # the vocal-free leading region). Prefer it; fall back to the heuristic for
    # instrumentals ([] → keep the energy estimate) and un-run tracks.
    if vocal_ranges:
        intro_ms = float(vocal_ranges[0]["startMs"])

    # Structural sections over the decoded window (intro/leading sections are
    # the reliable part — the outro of a long track is beyond ANALYZE_SECONDS).
    # Reuses the chroma already computed for key estimation.
    sections = estimate_sections(y, sr, librosa, chroma=chroma)

    # Perceptual energy/momentum curve (decoupled from BPM).
    pace = estimate_pace(y, sr, librosa)

    # Perceptual loudness (LUFS) over the decoded window — feeds per-track gain
    # normalisation toward a target on the playback side. Measured off the
    # channel-preserving decode, not the mono downmix (issue #998). None when
    # pyloudnorm is absent or measurement fails.
    loudness_lufs, peak_db = measure_loudness(y_src, sr)

    # Overall confidence: dominated by how cleanly the key resolved, nudged by
    # whether we got a plausible tempo. Kept conservative on purpose.
    confidence = round(0.5 * key_sep + (0.5 if 40 <= bpm <= 220 else 0.0), 3)

    result = {
        "bpm": round(bpm, 1),
        "key": key,
        "intro_ms": int(intro_ms) if intro_ms is not None else None,
        "confidence": confidence,
    }
    # Only carry loudness fields when measured — absence signals "no loudness
    # this pass", so a worker without pyloudnorm is byte-for-byte today.
    if loudness_lufs is not None:
        result["loudness_lufs"] = loudness_lufs
    if peak_db is not None:
        result["peak_db"] = peak_db
    # Structural sections (omit when segmentation produced nothing).
    if sections:
        result["sections"] = sections
    # Pace curve (omit when none produced).
    if pace:
        result["pace_curve"] = pace
    # Beat / bar grid (omit when empty).
    if beats_ms:
        result["beats"] = beats_ms
    if bars_ms:
        result["bars"] = bars_ms
    # Per-region key ranges (omit when none produced).
    if key_ranges:
        result["key_ranges"] = key_ranges
    # Outro (tail) features — omit when not computed (short/truncated file,
    # decode failure), so consumers treat absence as "no outro signal".
    if outro is not None:
        result["outro"] = outro
    # Vocal-activity ranges. Emit even when empty ([] = analysed instrumental);
    # omit only when detection didn't run (None), so the controller can tell
    # "no vocals" from "not computed".
    if vocal_ranges is not None:
        result["vocal_ranges"] = vocal_ranges
    # Only carry the embedding when we actually produced one — its absence is
    # how every downstream consumer knows to behave as today.
    if audio_embedding is not None:
        result["audio_embedding"] = audio_embedding
    # Stem-cache outcome (only when a stems_dir was requested): True = head
    # stems written (tail rides along when the outro was computable).
    if stems_cached is not None:
        result["stems_cached"] = stems_cached
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
    if VOCAL_ENABLED:
        log("ANALYZE_VOCAL_ACTIVITY on — loading Demucs model...")
        get_vocal_detector()

    # Tell the controller whether this worker can actually emit "sounds-like"
    # audio embeddings, so the admin UI can warn *before* a fruitless run rather
    # than after the fingerprint bar stays at 0. Capable = the CLAP libs are
    # present (image built WITH_CLAP=1) and we haven't already hit a hard load
    # failure. find_spec avoids importing torch when embeddings are off.
    audio_capable = (not _embed_failed) and (
        _embedder is not None
        or all(importlib.util.find_spec(m) is not None for m in ("torch", "transformers"))
    )
    # Same probe for vocal activity — the demucs + torch libs present (image
    # built WITH_DEMUCS=1) and no hard load failure yet.
    vocal_capable = (not _vocal_failed) and (
        _vocal_detector is not None
        or all(importlib.util.find_spec(m) is not None for m in ("torch", "demucs"))
    )
    # Text-tower probe: unlike onnx-mode audio (which runs without torch), the
    # text tower always needs torch + transformers, in both backend modes.
    text_capable = (not _embed_failed) and all(
        importlib.util.find_spec(m) is not None for m in ("torch", "transformers")
    )

    log("ready")
    emit({
        "id": None,
        "ready": True,
        "audio_embedding_capable": audio_capable,
        "vocal_activity_capable": vocal_capable,
        # Version signal as much as a capability: only workers that compute
        # tail vocal ranges (outro.vocalRanges) emit this key at all, so the
        # controller can gate the tail-vocal backfill widening on `=== true`
        # and a stale sidecar image never causes re-analysis churn.
        "tail_vocal_capable": vocal_capable,
        "text_embedding_capable": text_capable,
    })

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
        # Transition render (feature: stem-blend transitions) — dispatched by
        # op key; a pure mix of cached stems, seconds of CPU, no model.
        if req.get("op") == "render_transition":
            try:
                emit({"id": rid, **render_transition(req)})
            except Exception as e:  # noqa: BLE001 — one bad render never kills the worker
                emit({"id": rid, "ok": False, "error": str(e)})
            continue
        # Text-embedding request — {"texts": ["...", ...]} instead of url/path.
        # An explicit text request force-loads CLAP like embed:true does (the
        # caller asked for the shared audio-text space; env default irrelevant).
        texts = req.get("texts")
        if texts is not None:
            if (
                not isinstance(texts, list)
                or not texts
                or len(texts) > 64
                or not all(isinstance(t, str) and t.strip() for t in texts)
            ):
                emit({"id": rid, "ok": False, "error": "texts must be 1-64 non-empty strings"})
                continue
            embedder = get_embedder(force=True)
            if embedder is None:
                emit({"id": rid, "ok": False, "error": "CLAP unavailable (load failed or libs absent)"})
                continue
            try:
                emit({"id": rid, "ok": True, "text_embeddings": embedder.embed_texts(texts)})
            except Exception as e:  # noqa: BLE001 — one bad request never kills the worker
                emit({"id": rid, "ok": False, "error": str(e)})
            continue
        url = req.get("url")
        path = req.get("path")
        if not url and not path:
            emit({"id": rid, "ok": False, "error": "missing url or path"})
            continue
        try:
            import librosa

            result = analyze(
                librosa, url=url, path=path,
                embed=req.get("embed"), vocal=req.get("vocal"),
                complete=req.get("complete"), stems_dir=req.get("stems_dir"),
            )
            emit({"id": rid, "ok": True, **result})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
