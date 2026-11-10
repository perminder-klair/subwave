#!/usr/bin/env python3
# Unit tests for the analyzer worker's edge-silence measurement
# (silence_edges_ms) — the input the controller's dead-air trim acts on.
# Run: `python3 scripts/analyzer_silence_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# numpy is the ONE dependency (the function is vector arithmetic) and a missing
# one FAILS rather than skips, matching vocal_gate_test.py beside it. A skip
# here reads as a pass in `npm test`, so on a box without numpy the suite that
# guards the absolute threshold would silently never run — which is the one
# thing it exists to prevent. No torch, no librosa, no audio files, no network.
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
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

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
    lead, tail, tail_start = aw.silence_edges_ms(y, SR)
    near(lead, 3000.0, "lead")
    near(tail, 2000.0, "tail")
    # The gap's START, not just its length — this is the value that becomes the
    # cue_out, and deriving it as (duration - gap) would import whatever the
    # container tag claims. Here it is 3s of blank + 5s of tone.
    near(tail_start, 8000.0, "tail start")
    # …and the two must describe the SAME buffer end, which is the whole
    # point of carrying both.
    near(tail_start + tail, 10_000.0, "tail start + gap == buffer end")


def t_no_gaps():
    lead, tail, tail_start = aw.silence_edges_ms(tone(5.0), SR)
    near(lead, 0.0, "lead")
    near(tail, 0.0, "tail")
    near(tail_start, 5000.0, "tail start")


# --- the case a relative threshold would get wrong --------------------------

def t_quiet_intro_is_not_silence():
    # A -40 dBFS opening is quiet MUSIC — well under a relative gate keyed to
    # the track's own loud level, well over the absolute floor. It must read as
    # no leading gap at all, or the trim cuts the intro off the record.
    quiet = tone(4.0, amp=0.01)   # ≈ -40 dBFS
    loud = tone(4.0, amp=0.8)
    lead, _tail, _start = aw.silence_edges_ms(np.concatenate([quiet, loud]), SR)
    near(lead, 0.0, "lead")


def t_below_floor_is_silence():
    # …while genuine near-digital silence (-80 dBFS of dither/noise floor) is
    # under the absolute floor and DOES count as a gap.
    floor_noise = (1e-4 * np.ones(int(SR * 3.0))).astype(np.float32)
    lead, _tail, _start = aw.silence_edges_ms(np.concatenate([floor_noise, tone(4.0)]), SR)
    near(lead, 3000.0, "lead")


# --- refusals ---------------------------------------------------------------

def t_all_silent_window_is_unknown():
    lead, tail, tail_start = aw.silence_edges_ms(silence(6.0), SR)
    assert (lead, tail, tail_start) == (None, None, None), \
        f"expected (None, None, None), got ({lead}, {tail}, {tail_start})"


def t_empty_and_missing():
    assert aw.silence_edges_ms(None, SR) == (None, None, None)
    assert aw.silence_edges_ms(np.zeros(0, dtype=np.float32), SR) == (None, None, None)
    assert aw.silence_edges_ms(tone(2.0), 0) == (None, None, None)


def t_shorter_than_one_frame():
    # A buffer under the 2048-sample frame must not raise; it either finds the
    # audio at zero or reports nothing, never a negative or a crash.
    lead, tail, tail_start = aw.silence_edges_ms(tone(0.05), SR)
    assert lead is None or lead >= 0
    assert tail is None or tail >= 0
    assert tail_start is None or tail_start >= 0


def t_signal_in_the_final_partial_frame():
    # The stride must reach the END of the buffer, not the last WHOLE frame.
    # Stopping at `n - frame + 1` leaves up to hop-1 samples unexamined at the
    # very end (here 102 of them), and signal in there reads as trailing gap —
    # error in the direction that CUTS audio. The burst is deliberately sized
    # to land entirely inside that blind spot: widen it and the test passes on
    # the buggy stride too, which is how this case is easy to write uselessly.
    n = int(SR * 3.0)
    blind = n - (((n - 2048) // 512) * 512 + 2048)   # samples past the last whole frame
    assert 0 < blind < 512, f"expected a small blind spot, got {blind}"
    y = np.concatenate([tone(2.0), silence(1.0)]).astype(np.float32)
    assert y.size == n
    y[-blind:] = 0.8
    _lead, tail, _start = aw.silence_edges_ms(y, SR)
    near(tail, 0.0, "tail with signal in the final partial frame")


class _FakeLibrosa:
    @staticmethod
    def to_mono(buf):
        return buf


def _outro_with_buffer(y, duration_s, complete):
    """Run analyze_outro against a canned decode, no audio files."""
    original_load_audio = aw.load_audio
    aw.load_audio = lambda *_args, **_kwargs: (y, SR)
    try:
        return aw.analyze_outro("short.wav", _FakeLibrosa(), duration_s, complete)
    finally:
        aw.load_audio = original_load_audio


def t_complete_short_track_keeps_tail_measurement():
    # Outro musical features need a distinct 20s tail, but dead-air detection
    # does not. A complete 10s file already has its real end in memory, so the
    # final 3s blank must still be reported instead of disappearing behind the
    # outro feature's minimum-duration guard.
    y = np.concatenate([tone(7.0), silence(3.0)])
    outro = _outro_with_buffer(y, 10.0, True)

    assert outro is not None, "complete short track lost its tail measurement"
    near(outro.get("tail_silence_ms"), 3000.0, "short-track tail")
    # Absolute, and on a short track the decode starts at zero, so the gap opens
    # at 7s into the FILE — the figure the controller stamps as liq_cue_out.
    near(outro.get("tail_start_ms"), 7000.0, "short-track tail start")
    assert "startMs" not in outro, "short track must not invent distinct-outro features"


def t_short_track_of_unknown_completeness_is_refused():
    # The short-track path decodes from offset ZERO, so the short-decode
    # backstop cannot prove completeness the way the real tail window does
    # (there, the seek to duration-20s is itself the proof). A file truncated
    # to 70% decodes 70% and clears a 0.6 length check — and its "tail" is
    # mid-song audio, which as a cue_out cuts the song short. Only the caller's
    # own completeness flag settles it, so anything less is refused.
    y = np.concatenate([tone(7.0), silence(3.0)])
    assert _outro_with_buffer(y, 10.0, None) is None, "unknown completeness must not be measured"
    assert _outro_with_buffer(y, 10.0, False) is None, "a truncated file must not be measured"


print("silence_edges_ms")
test("measures both edges", t_both_edges)
test("no gaps reads zero, not None", t_no_gaps)
test("a quiet intro is music, not silence", t_quiet_intro_is_not_silence)
test("a noise floor below the gate is silence", t_below_floor_is_silence)
test("an entirely silent window reads unknown", t_all_silent_window_is_unknown)
test("empty / missing input refuses cleanly", t_empty_and_missing)
test("a sub-frame buffer never raises", t_shorter_than_one_frame)
test("signal in the final partial frame is not counted as gap", t_signal_in_the_final_partial_frame)
test("a complete short track still measures its real tail", t_complete_short_track_keeps_tail_measurement)
test("a short track of unknown completeness is refused", t_short_track_of_unknown_completeness_is_refused)

if failures:
    print(f"✗ {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_silence_test.py passed")
