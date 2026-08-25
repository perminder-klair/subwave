#!/usr/bin/env python3
# Unit tests for the analyzer worker's edge-silence measurement
# (silence_edges_ms) — the input the controller's dead-air trim acts on.
# Run: `python3 scripts/analyzer_silence_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# numpy is the ONE dependency (the function is vector arithmetic); a box
# without it skips cleanly rather than failing, matching the suite's posture
# on python3 itself. No torch, no librosa, no audio files, no network.
#
# Why this is pinned:
#
#   * The threshold must stay ABSOLUTE. Every other edge measurement in this
#     worker (estimate_intro_ms, analyze_outro's wind-down) is relative to the
#     track's own loud level, and a relative gate here would read a quiet
#     intro as silence and hand the controller a cue point that cuts music.
#     The quiet-but-audible case below is the one that catches that swap.
#   * "Entirely silent window" must read None, not "the whole buffer is a
#     gap". The window is 40s at the head and 20s at the tail; a gap that
#     fills one outlasts it, and its real end is somewhere the worker cannot
#     see. Returning a length there would cut a track to nothing.

import os
import sys

try:
    import numpy as np
except ImportError:
    print("skipped: numpy not available")
    sys.exit(0)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

SR = 22050
failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


def silence(sec):
    return np.zeros(int(SR * sec), dtype=np.float32)


def tone(sec, amp=0.5):
    t = np.arange(int(SR * sec), dtype=np.float32) / SR
    return (amp * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)


# A frame is 2048 samples (~93ms at 22.05 kHz) and the reported edge is the
# START of the first/last loud frame, so allow one frame of slack either way.
TOL_MS = 120.0


def near(actual, expected, what):
    assert actual is not None, f"{what}: got None, expected ~{expected}ms"
    assert abs(actual - expected) <= TOL_MS, f"{what}: {actual}ms, expected ~{expected}ms"


# --- the ordinary case ------------------------------------------------------

def t_both_edges():
    y = np.concatenate([silence(3.0), tone(5.0), silence(2.0)])
    lead, tail = aw.silence_edges_ms(y, SR)
    near(lead, 3000.0, "lead")
    near(tail, 2000.0, "tail")


def t_no_gaps():
    lead, tail = aw.silence_edges_ms(tone(5.0), SR)
    near(lead, 0.0, "lead")
    near(tail, 0.0, "tail")


# --- the case a relative threshold would get wrong --------------------------

def t_quiet_intro_is_not_silence():
    # A -40 dBFS opening is quiet MUSIC — well under a relative gate keyed to
    # the track's own loud level, well over the absolute floor. It must read as
    # no leading gap at all, or the trim cuts the intro off the record.
    quiet = tone(4.0, amp=0.01)   # ≈ -40 dBFS
    loud = tone(4.0, amp=0.8)
    lead, _tail = aw.silence_edges_ms(np.concatenate([quiet, loud]), SR)
    near(lead, 0.0, "lead")


def t_below_floor_is_silence():
    # …while genuine near-digital silence (-80 dBFS of dither/noise floor) is
    # under the absolute floor and DOES count as a gap.
    floor_noise = (1e-4 * np.ones(int(SR * 3.0))).astype(np.float32)
    lead, _tail = aw.silence_edges_ms(np.concatenate([floor_noise, tone(4.0)]), SR)
    near(lead, 3000.0, "lead")


# --- refusals ---------------------------------------------------------------

def t_all_silent_window_is_unknown():
    lead, tail = aw.silence_edges_ms(silence(6.0), SR)
    assert lead is None and tail is None, f"expected (None, None), got ({lead}, {tail})"


def t_empty_and_missing():
    assert aw.silence_edges_ms(None, SR) == (None, None)
    assert aw.silence_edges_ms(np.zeros(0, dtype=np.float32), SR) == (None, None)
    assert aw.silence_edges_ms(tone(2.0), 0) == (None, None)


def t_shorter_than_one_frame():
    # A buffer under the 2048-sample frame must not raise; it either finds the
    # audio at zero or reports nothing, never a negative or a crash.
    lead, tail = aw.silence_edges_ms(tone(0.05), SR)
    assert lead is None or lead >= 0
    assert tail is None or tail >= 0


print("silence_edges_ms")
test("measures both edges", t_both_edges)
test("no gaps reads zero, not None", t_no_gaps)
test("a quiet intro is music, not silence", t_quiet_intro_is_not_silence)
test("a noise floor below the gate is silence", t_below_floor_is_silence)
test("an entirely silent window reads unknown", t_all_silent_window_is_unknown)
test("empty / missing input refuses cleanly", t_empty_and_missing)
test("a sub-frame buffer never raises", t_shorter_than_one_frame)

if failures:
    print(f"✗ {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_silence_test.py passed")
