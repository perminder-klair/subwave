#!/usr/bin/env python3
# The bar grid's downbeat tracker (ANALYZE_DOWNBEATS=beat-this). Run:
# `python3 scripts/analyzer_downbeat_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# What this pins, in the order it matters:
#   - off is today's grid: unset, empty, "off" and an UNKNOWN value all mean
#     librosa's beats with every 4th as a bar, and an unknown one says so;
#   - a missing onnxruntime, a missing model or a failed inference falls back
#     to exactly that grid, logged once, never a failed analysis; a missing
#     runtime or model (every lean image) says the heavy image is needed, and
#     a model that is there but won't load says that instead;
#   - with the tracker on, beats and bars both come from it, bars are a
#     subset of beats, and the tail window's offset is applied;
#   - the chunking and peak picking match upstream's semantics on hand cases
#     (tools/beat-this/parity.py proves them against upstream itself);
#   - with onnxruntime, librosa and the model present (the heavy analyzer
#     image),
#     a synthetic 4/4 band track whose first downbeat is one beat in gets its
#     bars on the real downbeats.
#
# NumPy is the only hard dependency. The last case skips without the model
# runtime, like vocal_gate_test.py's torch case.

import importlib.util
import io
import math
import os
import sys
import types
from contextlib import redirect_stderr

try:
    import numpy as np
except ImportError:
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.pop("ANALYZE_DOWNBEATS", None)
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


class _FakeLibrosa:
    """frames_to_time only: frame k is k * 0.5 s, so a grid is easy to read."""

    @staticmethod
    def frames_to_time(frames, **_kwargs):
        return np.asarray(frames, dtype=np.float64) * 0.5


FRAMES = np.arange(10)  # beats at 0, 0.5, ... 4.5 s


def todays_grid(offset_s=0.0):
    beats = [int(round((offset_s + 0.5 * k) * 1000.0)) for k in range(10)]
    return beats, beats[::4]


def with_state(fn, mode, tracker=None, failed=False, model=None):
    """Run fn with the tracker's module state set, then restore it."""
    saved = {k: getattr(aw, k) for k in (
        "DOWNBEATS", "BEAT_THIS_MODEL", "_downbeat_tracker", "_downbeat_failed",
        "_downbeat_infer_logged", "_downbeat_release_started", "log",
    )}
    logs = []
    try:
        aw.DOWNBEATS = mode
        aw._downbeat_tracker = tracker
        aw._downbeat_failed = failed
        aw._downbeat_infer_logged = False
        aw._downbeat_release_started = True  # never start the release thread here
        if model is not None:
            aw.BEAT_THIS_MODEL = model
        aw.log = logs.append
        return fn(logs)
    finally:
        for k, v in saved.items():
            setattr(aw, k, v)


def mode_for(value):
    saved = os.environ.get("ANALYZE_DOWNBEATS")
    err = io.StringIO()
    try:
        if value is None:
            os.environ.pop("ANALYZE_DOWNBEATS", None)
        else:
            os.environ["ANALYZE_DOWNBEATS"] = value
        with redirect_stderr(err):
            return aw.downbeats_mode(), err.getvalue()
    finally:
        if saved is None:
            os.environ.pop("ANALYZE_DOWNBEATS", None)
        else:
            os.environ["ANALYZE_DOWNBEATS"] = saved


def t_flag_values():
    for value in (None, "", "   ", "off", "librosa", "0", "false"):
        mode, err = mode_for(value)
        assert mode is None, (value, mode)
        assert err == "", (value, err)
    for value in ("beat-this", " Beat-This "):
        mode, err = mode_for(value)
        assert mode == "beat-this", (value, mode)
        assert err == "", (value, err)


def t_unknown_value_is_off_and_says_so():
    for value in ("beatthis", "madmom", "1", "true"):
        mode, err = mode_for(value)
        assert mode is None, (value, mode)
        assert "not recognised" in err and "librosa's bar grid" in err, (value, err)


def t_off_is_todays_grid_and_loads_nothing():
    class Exploding:
        def __init__(self, *_a, **_k):
            raise AssertionError("tracker constructed with the flag off")

    saved = aw.DownbeatTracker
    try:
        aw.DownbeatTracker = Exploding

        def run(logs):
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES) == todays_grid()
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES, offset_s=91.25) == todays_grid(91.25)
            assert logs == [], logs

        with_state(run, None)
    finally:
        aw.DownbeatTracker = saved


def t_missing_model_falls_back_logged_once():
    # A stand-in onnxruntime, so the missing FILE is what fails here even on a
    # host without the runtime (the next case covers a missing runtime).
    saved = sys.modules.get("onnxruntime", "absent")
    sys.modules["onnxruntime"] = types.ModuleType("onnxruntime")
    try:
        def run(logs):
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES) == todays_grid()
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES, offset_s=3.0) == todays_grid(3.0)
            assert aw._downbeat_failed is True
            loads = [m for m in logs if "needs the heavy analyzer image" in m]
            assert len(loads) == 1 and len(logs) == 1, logs
            assert "no Beat This model at" in loads[0], loads
            assert "librosa's bar grid" in loads[0], loads

        with_state(run, "beat-this", model=os.path.join(HERE, "no-such-beat-this.onnx"))
    finally:
        if saved == "absent":
            sys.modules.pop("onnxruntime", None)
        else:
            sys.modules["onnxruntime"] = saved


def t_missing_onnxruntime_falls_back():
    saved = sys.modules.get("onnxruntime", "absent")
    sys.modules["onnxruntime"] = None  # makes `import onnxruntime` raise ImportError
    try:
        def run(logs):
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES) == todays_grid()
            assert aw._downbeat_failed is True
            assert any("needs the heavy analyzer image" in m and "onnxruntime" in m for m in logs), logs

        with_state(run, "beat-this", model=__file__)
    finally:
        if saved == "absent":
            sys.modules.pop("onnxruntime", None)
        else:
            sys.modules["onnxruntime"] = saved


def t_unloadable_model_is_not_blamed_on_the_image():
    class Unloadable(aw.DownbeatTracker):
        def load(self):
            raise RuntimeError("INVALID_PROTOBUF")

    saved = aw.DownbeatTracker
    try:
        aw.DownbeatTracker = Unloadable

        def run(logs):
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES) == todays_grid()
            assert aw.get_downbeat_tracker() is None
            assert len(logs) == 1, logs
            assert "load failed (INVALID_PROTOBUF)" in logs[0], logs
            assert "heavy" not in logs[0], logs

        with_state(run, "beat-this", model=__file__)
    finally:
        aw.DownbeatTracker = saved


def t_inference_failure_falls_back_logged_once():
    class Broken:
        def track(self, *_a):
            raise RuntimeError("bad chunk")

    def run(logs):
        for _ in range(3):
            assert aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES) == todays_grid()
        assert len([m for m in logs if "inference failed" in m]) == 1, logs
        assert aw._downbeat_tracker is not None  # one bad window keeps the model

    with_state(run, "beat-this", tracker=Broken())


def t_tracker_grid_with_offset():
    class Fixed:
        def track(self, *_a):
            return np.array([0.12, 0.62, 1.12, 1.62, 2.12]), np.array([0.62, 2.12])

    def run(_logs):
        beats, bars = aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES)
        assert beats == [120, 620, 1120, 1620, 2120], beats
        assert bars == [620, 2120], bars
        beats, bars = aw.bar_grid(None, 22050, _FakeLibrosa(), FRAMES, offset_s=200.0)
        assert bars == [200620, 202120], bars
        assert set(bars) <= set(beats), (beats, bars)

    with_state(run, "beat-this", tracker=Fixed())


def t_chunk_starts():
    # A 20 s tail (1001 frames) is one short chunk; a 30 s window (1501) is two
    # full chunks with the last pulled back; a 40 s head (2001) likewise.
    assert aw.bt_chunk_starts(1001) == [-6]
    assert aw.bt_chunk_starts(1488) == [-6]
    assert aw.bt_chunk_starts(1501) == [-6, 7]
    assert aw.bt_chunk_starts(2001) == [-6, 507]
    assert aw.bt_chunk_starts(3000) == [-6, 1482, 1506]
    assert len(aw.bt_chunk(np.zeros((1001, 128), np.float32), -6)) == 1013
    assert len(aw.bt_chunk(np.zeros((1501, 128), np.float32), 7)) == 1500


def t_frame_logits_cover_every_frame_once():
    # An identity "model" must reconstruct its input exactly: every frame is
    # written, from the earliest chunk that keeps it.
    rng = np.random.default_rng(7)
    for n in (40, 1001, 1501, 2001, 4321):
        spect = rng.standard_normal((n, 128)).astype(np.float32)
        beat, down = aw.bt_frame_logits(spect, lambda c: (c[:, 0].copy(), c[:, 1].copy()))
        assert np.array_equal(beat, spect[:, 0]) and np.array_equal(down, spect[:, 1]), n


def t_peaks_and_snapping():
    x = np.full(60, -5.0, np.float32)
    x[[10, 11, 12]] = 2.0   # a plateau: upstream's running mean gives 10.5, then 12
    x[30] = 1.0
    x[33] = 0.5             # within 3 frames of a bigger peak: not a peak
    x[50] = -0.1            # a local max below zero: not a beat
    assert list(aw.bt_peak_frames(x)) == [10.5, 12.0, 30.0], list(aw.bt_peak_frames(x))
    d = np.full(60, -5.0, np.float32)
    d[29] = 3.0             # snaps to the beat at frame 30
    d[13] = 3.0             # snaps to frame 12
    beats, downs = aw.bt_beats_downbeats(x, d)
    assert list(downs) == [12.0 / 50, 30.0 / 50], list(downs)
    assert set(downs) <= set(beats)


def _band_track(sr=22050, bpm=120.0, seconds=30.0, lead_beats=1):
    """A small band in 4/4: kick on 1 and 3, snare on 2 and 4, eighth-note
    hats, and a bass note plus chord that change on every downbeat (a crash
    every fourth bar). The first downbeat is `lead_beats` in, so a grid that
    starts at the first beat is out of phase. Returns (samples, downbeats_s).
    A bare accented metronome is not enough: Beat This reads its accents
    poorly (precision 0.12 when this was written), so the downbeats here are
    marked the way music marks them, by harmony and the kick."""
    rng = np.random.default_rng(3)
    y = np.zeros(int(seconds * sr))
    beat_s = 60.0 / bpm
    roots = (110.0, 87.3, 130.8, 98.0)

    def env(n, rate):
        return np.exp(-np.arange(n) / sr * rate)

    def add(at, x):
        x = x[: max(0, len(y) - at)]
        y[at:at + len(x)] += x

    downbeats = []
    for k in range(int(seconds / beat_s)):
        at = int(k * beat_s * sr)
        pos = (k - lead_beats) % 4
        bar = (k - lead_beats) // 4
        n = int(0.35 * sr)
        t = np.arange(n) / sr
        if pos in (0, 2):
            sweep = 60.0 * np.exp(-t * 20.0) + 45.0
            add(at, np.sin(2 * math.pi * np.cumsum(sweep) / sr) * env(n, 12.0))
        else:
            add(at, 0.5 * rng.standard_normal(n) * env(n, 25.0)
                + 0.3 * np.sin(2 * math.pi * 190.0 * t) * env(n, 30.0))
        for half in (0, 1):
            m = int(0.05 * sr)
            add(at + int(half * beat_s / 2 * sr), 0.12 * rng.standard_normal(m) * env(m, 80.0))
        if pos == 0 and k >= lead_beats:
            downbeats.append(k * beat_s)
            length = int(4 * beat_s * sr)
            tb = np.arange(length) / sr
            root = roots[bar % 4]
            add(at, 0.35 * np.sin(2 * math.pi * root * tb) * np.exp(-tb * 1.5)
                + 0.08 * sum(np.sin(2 * math.pi * root * m * tb) for m in (2.0, 2.52, 3.0)) * np.exp(-tb * 0.6))
            if bar % 4 == 0:
                m = sr
                add(at, 0.25 * rng.standard_normal(m) * env(m, 4.0))
    return (y / np.max(np.abs(y)) * 0.8).astype(np.float32), np.array(downbeats)


def t_real_model_finds_band_downbeats():
    model = os.environ.get("BEAT_THIS_MODEL", "").strip() or "/opt/analyzer/models/beat_this-small0.onnx"
    have = all(importlib.util.find_spec(m) is not None for m in ("onnxruntime", "librosa"))
    if not have or not os.path.isfile(model):
        print("      (skipped: needs onnxruntime, librosa and the Beat This model — runs in the heavy analyzer image)")
        return
    import librosa

    y, truth = _band_track()

    def run(logs):
        out = aw.facet_head(y, 22050, librosa)
        assert any("downbeat model loaded" in m for m in logs), logs
        bars = np.array(out.get("bars", [])) / 1000.0
        assert set(out.get("bars", [])) <= set(out.get("beats", [])), "bars must be a subset of beats"
        assert len(bars) >= 10, (logs, out.get("bars"))
        precision = np.mean([float(np.min(np.abs(truth - b))) <= 0.07 for b in bars])
        recall = np.mean([float(np.min(np.abs(bars - d))) <= 0.07 for d in truth])
        assert precision >= 0.9 and recall >= 0.9, (
            precision, recall, list(np.round(bars, 2)), list(np.round(truth, 2)))

    with_state(run, "beat-this", model=model)


test("flag values: unset/empty/off are off, beat-this is on, silently", t_flag_values)
test("an unknown ANALYZE_DOWNBEATS value is off and says so", t_unknown_value_is_off_and_says_so)
test("flag off: today's grid exactly, no tracker constructed", t_off_is_todays_grid_and_loads_nothing)
test("missing model: today's grid, one line naming the heavy image", t_missing_model_falls_back_logged_once)
test("missing onnxruntime: today's grid, the heavy image named", t_missing_onnxruntime_falls_back)
test("a model that won't load is reported as such, not as a lean image", t_unloadable_model_is_not_blamed_on_the_image)
test("failed inference: today's grid, logged once, model kept", t_inference_failure_falls_back_logged_once)
test("tracker on: beats and bars from it, bars ⊂ beats, offset applied", t_tracker_grid_with_offset)
test("chunk starts and padding follow upstream's split_piece", t_chunk_starts)
test("aggregation writes every frame from the earliest chunk", t_frame_logits_cover_every_frame_once)
test("peak picking, plateau dedup and downbeat snapping", t_peaks_and_snapping)
test("real model: bars land on a synthetic band's downbeats", t_real_model_finds_band_downbeats)

if failures:
    print(f"\n{failures} failure(s)")
    sys.exit(1)
print("\nall downbeat tests passed")
