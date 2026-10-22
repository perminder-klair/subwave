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
