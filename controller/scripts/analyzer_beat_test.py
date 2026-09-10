#!/usr/bin/env python3
# Regression test for main/head beat tracking graceful degradation (#1647).
# Run: `python3 scripts/analyzer_beat_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# NumPy is the only dependency. The worker's remaining audio/model boundaries
# are deterministic fakes so this drives real analyze() orchestration without
# librosa, torch, model weights, audio files, or network access.

import math
import os
import sys

try:
    import numpy as np
except ImportError:
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
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


class _FailingBeat:
    @staticmethod
    def beat_track(*_args, **_kwargs):
        raise ZeroDivisionError("float division by zero")


class _SuccessfulBeat:
    @staticmethod
    def beat_track(*_args, **_kwargs):
        return np.array([123.456]), np.array([0, 1, 2, 3, 4])


class _Feature:
    @staticmethod
    def chroma_cqt(*_args, **_kwargs):
        return np.zeros((12, 4), dtype=np.float32)


class _FakeLibrosa:
    feature = _Feature()

    def __init__(self, beat):
        self.beat = beat

    @staticmethod
    def get_duration(**_kwargs):
        return 30.0

    @staticmethod
    def to_mono(y):
        return y

    @staticmethod
    def frames_to_time(frames, **_kwargs):
        return np.asarray(frames, dtype=np.float64) * 0.5


def _analyze(beat):
    y = np.ones(4096, dtype=np.float32)
    logs = []
    originals = {
        "ensure_fast_decode": aw.ensure_fast_decode,
        "load_audio": aw.load_audio,
        "estimate_key": aw.estimate_key,
        "estimate_key_ranges": aw.estimate_key_ranges,
        "estimate_intro_ms": aw.estimate_intro_ms,
        "silence_edges_ms": aw.silence_edges_ms,
        "estimate_sections": aw.estimate_sections,
        "estimate_pace": aw.estimate_pace,
        "measure_loudness": aw.measure_loudness,
        "log": aw.log,
    }
    try:
        aw.ensure_fast_decode = lambda path: (path, None)
        aw.load_audio = lambda *_args, **_kwargs: (y, aw.ANALYZE_SR)
        aw.estimate_key = lambda _chroma: ("8A", 0.6)
        aw.estimate_key_ranges = lambda *_args, **_kwargs: []
        aw.estimate_intro_ms = lambda *_args, **_kwargs: 4321.0
        aw.silence_edges_ms = lambda *_args, **_kwargs: (0.0, 0.0, 0.0)
        aw.estimate_sections = lambda *_args, **_kwargs: [{"startMs": 0, "label": "intro"}]
        aw.estimate_pace = lambda *_args, **_kwargs: [{"atMs": 0, "value": 0.4}]
        aw.measure_loudness = lambda *_args, **_kwargs: (-9.5, -0.1)
        aw.log = logs.append

        result = aw.analyze(
            _FakeLibrosa(beat), path="clipped-live-recording.wav", embed=False,
            vocal=False, complete=False,
        )
        return result, logs
    finally:
        for name, value in originals.items():
            setattr(aw, name, value)


def t_main_beat_failure_keeps_independent_analysis():
    result, logs = _analyze(_FailingBeat())

    assert result["bpm"] is None, result
    assert "beats" not in result, result
    assert "bars" not in result, result
    assert result["key"] == "8A", result
    assert result["intro_ms"] == 4321, result
    assert result["sections"] == [{"startMs": 0, "label": "intro"}], result
    assert result["pace_curve"] == [{"atMs": 0, "value": 0.4}], result
    assert result["loudness_lufs"] == -9.5, result
    assert math.isfinite(result["confidence"]), result
    assert result["confidence"] == 0.3, "unknown BPM must not receive the tempo confidence bonus"
    assert any("float division by zero" in line for line in logs), logs


def t_main_beat_success_keeps_numeric_bpm_and_grid():
    result, logs = _analyze(_SuccessfulBeat())

    assert result["bpm"] == 123.5, result
    assert result["beats"] == [0, 500, 1000, 1500, 2000], result
    assert result["bars"] == [0, 2000], result
    assert result["confidence"] == 0.8, result
    assert not logs, logs


print("main beat tracking")
test("a beat tracker exception keeps the rest of analysis", t_main_beat_failure_keeps_independent_analysis)
test("a successful beat tracker keeps numeric BPM and grids", t_main_beat_success_keeps_numeric_bpm_and_grid)

if failures:
    print(f"✗ analyzer_beat_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_beat_test.py passed")
