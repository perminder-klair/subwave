#!/usr/bin/env python3
# Contract tests for the whole-file facets, `loudness` v2 and `edges`: ONE
# ffmpeg decode of the whole file at its native rate gives the BS.1770
# loudness figures (ebur128 summary on stderr) and the PCM the silence edges
# and the exact duration are read from (stdout). Run:
# `python3 scripts/analyzer_whole_file_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# numpy is the one dependency. The parsers and the edge scanner are pure and
# tested without ffmpeg; the end-to-end case at the bottom runs only when an
# ffmpeg binary is on PATH (skipped, not failed, otherwise).
#
# Why this is pinned:
#
#   * Loudness and true peak are ONE measurement: both come from the same pass
#     over the same audio, or neither is reported (a loudness without its peak
#     would let a boost through with no ceiling).
#   * Edges are measured against the ABSOLUTE floor (SILENCE_DBFS), never a
#     relative one, at sample resolution, and the scan is independent of how
#     the PCM stream happens to be chunked.
#   * The duration is counted from decoded samples, never read from tags.
#   * A request for whole-file facets alone never fetches the capped download
#     the window facets decode, and the window facets keep working without a
#     whole-file source (an older controller sends none).

import math
import os
import shutil
import struct
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

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err!r}")


class Patched:
    """Swap module attributes for the duration of a block."""

    def __init__(self, **attrs):
        self.attrs = attrs
        self.saved = {}

    def __enter__(self):
        for k, v in self.attrs.items():
            self.saved[k] = getattr(aw, k)
            setattr(aw, k, v)

    def __exit__(self, *_exc):
        for k, v in self.saved.items():
            setattr(aw, k, v)


def amp_db(db):
    return 10.0 ** (db / 20.0)


def stereo(lead_s, body_s, tail_s, sr, amp=0.5):
    """Interleaved stereo float32: lead_s of silence, a tone, tail_s of silence."""
    t = np.arange(int(round(body_s * sr)), dtype=np.float64) / sr
    body = (amp * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)
    mono = np.concatenate([
        np.zeros(int(round(lead_s * sr)), dtype=np.float32),
        body,
        np.zeros(int(round(tail_s * sr)), dtype=np.float32),
    ])
    return np.stack([mono, mono], axis=1).reshape(-1)


SUMMARY = """[Parsed_ebur128_0 @ 0x55d] Summary:

  Integrated loudness:
    I:         -12.3 LUFS
    Threshold: -22.4 LUFS

  Loudness range:
    LRA:         6.1 LU
    Threshold: -32.5 LUFS
    LRA low:   -17.0 LUFS
    LRA high:  -10.9 LUFS

  Sample peak:
    Peak:       -0.4 dBFS

  True peak:
    Peak:        0.3 dBFS
"""

STDERR_HEAD = """Input #0, flac, from 'x.flac':
  Duration: 00:03:05.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)
Stream mapping:
  Stream #0:0 -> #0:0 (flac (native) -> pcm_f32le (native))
Output #0, f32le, to 'pipe:1':
  Stream #0:0: Audio: pcm_f32le, 96000 Hz, stereo, flt, 6144 kb/s
"""


# ── pure parsers ────────────────────────────────────────────────────────────

def t_summary_parses_all_four_figures():
    got = aw.parse_ebur128_summary("frame noise I: -99.0 LUFS\n" + SUMMARY)
    assert got == {"loudness_lufs": -12.3, "lra_lu": 6.1, "sample_peak_db": -0.4, "true_peak_db": 0.3}, got


def t_summary_reads_silence_as_no_loudness():
    silent = SUMMARY.replace("-12.3 LUFS", "-70.0 LUFS").replace("0.3 dBFS", "-inf dBFS")
    got = aw.parse_ebur128_summary(silent)
    assert got["loudness_lufs"] is None and got["true_peak_db"] is None, got


def t_output_rate_is_the_output_streams_not_the_inputs():
    assert aw.parse_output_rate(STDERR_HEAD) == 96000
    resampled = STDERR_HEAD.replace("pcm_f32le, 96000 Hz", "pcm_f32le, 48000 Hz")
    assert aw.parse_output_rate(resampled) == 48000
    assert aw.parse_output_rate("Input #0\n  Stream #0:0: Audio: mp3, 44100 Hz") is None


def feed_log(text):
    log = aw.FfmpegLog()
    for line in text.splitlines(keepends=True):
        log.feed(line)
    return log


def t_log_read_a_line_at_a_time_gives_what_the_whole_text_did():
    frames = frames_text([(i / 10.0, -14.0 - (i % 5) / 10.0) for i in range(1, 120)])
    text = STDERR_HEAD + frames + "\n" + SUMMARY
    log = feed_log(text)
    assert aw.parse_ebur128_summary(log.summary_text()) == aw.parse_ebur128_summary(text)
    assert aw.parse_output_rate(log.output_text()) == 96000
    assert dict((i, log.frames[i]) for i in log.frames) == aw.parse_ebur128_frames(text)
    assert aw.loudness_curve_from_frames(log.frames) == aw.loudness_curve_from_frames(aw.parse_ebur128_frames(text))
    # The frame lines themselves are not kept: only the short tail of the rest.
    assert "TARGET" not in log.failure_text(), log.failure_text()


def t_log_finds_the_output_rate_past_a_long_tag():
    # Input tags are copied to the output header; a lyrics tag prints a line
    # per lyric line before the PCM stream line.
    lyrics = "".join(f"                    : verse line {i}\n" for i in range(300))
    head = STDERR_HEAD.replace("Output #0, f32le, to 'pipe:1':\n",
                               "Output #0, f32le, to 'pipe:1':\n  Metadata:\n    lyrics          : first\n" + lyrics)
    assert aw.parse_output_rate(feed_log(head).output_text()) == 96000


def t_log_failure_text_keeps_the_first_error_and_the_tail():
    chatter = "".join(f"[mp3 @ 0x1] skipping frame {i}\n" for i in range(500))
    log = feed_log("http://navi:4533/rest/stream?t=secret: Invalid data found\n" + chatter + "Conversion failed!\n")
    got = aw.ffmpeg_failure_reason(log.failure_text())
    assert got.startswith("http://navi:4533/… Invalid data found"), got
    assert "secret" not in got, got


def t_frame_log_reads_like_the_dict():
    frames = aw.FrameLog()
    for idx, tenths in ((30, -140), (31, -141), (35, -1000)):
        frames[idx] = tenths
    assert len(frames) == 3 and list(frames) == [30, 31, 35] and max(frames) == 35
    assert 31 in frames and 32 not in frames and -1 not in frames and frames[35] == -1000
    frames[10 ** 9] = -100  # a corrupt timestamp: dropped, never allocated
    assert len(frames) == 3 and max(frames) == 35


def t_failure_reason_redacts_stream_credentials():
    err = "http://navi:4533/rest/stream?u=dj&t=secret&s=salt: Invalid data found\nConversion failed!"
    got = aw.ffmpeg_failure_reason(err)
    assert "secret" not in got and "salt" not in got, got
    assert got.startswith("http://navi:4533/… Invalid data found"), got


# ── edge scanner ────────────────────────────────────────────────────────────

def scan(buf, sr, chunk):
    s = aw.EdgeScanner(channels=2)
    for i in range(0, len(buf), chunk):
        s.feed(buf[i:i + chunk])
    return s.result(sr)


def t_edges_measure_lead_tail_and_exact_duration():
    sr = 44100
    buf = stereo(0.5, 2.0, 1.25, sr)
    lead, tail, dur = scan(buf, sr, 65536)
    assert dur == 3750, dur
    # The tone starts at zero crossing: its first sample above -50 dBFS is a
    # few samples in, so the lead reads a hair over 500 ms, never under.
    assert 500 <= lead <= 501, lead
    assert 1250 <= tail <= 1251, tail


def t_edges_do_not_depend_on_chunking():
    sr = 48000
    buf = stereo(0.25, 1.0, 0.75, sr)
    want = scan(buf, sr, len(buf))
    # Odd chunk sizes split frames mid-way (and mid-sample-pair).
    for chunk in (1, 7, 1023, 4097):
        assert scan(buf, sr, chunk) == want, (chunk, scan(buf, sr, chunk), want)


def t_edges_use_the_absolute_floor():
    sr = 8000
    floor = aw.SILENCE_DBFS
    quiet = np.full(sr * 2, amp_db(floor + 0.5), dtype=np.float32)  # just above: music
    under = np.full(sr * 2, amp_db(floor - 0.5), dtype=np.float32)  # just below: silence
    buf = np.concatenate([under, quiet, under])
    lead, tail, dur = scan(buf, sr, 999)  # mono-in-stereo pairs: 1 s each side
    assert (lead, tail, dur) == (1000, 1000, 3000), (lead, tail, dur)


def t_edges_of_a_silent_file_are_unknown_but_its_length_is_not():
    sr = 44100
    lead, tail, dur = scan(np.zeros(sr * 2 * 3, dtype=np.float32), sr, 4096)
    assert (lead, tail, dur) == (None, None, 3000), (lead, tail, dur)


# ── facet wiring ────────────────────────────────────────────────────────────

def fake_measure(calls, loud=None, edges=(500, 1000, 200000)):
    loud = loud if loud is not None else {"loudness_lufs": -12.3, "lra_lu": 6.1, "sample_peak_db": -0.4, "true_peak_db": 0.3}

    def measure(src, loudness=True, edges_wanted=True, timeout_s=None):
        calls.append((src, loudness, edges_wanted))
        return {"loudness": dict(loud) if loudness else None, "edges": edges if edges_wanted else None, "seconds": 1.0}
    return measure


def t_both_facets_share_one_decode():
    calls = []
    with Patched(measure_whole_file=fake_measure(calls)):
        out = aw.whole_file_facets("http://navi/stream", ["loudness", "edges"])
    assert calls == [("http://navi/stream", True, True)], calls
    assert out["loudness"] == {"status": "ok", "data": {
        "loudness_lufs": -12.3, "peak_db": 0.3, "sample_peak_db": -0.4, "lra_lu": 6.1,
        "loudness_version": aw.WHOLE_FILE_LOUDNESS_VERSION}}, out
    assert out["edges"] == {"status": "ok", "data": {
        "edge_lead_ms": 500, "edge_tail_ms": 1000, "decoded_duration_ms": 200000}}, out


def t_one_facet_asks_only_for_its_half():
    calls = []
    with Patched(measure_whole_file=fake_measure(calls)):
        out = aw.whole_file_facets("/x.flac", ["edges"])
    assert calls == [("/x.flac", False, True)] and list(out) == ["edges"], (calls, out)


def t_silence_is_unmeasurable_not_failed():
    silent = {"loudness_lufs": None, "lra_lu": None, "sample_peak_db": None, "true_peak_db": None}
    with Patched(measure_whole_file=fake_measure([], loud=silent, edges=(None, None, 4000))):
        out = aw.whole_file_facets("/x.flac", ["loudness", "edges"])
    assert out["loudness"] == {"status": "unmeasurable", "reason": "silent"}, out
    assert out["edges"] == {"status": "unmeasurable", "reason": "silent-file"}, out


def t_empty_decode_fails_the_edges():
    with Patched(measure_whole_file=fake_measure([], edges=(None, None, 0))):
        out = aw.whole_file_facets("/x.flac", ["edges"])
    assert out["edges"]["status"] == "failed", out


def t_a_failed_decode_fails_both_with_the_reason():
    def boom(*_a, **_k):
        raise RuntimeError("ffmpeg exited 1: Invalid data found")
    with Patched(measure_whole_file=boom):
        out = aw.whole_file_facets("/x.flac", ["loudness", "edges"])
    assert out == {
        "loudness": {"status": "failed", "reason": "ffmpeg exited 1: Invalid data found"},
        "edges": {"status": "failed", "reason": "ffmpeg exited 1: Invalid data found"},
    }, out


def t_no_whole_file_source_leaves_edges_unmeasurable():
    out = aw.whole_file_facets(None, ["edges"])
    assert out == {"edges": {"status": "unmeasurable", "reason": "no-whole-file-source"}}, out


def t_whole_file_input_rule():
    # A complete local copy is read in place; anything less streams the URL.
    assert aw.whole_file_input("/tmp/x.flac", True, "http://u") == "/tmp/x.flac"
    assert aw.whole_file_input("/tmp/x.flac", False, "http://u") == "http://u"
    assert aw.whole_file_input("/tmp/x.flac", None, "http://u") == "http://u"
    assert aw.whole_file_input(None, None, "http://u") == "http://u"
    assert aw.whole_file_input("/tmp/x.flac", False, None) is None


def t_whole_file_only_request_never_opens_the_capped_source():
    calls = []

    def no_source(*_a, **_k):
        raise AssertionError("the capped download was fetched")
    with Patched(measure_whole_file=fake_measure(calls), fetch_audio=no_source,
                 ensure_fast_decode=no_source):
        got = aw.analyze_facet_request(None, {"facets": ["loudness", "edges"], "url": "http://navi/stream"})
    assert calls == [("http://navi/stream", True, True)], calls
    assert got["facets"]["edges"]["status"] == "ok", got
    assert got["source"] == {"kind": "whole-file", "duration_s": 200.0, "complete": True}, got


def t_path_request_streams_the_url_when_the_copy_is_capped():
    calls = []

    class Src:
        duration_s = 200.0
        complete = False

        def load(self, *_a, **_k):
            return np.zeros((2, 100), dtype=np.float32), 22050

        def tail(self, *_a):
            return "capped-download"

    with Patched(measure_whole_file=fake_measure(calls)):
        out = aw.analyze_facets(None, Src(), ["edges"], whole_input="http://navi/stream")
    assert calls == [("http://navi/stream", False, True)] and out["edges"]["status"] == "ok", (calls, out)


def t_window_loudness_is_kept_without_a_whole_file_source():
    # An older controller sends no stream URL: the loudness facet answers with
    # the analysis window's figures exactly as before, stamped with no version.
    class Src:
        duration_s = 200.0

        def load(self, *_a, **_k):
            return np.full((2, 22050), 0.1, dtype=np.float32), 22050

    class Lib:
        @staticmethod
        def to_mono(buf):
            return np.asarray(buf).mean(axis=0)

    with Patched(measure_loudness=lambda *_a, **_k: (-11.0, -1.5),
                 measure_whole_file=lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("whole file read"))):
        out = aw.analyze_facets(Lib, Src(), ["loudness"])
    assert out["loudness"] == {"status": "ok", "data": {"loudness_lufs": -11.0, "peak_db": -1.5}}, out


# ── end to end (ffmpeg) ─────────────────────────────────────────────────────

def write_wav(path, buf, sr):
    pcm = np.clip(buf, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(round(v * 32767))) for v in pcm))


def t_real_ffmpeg_decodes_once_and_measures_both():
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    sr = 44100
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.wav")
        write_wav(path, stereo(0.5, 4.0, 1.0, sr, amp=amp_db(-6.0)), sr)
        got = aw.measure_whole_file(path, loudness=True, edges_wanted=True, timeout_s=60)
    lead, tail, dur = got["edges"]
    assert dur == 5500, got
    assert 500 <= lead <= 502 and 999 <= tail <= 1001, got
    loud = got["loudness"]
    assert math.isfinite(loud["loudness_lufs"]) and -12 < loud["loudness_lufs"] < -6, loud
    assert abs(loud["true_peak_db"] - (-6.0)) < 0.5, loud
    assert loud["sample_peak_db"] <= loud["true_peak_db"] + 0.05, loud


# ── the loudness curve (ebur128 per-frame short-term) ──────────────────────

def frame_line(t, s):
    return (f"[Parsed_ebur128_0 @ 0x55d] t: {t:<10g} TARGET:-23 LUFS    M: {s:6.1f} S:{s:6.1f}     "
            f"I: -21.8 LUFS       LRA:   0.0 LU  SPK: -18.1 dBFS  FTPK: -18.1 dBFS  TPK: -18.1 dBFS")


def frames_text(series):
    """ffmpeg-like lines for [(t_s, S)], t stamped a hair under each tenth."""
    return "\n".join(frame_line(t - 0.0000227, s) for t, s in series)


def t_curve_frames_parse_t_and_short_term_and_floor_silence():
    text = frames_text([(0.1, -120.7), (2.9, -120.7), (3.0, -21.8), (3.1, -21.84)])
    text += "\n[Parsed_ebur128_0 @ 0x1] t: 3.2  TARGET:-23 LUFS    M:   nan S:  -inf     I: -21.9 LUFS"
    text += "\n" + SUMMARY  # the summary block is never read as a frame
    got = aw.parse_ebur128_frames(text)
    assert got == {1: -1000, 29: -1000, 30: -218, 31: -218, 32: -1000}, got


def t_curve_whole_head_and_tail_series():
    # 2 s of silence, music to 120 s, then 60 s of silence (a long silent tail).
    series = [(i / 10.0, -120.7 if i < 50 or i > 1200 else -14.0 - (i % 7) / 10.0) for i in range(1, 1801)]
    curve = aw.loudness_curve_from_frames(aw.parse_ebur128_frames(frames_text(series)))
    whole, head, tail = curve["whole"], curve["head"], curve["tail"]
    assert (whole["startMs"], whole["stepMs"], len(whole["lufs"])) == (3000, 1000, 178), whole
    assert whole["lufs"][0] == -1000 and whole["lufs"][3] in range(-146, -139), whole["lufs"][:5]
    # head: from the first full window (3 s) to 30 s after the music starts (5 s).
    assert (head["startMs"], head["stepMs"], len(head["lufs"])) == (3000, 500, 65), head
    # tail: anchored on where the MUSIC stops (120 s), not on the file's end (180 s).
    assert (tail["startMs"], tail["stepMs"]) == (90000, 500), tail
    assert tail["startMs"] + (len(tail["lufs"]) - 1) * 500 == 125000, tail
    assert tail["lufs"][-1] == -1000 and tail["lufs"][0] > -150, tail["lufs"][-3:]


def t_curve_edge_cases():
    assert aw.loudness_curve_from_frames({}) is None, "no frame line at all: stays due"
    short = aw.loudness_curve_from_frames({1: -200, 20: -200})
    assert short == {"whole": {"startMs": 3000, "stepMs": 1000, "lufs": []}}, short
    silent = aw.loudness_curve_from_frames({i: -1000 for i in range(1, 100)})
    assert set(silent) == {"whole"} and set(silent["whole"]["lufs"]) == {-1000}, silent


def t_curve_rides_the_loudness_answer():
    def fake(src, loudness=True, edges_wanted=True, timeout_s=None):
        fig = aw.parse_ebur128_summary(SUMMARY)
        fig["loudness_curve"] = {"whole": {"startMs": 3000, "stepMs": 1000, "lufs": [-120]}}
        return {"loudness": fig, "edges": None, "seconds": 0.1}
    with Patched(measure_whole_file=fake):
        got = aw.whole_file_facets("http://navi/stream", ["loudness"])
    assert got["loudness"]["data"]["loudness_curve"]["whole"]["lufs"] == [-120], got


def t_real_ffmpeg_prints_the_curve():
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    sr = 44100
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.wav")
        write_wav(path, stereo(0.5, 8.0, 1.0, sr, amp=amp_db(-6.0)), sr)
        got = aw.measure_whole_file(path, loudness=True, edges_wanted=True, timeout_s=60)
    curve = got["loudness"]["loudness_curve"]
    whole = curve["whole"]["lufs"]
    integrated = got["loudness"]["loudness_lufs"]
    # A steady tone: the short-term figure sits on the integrated one.
    assert len(whole) == 7 and abs(whole[2] / 10.0 - integrated) < 1.0, (whole, integrated)
    # The tail ends 5 s past the music or at the file's end, here 1 s after
    # the tone: that point's 3 s window still holds 2 s of it (about -1.8 dB).
    tail = curve["tail"]["lufs"]
    assert tail[-1] < tail[-4] - 10, f"the curve falls once the tone stops: {tail[-5:]}"
    assert got["edges"][2] == 9500, "edges still read off the same decode"


def t_real_ffmpeg_caps_the_rate_so_ultrasonic_noise_reads_as_silence():
    # A DSD source decodes at 352.8 kHz with loud noise above the audio band;
    # here a 96 kHz file whose tone stops at 4.5 s and a 30 kHz sine at
    # -20 dBFS runs on to 8 s. Measured at the file's rate the sine kept the
    # curve near -30 LUFS and the edges scan found no trailing silence.
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    sr = 96000
    n = 8 * sr
    t = np.arange(n, dtype=np.float64) / sr
    tone = np.where((t >= 0.5) & (t < 4.5), amp_db(-6.0) * np.sin(2 * np.pi * 1000.0 * t), 0.0)
    # The noise ends with a 0.2 s fade as a real file does: a 30 kHz sine cut
    # dead at the last sample rings through the resampler's final 10 ms.
    fade_out = np.clip((8.0 - t) / 0.2, 0.0, 1.0)
    ultra = np.where(t >= 0.5, amp_db(-20.0) * np.sin(2 * np.pi * 30000.0 * t), 0.0) * fade_out
    mono = (tone + ultra).astype(np.float32)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "hires.wav")
        write_wav(path, np.stack([mono, mono], axis=1).reshape(-1), sr)
        got = aw.measure_whole_file(path, loudness=True, edges_wanted=True, timeout_s=60)
    lead, tail, duration = got["edges"]
    assert abs(duration - 8000) <= 25, got["edges"]
    assert abs(tail - 3500) <= 150, f"trailing silence after the tone: {got['edges']}"
    curve = got["loudness"]["loudness_curve"]["whole"]["lufs"]
    assert curve[-1] < -600, f"the curve falls to silence once the tone stops: {curve}"


def t_probe_failure_measures_the_file_as_it_is():
    assert aw.probe_audio_format("/nonexistent/file.flac") == (None, None, None)


def t_real_ffmpeg_measures_a_surround_file_as_its_stereo_downmix():
    # Liquidsoap airs a 5.1 file as fronts 1 + centre and surrounds 0.707, no
    # LFE, unnormalised. Measured on six channels it read louder than that;
    # downmixed into integers (ffmpeg normalises there) 7.6 dB quieter.
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    sr = 96000
    t = np.arange(4 * sr, dtype=np.float64) / sr
    amp = amp_db(-12.0)
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "six.wav")
        stereo_ref = os.path.join(d, "ref.wav")
        chans = [amp * np.sin(2 * np.pi * f * t) for f in (300.0, 500.0, 700.0, 60.0, 900.0, 1100.0)]
        six = np.stack(chans, axis=1).astype(np.float32)
        import soundfile as sf  # the analyzer image has it (the worker's tail path reads with it)
        sf.write(src, six, sr, subtype="FLOAT")
        # The air: L = FL + 0.707 FC + 0.707 BL, R = FR + 0.707 FC + 0.707 BR.
        k = 0.7071067811865476
        left = chans[0] + k * chans[2] + k * chans[4]
        right = chans[1] + k * chans[2] + k * chans[5]
        sf.write(stereo_ref, np.stack([left, right], axis=1).astype(np.float32), sr, subtype="FLOAT")
        assert aw.probe_audio_format(src)[:2] == (sr, 6)
        got = aw.measure_whole_file(src, loudness=True, edges_wanted=True, timeout_s=60)
        ref = aw.measure_whole_file(stereo_ref, loudness=True, edges_wanted=True, timeout_s=60)
    assert abs(got["loudness"]["loudness_lufs"] - ref["loudness"]["loudness_lufs"]) < 0.15, (got["loudness"], ref["loudness"])
    assert abs(got["edges"][2] - 4000) <= 25, got["edges"]


def t_window_loudness_measures_a_surround_decode_as_its_stereo_downmix():
    # The default (window) path: librosa decodes a 5.1 file as six rows and
    # pyloudnorm refused it ("five channels or less"), so the track had no
    # loudness at all. Now: the stereo downmix, matching ffmpeg's float -ac 2
    # (= Liquidsoap's) for 5.1 and 7.1.
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    try:
        import pyloudnorm  # noqa: F401 — optional; the lean venvs lack it
        import soundfile as sf
    except ImportError:
        print("      (skipped: no pyloudnorm/soundfile)")
        return
    sr = 48000
    t = np.arange(4 * sr, dtype=np.float64) / sr
    for count, layout in ((6, "5.1"), (8, "7.1")):
        rows = np.stack([amp_db(-14.0) * np.sin(2 * np.pi * (200.0 + 130.0 * k) * t) for k in range(count)])
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "multi.wav")
            sf.write(src, rows.T.astype(np.float32), sr, subtype="FLOAT")
            import subprocess
            out = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", src, "-af", "aformat=sample_fmts=flt:channel_layouts=stereo",
                 "-f", "f32le", "-"], capture_output=True, check=True).stdout
        ref = np.frombuffer(out, dtype="<f4").reshape(-1, 2).T
        got, peak = aw.measure_loudness(rows, sr)
        want, _ = aw.measure_loudness(ref, sr)
        assert got is not None and peak is not None, f"{layout}: measured at all"
        assert abs(got - want) < 0.15, (layout, got, want)
    # Mono and stereo decodes are untouched.
    stereo = np.stack([np.sin(2 * np.pi * 440.0 * t), np.sin(2 * np.pi * 550.0 * t)]) * 0.2
    assert aw.stereo_downmix(stereo) is stereo


# ── an input that ends early ────────────────────────────────────────────────

def t_probe_reads_the_streams_length_and_distrusts_an_estimate():
    out = '{"streams": [{"sample_rate": "44100", "channels": 2, "duration": "60.000000"}], "format": {"duration": "61.5"}}'
    assert aw.parse_probe(out) == (44100, 2, 60000)
    no_stream_len = '{"streams": [{"sample_rate": "48000", "channels": 1}], "format": {"duration": "61.5"}}'
    assert aw.parse_probe(no_stream_len) == (48000, 1, 61500), "the container's length stands in"
    guessed = "[mp3 @ 0x1] Estimating duration from bitrate, this may be inaccurate\n"
    assert aw.parse_probe(out, guessed) == (44100, 2, None), "a length guessed from the bitrate judges nothing"
    assert aw.parse_probe("not json") == (None, None, None)
    assert aw.parse_probe('{"streams": [{"duration": "N/A"}]}') == (None, None, None)


def t_a_decode_well_short_of_the_header_is_cut_off():
    assert aw.decoded_short_of(240_000, 120_000)
    assert aw.decoded_short_of(60_000, 54_000), "6 s short of a minute"
    assert not aw.decoded_short_of(60_000, 59_950), "encoder padding is milliseconds"
    assert not aw.decoded_short_of(60_000, 56_000), "under the 5 s floor"
    assert aw.decoded_short_of(25_200_000, 24_500_000), "12 min short of a 7 h set"
    assert not aw.decoded_short_of(25_200_000, 24_800_000), "under 2 % of a 7 h set"
    assert not aw.decoded_short_of(None, 1000) and not aw.decoded_short_of(60_000, None)
    assert not aw.decoded_short_of(102_900, 133_600), "a decode LONGER than the tag is the file playing on"


def t_log_flags_an_input_that_ended_early():
    log = feed_log(STDERR_HEAD + "[http @ 0x5] Stream ends prematurely at 469387, should be 938774\n"
                   "http://navi:4533/rest/stream?u=dj&t=secret: Input/output error\n" + SUMMARY)
    assert log.input_error == "[http @ 0x5] Stream ends prematurely at 469387, should be 938774", log.input_error
    io = feed_log("http://navi:4533/rest/stream?u=dj&t=secret: Input/output error\n")
    assert io.input_error == "http://navi:4533/… Input/output error", io.input_error
    assert feed_log(STDERR_HEAD + SUMMARY).input_error is None
    # A server that sent no Content-Length: even a complete read ends this way
    # (ffmpeg 5.1 expects 2^64 - 1 bytes), so the length check judges it.
    unknown = feed_log("[http @ 0x5] Stream ends prematurely at 938774, should be 18446744073709551615\n"
                       "http://navi:4533/rest/stream?t=secret: Input/output error\n" + SUMMARY)
    assert unknown.input_error is None, unknown.input_error
    reset = feed_log("[http @ 0x5] Stream ends prematurely at 1, should be 18446744073709551615\n"
                     "[tcp @ 0x6] Connection reset by peer\n")
    assert reset.input_error == "[tcp @ 0x6] Connection reset by peer", reset.input_error


class _Server:
    """A local music server for one file: /full serves it whole, /cut sends a
    Content-Length for all of it and drops the connection halfway; /nolen and
    /nolen-cut send all of it or half, with no length, and close (the two
    read the same to ffmpeg's log)."""

    def __init__(self, path):
        import http.server
        import threading
        data = open(path, "rb").read()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 — http.server's name
                mode = self.path.split("?")[0].strip("/")
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                if not mode.startswith("nolen"):
                    self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data if mode in ("full", "nolen") else data[: len(data) // 2])
                self.close_connection = True

            def log_message(self, *_a):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def t_real_ffmpeg_fails_a_cut_off_stream_instead_of_measuring_it():
    # ffmpeg exits 0 on a dropped connection with what it decoded. Stored, half
    # a track became a whole-file loudness and a decoded length that ended the
    # track early on air, protected from every later measurement.
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        print("      (skipped: no ffmpeg/ffprobe on PATH)")
        return
    sr = 22050
    with tempfile.TemporaryDirectory() as d:
        wav = os.path.join(d, "x.wav")
        write_wav(wav, stereo(0.5, 11.0, 0.5, sr, amp=amp_db(-6.0)), sr)
        # FLAC: its header carries the length even over a stream with no
        # Content-Length (a WAV's does not, so ffprobe gives it none there).
        path = os.path.join(d, "x.flac")
        import subprocess
        subprocess.run(["ffmpeg", "-v", "error", "-i", wav, path], check=True)
        server = _Server(path)
        try:
            for mode in ("full", "nolen"):
                whole = aw.whole_file_facets(f"{server.base}/{mode}?u=dj&t=secret", ["loudness", "edges"])
                assert whole["edges"]["status"] == "ok" and whole["loudness"]["status"] == "ok", (mode, whole)
                assert abs(whole["edges"]["data"]["decoded_duration_ms"] - 12000) <= 25, (mode, whole)
            for mode, says in (("cut", "prematurely"), ("nolen-cut", "decoded")):
                got = aw.whole_file_facets(f"{server.base}/{mode}?u=dj&t=secret", ["loudness", "edges"])
                for facet in ("loudness", "edges"):
                    assert got[facet]["status"] == "failed", (mode, got)
                    reason = got[facet]["reason"]
                    assert "ended early" in reason and says in reason, (mode, reason)
                    assert "secret" not in reason, (mode, reason)
        finally:
            server.close()


def t_real_ffmpeg_failure_raises_with_the_reason():
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.flac")
        with open(path, "wb") as f:
            f.write(b"not audio at all" * 64)
        try:
            aw.measure_whole_file(path, loudness=True, edges_wanted=True, timeout_s=60)
        except RuntimeError as e:
            assert "ffmpeg exited" in str(e), e
            return
    raise AssertionError("garbage decoded")


# ── one-shot mode (the sidecar's whole-file lane) ───────────────────────────

def one_shot(req):
    import json
    import subprocess
    worker = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze_worker.py")
    p = subprocess.run([sys.executable, worker, "--whole-file"], input=json.dumps(req), text=True,
                       capture_output=True, timeout=60)
    lines = [l for l in p.stdout.splitlines() if l.strip()]
    assert p.returncode == 0 and len(lines) == 1, (p.returncode, p.stdout, p.stderr[-400:])
    return json.loads(lines[0])


def t_one_shot_refuses_window_facets():
    # The lane exists for requests with no model and no window decode; a head
    # request must go through the worker pool.
    got = one_shot({"facets": ["loudness", "head"], "url": "http://navi/stream"})
    assert got["ok"] is False and "whole-file" in got["error"], got


def t_one_shot_answers_in_the_facet_shape():
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    sr = 44100
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "x.wav")
        write_wav(path, stereo(0.5, 2.0, 1.0, sr, amp=amp_db(-6.0)), sr)
        got = one_shot({"facets": ["edges", "loudness"], "path": path, "complete": True})
    assert got["ok"] is True, got
    assert list(got["facets"]) == ["loudness", "edges"], got
    assert got["facets"]["edges"]["data"]["decoded_duration_ms"] == 3500, got
    assert "whole" in got["facets"]["loudness"]["data"]["loudness_curve"], got
    assert got["source"]["kind"] == "whole-file", got


def t_one_shot_redacts_a_failing_url():
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg on PATH)")
        return
    got = one_shot({"facets": ["edges"], "url": "http://127.0.0.1:9/rest/stream?u=dj&t=secret&s=salt"})
    assert got["ok"] is True and got["facets"]["edges"]["status"] == "failed", got
    assert "secret" not in json_dump(got), got


def json_dump(v):
    import json
    return json.dumps(v)


if __name__ == "__main__":
    print("analyzer whole-file facets")
    for name, fn in list(globals().items()):
        if name.startswith("t_") and callable(fn):
            test(name[2:].replace("_", " "), fn)
    if failures:
        print(f"FAIL: {failures} case(s)")
        sys.exit(1)
    print("PASS")
