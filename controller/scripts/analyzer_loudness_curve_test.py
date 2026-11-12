#!/usr/bin/env python3
# The tail facet's short-term loudness curve (tail v3).
# Run: `npm test -- analyzer-python` (one of the shim's SUITES), or
# `python3 scripts/analyzer_loudness_curve_test.py` (exit 0 = pass).
#
# Why this is pinned:
#
#   * On a FADE ending the silence trim cuts at the ABSOLUTE floor (-50 dBFS),
#     seconds after the music stopped being audible, so the exit crossfade sat
#     over a near-silent tail. The controller can only cut at the AUDIBLE end
#     (a level relative to the track's own loudness) if the tail carries a
#     loudness curve: EBU R128 SHORT-TERM loudness (3 s window), every 0.5 s,
#     each point stamped at the END of the window it measures, absolute ms.
#   * The curve must read like a real R128 meter, or "N dB under the track's
#     loudness" means something else on air: compared here with ffmpeg's own
#     `ebur128` short-term values on the same signal (within 0.5 LU). The
#     analyzer image's ffmpeg is 5.1, which has no `framelog=quiet`, so the
#     per-frame log is read with `framelog=verbose`.
#   * pyloudnorm is optional in the worker: without it the curve is omitted
#     and nothing fails (the tail stays at its pre-curve version).
#
# numpy is required; the comparison cases need pyloudnorm + ffmpeg and skip
# (with a line saying so) where they are absent, e.g. under `npm test` on a
# workstation. They run in the analyzer image.

import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

try:
    import numpy as np
except ImportError:
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

SR = aw.ANALYZE_SR
failures = 0

try:
    import pyloudnorm  # noqa: F401
    HAVE_PYLN = True
except Exception:  # noqa: BLE001
    HAVE_PYLN = False
HAVE_FFMPEG = shutil.which("ffmpeg") is not None


def test(name, fn, needs=()):
    global failures
    missing = [n for n, ok in (("pyloudnorm", HAVE_PYLN), ("ffmpeg", HAVE_FFMPEG)) if n in needs and not ok]
    if missing:
        print(f"  - {name} (skipped: {', '.join(missing)} unavailable)")
        return
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


def fading_stereo(sec=20.0, sr=SR, hold=8.0):
    """Two partials, held at level for `hold` seconds then faded out
    exponentially (60 dB over the rest), slightly different per channel so
    the channel sum matters. (channels, n) like librosa's stereo decode."""
    t = np.arange(int(sr * sec), dtype=np.float64) / sr
    env = np.where(t < hold, 1.0, 10 ** (-60.0 * (t - hold) / (sec - hold) / 20.0))
    left = 0.4 * np.sin(2 * np.pi * 440.0 * t) + 0.2 * np.sin(2 * np.pi * 1000.0 * t)
    right = 0.3 * np.sin(2 * np.pi * 550.0 * t) + 0.25 * np.sin(2 * np.pi * 2000.0 * t)
    return np.stack([left * env, right * env]).astype(np.float32)


def write_wav16(path, y, sr):
    """(channels, n) float → 16-bit PCM WAV. Returns the quantised float
    signal, so the curve is computed on exactly what ffmpeg reads."""
    q = np.clip(np.round(y * 32767.0), -32768, 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(q.shape[0])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(q.T.copy().tobytes())
    return (q.astype(np.float64) / 32767.0).astype(np.float32)


FRAME_RE = re.compile(r"t:\s*([0-9.]+)\s.*?\bS:\s*(-?[0-9.]+|-inf|nan)")


def ffmpeg_short_term(path):
    """[(t_seconds, S_lufs)] from ffmpeg's ebur128 per-frame log (10 Hz). The
    frames are logged at the VERBOSE level (framelog=verbose; 5.1 has no
    framelog=quiet), so the log level is raised to show them."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "verbose", "-i", path, "-af", "ebur128=framelog=verbose", "-f", "null", "-"],
        capture_output=True, text=True, timeout=120,
    )
    out = []
    for line in proc.stderr.splitlines():
        m = FRAME_RE.search(line)
        if m and m.group(2) not in ("-inf", "nan"):
            out.append((float(m.group(1)), float(m.group(2))))
    if not out:
        raise AssertionError(f"no ebur128 frames parsed (rc={proc.returncode}): {proc.stderr[-400:]}")
    return out


def case_shape():
    y = fading_stereo()
    curve = aw.loudness_curve(y, SR, 100.0)
    assert curve is not None, "no curve with pyloudnorm present"
    assert set(curve) == {"startMs", "stepMs", "lufs"}, curve.keys()
    # The first point closes the first 3 s window: absolute ms.
    assert curve["startMs"] == 103000, curve["startMs"]
    assert curve["stepMs"] == 500
    # 20 s window → points at 3.0, 3.5 … 20.0 s from its start.
    assert len(curve["lufs"]) == 35, len(curve["lufs"])
    assert all(isinstance(v, int) for v in curve["lufs"]), "tenths of a dB, as ints"
    # Held then faded: the curve is flat at first and falls by ~50 dB.
    first, last = curve["lufs"][0], curve["lufs"][-1]
    assert abs(curve["lufs"][9] - first) <= 2, (first, curve["lufs"][9])
    assert first - last > 400, (first, last)


def case_matches_ffmpeg():
    y = fading_stereo()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "fade.wav")
        yq = write_wav16(path, y, SR)
        frames = ffmpeg_short_term(path)
    curve = aw.loudness_curve(yq, SR, 0.0)
    compared = 0
    worst = 0.0
    for i, tenths in enumerate(curve["lufs"]):
        t = (curve["startMs"] + i * curve["stepMs"]) / 1000.0
        ft, fs = min(frames, key=lambda f: abs(f[0] - t))
        if abs(ft - t) > 0.051 or fs <= -69.0:
            continue
        compared += 1
        worst = max(worst, abs(tenths / 10.0 - fs))
        assert abs(tenths / 10.0 - fs) <= 0.5, f"t={t}: curve {tenths / 10.0} vs ffmpeg S {fs}"
    assert compared >= 25, f"only {compared} points compared"
    print(f"      ({compared} points, worst difference {worst:.2f} LU)")


def case_mono_and_short():
    # A mono decode works (one channel, weight 1).
    curve = aw.loudness_curve(fading_stereo()[0], SR, 0.0)
    assert curve is not None and len(curve["lufs"]) == 35
    # Shorter than one 3 s window: a curve with no points, not a failure.
    short = aw.loudness_curve(fading_stereo(sec=2.0, hold=1.0), SR, 50.0)
    assert short == {"startMs": 53000, "stepMs": 500, "lufs": []}, short


def case_silence_floor():
    # Digital silence has no finite loudness: stored at the floor, an int.
    y = np.zeros((2, SR * 5), dtype=np.float32)
    curve = aw.loudness_curve(y, SR, 0.0)
    assert curve["lufs"] and all(v == aw.LOUDNESS_CURVE_FLOOR_TENTHS for v in curve["lufs"]), curve["lufs"]
    # A finite level far under it (dither-quiet, about -160 LUFS) is held at
    # the floor too: one stored meaning for "nothing audible".
    faint = fading_stereo(sec=5.0, hold=4.9) * 1e-8
    curve = aw.loudness_curve(faint, SR, 0.0)
    assert all(v == aw.LOUDNESS_CURVE_FLOOR_TENTHS for v in curve["lufs"]), curve["lufs"]


def case_without_pyloudnorm():
    saved = sys.modules.get("pyloudnorm")
    sys.modules["pyloudnorm"] = None  # import raises ImportError
    try:
        assert aw.loudness_curve(fading_stereo(), SR, 0.0) is None
    finally:
        if saved is None:
            sys.modules.pop("pyloudnorm", None)
        else:
            sys.modules["pyloudnorm"] = saved


class FakeLibrosa:
    @staticmethod
    def to_mono(buf):
        buf = np.asarray(buf)
        return buf.mean(axis=0) if buf.ndim == 2 else buf

    class feature:
        @staticmethod
        def rms(y, frame_length=2048, hop_length=512):
            n = 1 + max(0, len(y) - frame_length) // hop_length
            return np.array([[
                float(np.sqrt(np.mean(y[i * hop_length:i * hop_length + frame_length] ** 2)))
                for i in range(n)
            ]])

    @staticmethod
    def frames_to_time(frames, sr, hop_length=512):
        return np.asarray(frames, dtype=np.float64) * hop_length / sr

    class beat:
        @staticmethod
        def beat_track(y, sr):
            raise RuntimeError("no beat tracker in the fake")


def case_facet_tail_carries_curve():
    y = fading_stereo()
    out = aw.facet_tail(y, SR, 180.0, 200.0, FakeLibrosa)
    assert out["ending"] == "fade", out["ending"]
    curve = out.get("loudnessCurve")
    assert curve is not None, sorted(out)
    assert curve["startMs"] == 183000 and curve["stepMs"] == 500 and len(curve["lufs"]) == 35


def case_facet_tail_without_pyloudnorm():
    saved = sys.modules.get("pyloudnorm")
    sys.modules["pyloudnorm"] = None
    try:
        out = aw.facet_tail(fading_stereo(), SR, 180.0, 200.0, FakeLibrosa)
        assert out is not None and "loudnessCurve" not in out, sorted(out or {})
    finally:
        if saved is None:
            sys.modules.pop("pyloudnorm", None)
        else:
            sys.modules["pyloudnorm"] = saved


print("analyzer loudness curve")
test("curve shape: absolute end-of-window stamps, 0.5 s steps, tenths", case_shape, needs=("pyloudnorm",))
test("matches ffmpeg ebur128 short-term within 0.5 LU", case_matches_ffmpeg, needs=("pyloudnorm", "ffmpeg"))
test("mono input, and a window shorter than 3 s", case_mono_and_short, needs=("pyloudnorm",))
test("digital silence reads at the floor", case_silence_floor, needs=("pyloudnorm",))
test("no pyloudnorm: no curve, no failure", case_without_pyloudnorm)
test("facet_tail stores the curve in the outro", case_facet_tail_carries_curve, needs=("pyloudnorm",))
test("facet_tail without pyloudnorm omits the curve", case_facet_tail_without_pyloudnorm)

if failures:
    print(f"FAIL: {failures} case(s)")
    sys.exit(1)
print("ok")
