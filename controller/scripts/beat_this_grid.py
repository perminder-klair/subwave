"""Beat This! ONNX inference shared by window and full-recording callers.

No worker settings, model lifetime, fallbacks or torch imports live here. Callers
choose their own failure policy. Preprocessing and postprocessing mirror the
pinned beat_this 1.1.0 pipeline; tools/beat-this/parity.py checks that contract.
"""
import hashlib
import math
import os

PREPROCESSING_VERSION = 1
SMALL0_SHA256 = "5cff50fb031bc4a43b036f0af4835cf60bf8d43e6ccc8a7e676ed89db53f6eaf"

BT_SR = 22050
BT_N_FFT = 1024
BT_HOP = 441        # 50 frames per second
BT_FPS = 50
BT_CHUNK = 1500     # frames per model call: upstream's training excerpt, 30 s
BT_BORDER = 6       # frames dropped from each chunk edge, overlapped instead


def bt_chunk_starts(n):
    """Chunk start frames for an n-frame spectrogram (split_piece with
    avoid_short_end): consecutive chunks overlap by the border, and the last
    one is pulled back to end at the piece's end."""
    import numpy as np

    starts = np.arange(-BT_BORDER, n - BT_BORDER, BT_CHUNK - 2 * BT_BORDER)
    if n > BT_CHUNK - 2 * BT_BORDER:
        starts[-1] = n - (BT_CHUNK - BT_BORDER)
    return [int(s) for s in starts]


def bt_chunk(spect, start):
    """The chunk at `start`, zero-padded as split_piece pads it: a start before
    zero pads the left, and the right edge gets at most one border."""
    import numpy as np

    n = len(spect)
    chunk = spect[max(start, 0):min(start + BT_CHUNK, n)]
    left = max(0, -start)
    right = max(0, min(BT_BORDER, start + BT_CHUNK - n))
    if left or right:
        chunk = np.pad(chunk, ((left, right), (0, 0)))
    return chunk


def bt_frame_logits(spect, run_chunk):
    """Framewise (beat, downbeat) logits for the whole spectrogram.
    `run_chunk(chunk)` maps one (T, 128) chunk to two (T,) logit arrays. Where
    chunks overlap the earlier one wins (upstream's keep_first)."""
    import numpy as np

    n = len(spect)
    beat = np.full(n, -1000.0, np.float32)
    down = np.full(n, -1000.0, np.float32)
    preds = [(s, *run_chunk(bt_chunk(spect, s))) for s in bt_chunk_starts(n)]
    for start, b, d in reversed(preds):
        lo = start + BT_BORDER
        hi = min(start + BT_CHUNK - BT_BORDER, n)
        beat[lo:hi] = b[BT_BORDER:-BT_BORDER][: hi - lo]
        down[lo:hi] = d[BT_BORDER:-BT_BORDER][: hi - lo]
    return beat, down


def bt_peak_frames(logits):
    """Frames whose logit is positive and the maximum within ±3 frames (70 ms),
    with each run of adjacent peaks collapsed to its running mean exactly as
    upstream's deduplicate_peaks does it (the mean, not the first frame)."""
    import numpy as np

    padded = np.pad(logits, 3, constant_values=-np.inf)
    window_max = np.lib.stride_tricks.sliding_window_view(padded, 7).max(axis=1)
    peaks = np.flatnonzero((logits == window_max) & (logits > 0))
    out = []
    p = None
    count = 0
    for p2 in (int(x) for x in peaks):
        if p is not None and p2 - p <= 1:
            count += 1
            p += (p2 - p) / count
        else:
            if p is not None:
                out.append(p)
            p = p2
            count = 1
    if p is not None:
        out.append(p)
    return np.asarray(out, dtype=np.float64)


def bt_beats_downbeats(beat_logits, down_logits):
    """(beats_s, downbeats_s): upstream's minimal postprocessing. Every
    downbeat is moved onto its nearest beat, so the bars are a subset of the
    beats, then duplicates are dropped."""
    import numpy as np

    beats = bt_peak_frames(beat_logits) / BT_FPS
    downs = bt_peak_frames(down_logits) / BT_FPS
    if len(beats) > 0:
        downs = np.asarray([beats[int(np.argmin(np.abs(beats - d)))] for d in downs])
    return beats, np.unique(downs)


class DownbeatTracker:
    def __init__(self, model_path, threads):
        self.model_path = model_path
        self.threads = threads
        self.session = None
        self.input_name = None
        self._fb = None
        self.model_sha256 = None

    def load(self):
        import onnxruntime as ort

        if not os.path.isfile(self.model_path):
            raise FileNotFoundError(f"no Beat This model at {self.model_path}")
        with open(self.model_path, "rb") as model:
            self.model_sha256 = hashlib.file_digest(model, "sha256").hexdigest()
        so = ort.SessionOptions()
        so.intra_op_num_threads = self.threads
        so.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            self.model_path, so, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name

    def logmel(self, y, librosa):
        """Upstream's LogMelSpect in numpy: |STFT| / sqrt(n_fft) through a
        128-band slaney-scale mel bank WITHOUT area normalisation (torchaudio's
        norm=None), then log1p(1000·x). Frames × bands."""
        import numpy as np

        if self._fb is None:
            self._fb = librosa.filters.mel(
                sr=BT_SR, n_fft=BT_N_FFT, n_mels=128, fmin=30.0, fmax=11000.0,
                htk=False, norm=None, dtype=np.float32,
            ).T.copy()
        mag = np.abs(librosa.stft(
            np.asarray(y, dtype=np.float32), n_fft=BT_N_FFT, hop_length=BT_HOP,
            window="hann", center=True, pad_mode="reflect",
        )) / np.float32(math.sqrt(BT_N_FFT))
        return np.log1p(np.float32(1000.0) * (mag.T @ self._fb)).astype(np.float32)

    def _run_chunk(self, chunk):
        import numpy as np

        beat, down = self.session.run(
            ["beat", "downbeat"], {self.input_name: np.ascontiguousarray(chunk[None], dtype=np.float32)}
        )
        return beat[0], down[0]

    def track(self, y, sr, librosa):
        """(beats_s, downbeats_s) for a mono window, times relative to its start."""
        if sr != BT_SR:
            y = librosa.resample(y, orig_sr=sr, target_sr=BT_SR)
        spect = self.logmel(y, librosa)
        if len(spect) == 0:
            raise ValueError("empty window")
        beats, downs = bt_beats_downbeats(*bt_frame_logits(spect, self._run_chunk))
        validate_grid(beats, downs, len(y) / BT_SR)
        return beats, downs


def validate_grid(beats, downs, duration_s):
    """Reject corrupt output, not musical disagreement or an empty grid."""
    import numpy as np

    for times in (beats, downs):
        times = np.asarray(times)
        if (times.ndim != 1 or not np.all(np.isfinite(times))
                or np.any(times < 0) or np.any(times > duration_s + 1 / BT_FPS)
                or np.any(np.diff(times) <= 0)):
            raise ValueError("invalid Beat This timestamps")
    if not np.all(np.isin(downs, beats)):
        raise ValueError("Beat This downbeats are not a subset of beats")


def grid_evidence(beats, reference):
    """Local timing support, never a qualification gate or a downbeat verdict.

    Librosa shares its window with the learned tracker. Agreement within 70 ms
    supports beat timing only; it cannot confirm which beat starts a bar.
    Interval support counts gaps within 5% of the median, including pauses.
    None means insufficient evidence, not zero confidence.
    """
    import numpy as np

    gaps = np.diff(beats)
    period = float(np.median(gaps)) if len(gaps) else None
    support = None
    if len(beats) and len(reference):
        ref = np.sort(np.asarray(reference))
        at = np.searchsorted(ref, beats)
        distance = np.minimum(np.abs(beats - ref[np.clip(at, 0, len(ref) - 1)]),
                              np.abs(beats - ref[np.clip(at - 1, 0, len(ref) - 1)]))
        support = round(float(np.mean(distance <= 0.07)), 4)
    return {
        "medianBpm": round(60 / period, 3) if period and period > 0 else None,
        "intervalSupport": round(float(np.mean(np.abs(gaps - period) <= 0.05 * period)), 4)
        if period and period > 0 and len(gaps) >= 2 else None,
        "librosaBeatSupport": support,
    }
