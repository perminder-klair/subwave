#!/usr/bin/env python3
# Contract tests for the tail facet placed from the stored edges (tail v2).
# Run: `npm test -- analyzer-python` (this suite is one of the shim's SUITES),
# or `python3 scripts/analyzer_tail_placement_test.py` (exit 0 = pass).
#
# numpy is the one dependency; librosa is the same tiny numpy fake as
# analyzer_facets_test.py, and ffmpeg is never run (its command is built by a
# pure function, which is what is pinned).
#
# Why this is pinned:
#
#   * The tail window used to be the file's last ANALYZE_OUTRO_SECONDS. When a
#     track ends in silence that window is partly or wholly silent: the ending
#     reads as a fade (the silence is the "decline"), the tail grid and the
#     tail vocals are measured on nothing, and a window that is ALL silence
#     leaves the tail unmeasurable. The controller now sends where the music
#     stops (`tail_window`: end_ms = decoded duration - trailing silence, from
#     the edges facet) and the window ENDS there.
#   * The answer says it was placed (`tail_window: "edges"`), so the controller
#     stamps tail v2 only for a window that was really placed; an older
#     analyzer ignores the field and its answer stays v1.
#   * Every timestamp stays ABSOLUTE, the trailing-silence fields come from the
#     edges (the placed window holds no trailing silence by construction), and
#     the Demucs tail (vocals, stems, tail meta) uses the same placed window.
#   * A local copy that cannot prove it reaches the window (the controller's
#     byte-capped download) no longer makes the tail unmeasurable: the worker
#     decodes just the window from the stream URL. MP3 and unknown formats
#     seek on the OUTPUT side: ffmpeg's MP3 input seek goes through a Xing TOC
#     or the average bitrate, which is not guaranteed to land on the sample in
#     a VBR file, and every absolute timestamp would shift with it.

import os
import sys
import tempfile

try:
    import numpy as np
except ImportError:
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

SR = aw.ANALYZE_SR
failures = 0


# The same numpy stand-ins as analyzer_facets_test.py (which runs its suite on
# import, so it is not imported from).
def tone(sec, amp=0.5, sr=SR):
    t = np.arange(int(sr * sec), dtype=np.float32) / sr
    return (amp * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)


def silence(sec, sr=SR):
    return np.zeros(int(sr * sec), dtype=np.float32)


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


class Patched:
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


def fixed_loudness(*_a, **_k):
    return (-11.0, -1.5)


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


class PlacedSource:
    """A source that records the placement it was asked for and hands back a
    window of `y` starting at the placed offset."""

    def __init__(self, y, duration_s=200.0, eof=None):
        self.y = y
        self.duration_s = duration_s
        self.placements = []
        self.loads = []
        self.eof = eof

    def load(self, librosa, sr, mono, offset=0.0, duration=None):
        self.loads.append(("load", sr, round(offset, 3), duration))
        return self.y, sr

    def load_tail(self, librosa, sr, mono, offset=0.0, duration=None):
        self.loads.append(("tail", sr, round(offset, 3), duration))
        return self.y, sr

    def tail(self, librosa, placement=None):
        self.placements.append(placement)
        if placement is None:
            return self.eof if self.eof is not None else (self.y, SR, self.duration_s - aw.OUTRO_SECONDS)
        offset, _length = aw.place_tail_window(placement["end_ms"])
        return self.y, SR, offset


class Detector:
    def __init__(self, calls):
        self.calls = calls

    def separate(self, y):
        self.calls.append("separate")
        return {"vocals": y}

    def detect(self, y, sr, librosa, min_loud=None, stems=None):
        return [{"startMs": 1000, "endMs": 3000}]


# ── placement ───────────────────────────────────────────────────────────────

def t_place_tail_window_ends_where_the_music_stops():
    off, length = aw.place_tail_window(180_000)
    assert (off, length) == (180.0 - aw.OUTRO_SECONDS, aw.OUTRO_SECONDS), (off, length)
    # A track shorter than the window starts at zero and ends at the music.
    assert aw.place_tail_window(15_000) == (0.0, 15.0)


def t_parse_tail_window_refuses_what_cannot_be_placed():
    ok = aw.parse_tail_window({"end_ms": 180_000, "duration_ms": 200_000})
    assert ok == {"end_ms": 180_000, "duration_ms": 200_000}, ok
    for bad in (None, {}, "x", {"end_ms": 0, "duration_ms": 200_000},
                {"end_ms": 210_000, "duration_ms": 200_000}, {"end_ms": -1, "duration_ms": 5},
                {"end_ms": "180000", "duration_ms": 200_000}, {"end_ms": True, "duration_ms": 200_000}):
        assert aw.parse_tail_window(bad) is None, bad


def t_edges_answer_gives_the_placement():
    edges = {"status": "ok", "data": {"edge_lead_ms": 0, "edge_tail_ms": 20_000, "decoded_duration_ms": 200_000}}
    assert aw.tail_window_from_edges(edges) == {"end_ms": 180_000, "duration_ms": 200_000}
    assert aw.tail_window_from_edges({"status": "unmeasurable", "reason": "silent"}) is None
    assert aw.tail_window_from_edges(None) is None
    # A wholly silent file has nothing to place a window on.
    silent = {"status": "ok", "data": {"edge_lead_ms": 0, "edge_tail_ms": 200_000, "decoded_duration_ms": 200_000}}
    assert aw.tail_window_from_edges(silent) is None


# ── the tail facet over a placed window ─────────────────────────────────────

def t_a_placed_tail_ends_at_the_music_and_reads_a_cold_ending():
    # 20 s of full-level music right up to the stored music end: the old
    # end-of-file window would have held 20 s of trailing silence instead.
    y = tone(20.0)
    src = PlacedSource(y)
    with Patched(measure_loudness=fixed_loudness, log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, src, ["tail"],
                                tail_window={"end_ms": 180_000, "duration_ms": 200_000})
    assert src.placements == [{"end_ms": 180_000, "duration_ms": 200_000}], src.placements
    tail = out["tail"]
    assert tail["status"] == "ok", tail
    data = tail["data"]
    assert data["tail_window"] == "edges", data
    # The trailing-silence fields come from the edges, not from the window.
    assert data["tail_silence_ms"] == 20_000 and data["tail_start_ms"] == 180_000, data
    outro = data["outro"]
    assert outro["ending"] == "cold", outro
    assert 160_000 <= outro["startMs"] <= 180_000, outro


def t_an_unplaced_tail_is_not_marked():
    y = np.concatenate([tone(12.0), silence(8.0)])
    with Patched(measure_loudness=fixed_loudness, log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, PlacedSource(y), ["tail"])
    assert "tail_window" not in out["tail"]["data"], out


def t_placed_tail_vocals_and_stems_use_the_placed_window():
    calls, written = [], []
    y = tone(20.0)
    src = PlacedSource(y)
    with Patched(get_vocal_detector=lambda force=False: Detector(calls), measure_loudness=fixed_loudness,
                 write_stems=lambda stems, window, d: written.append(window),
                 write_tail_meta=lambda d, off, dur: written.append(("meta", round(off, 3), round(dur, 3))),
                 log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, src, ["tail", "vocal", "stems"], stems_dir="/x",
                                tail_window={"end_ms": 180_000, "duration_ms": 200_000})
    start = 180.0 - aw.OUTRO_SECONDS
    # Demucs read the placed window through the tail loader, not the file end.
    assert ("tail", aw.DEMUCS_SR, start, aw.OUTRO_SECONDS) in src.loads, src.loads
    assert ("meta", start, 200.0) in written, written
    shift = int(start * 1000)
    assert out["vocal"]["data"]["tail_vocal_ranges"] == [
        {"startMs": shift + 1000, "endMs": shift + 3000}], out
    assert out["tail"]["data"]["tail_window"] == "edges", out


def t_tail_only_vocals_use_the_placed_window():
    calls = []
    src = PlacedSource(tone(20.0))
    with Patched(get_vocal_detector=lambda force=False: Detector(calls), measure_loudness=fixed_loudness,
                 log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, src, ["tail"], want_tail_vocals=True,
                                tail_window={"end_ms": 180_000, "duration_ms": 200_000})
    shift = int((180.0 - aw.OUTRO_SECONDS) * 1000)
    assert out["tail"]["data"]["outro"]["vocalRanges"] == [{"startMs": shift + 1000, "endMs": shift + 3000}], out


def t_edges_measured_in_the_same_request_place_the_tail():
    src = PlacedSource(tone(20.0))
    edges = {"edges": {"status": "ok",
                       "data": {"edge_lead_ms": 0, "edge_tail_ms": 20_000, "decoded_duration_ms": 200_000}}}
    with Patched(whole_file_facets=lambda _src, _wanted: dict(edges), measure_loudness=fixed_loudness,
                 log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, src, ["tail", "edges"], whole_input="http://x/stream")
    assert src.placements == [{"end_ms": 180_000, "duration_ms": 200_000}], src.placements
    assert out["tail"]["data"]["tail_window"] == "edges", out


# ── reading the placed window ───────────────────────────────────────────────

def _write(path, head):
    with open(path, "wb") as f:
        f.write(head + b"\0" * 64)


def t_input_seek_only_where_the_format_seeks_exactly():
    d = tempfile.mkdtemp()
    cases = {"a.flac": (b"fLaC", True), "a.ogg": (b"OggS", True), "a.wav": (b"RIFF\0\0\0\0WAVE", True),
             "a.m4a": (b"\0\0\0\x20ftypM4A ", True), "a.mp3": (b"ID3\x04", False), "b.mp3": (b"\xff\xfb\x90", False),
             "a.bin": (b"????", False)}
    for name, (head, exact) in cases.items():
        p = os.path.join(d, name)
        _write(p, head)
        assert aw.input_seek_is_exact(p) is exact, name
    assert aw.input_seek_is_exact(None) is False
    assert aw.input_seek_is_exact(os.path.join(d, "missing")) is False


def t_window_ffmpeg_args_put_the_seek_on_the_right_side():
    exact = aw.window_ffmpeg_args("http://x/s", 160.0, 20.0, "/tmp/w.wav", input_seek=True)
    i = exact.index("-i")
    assert exact[exact.index("-ss") + 1] == "160.000" and exact.index("-ss") < i, exact
    late = aw.window_ffmpeg_args("http://x/s", 160.0, 20.0, "/tmp/w.wav", input_seek=False)
    assert late.index("-ss") > late.index("-i"), late
    for args in (exact, late):
        assert args[args.index("-t") + 1] == "20.000", args
        assert args[args.index("-ar") + 1] == str(aw.DEMUCS_SR) and args[args.index("-ac") + 1] == "2", args
        assert args[-1] == "/tmp/w.wav", args


def t_file_source_reads_a_complete_copy_in_place():
    loads = []

    def fake_load(_librosa, path, **kw):
        loads.append((path, round(kw.get("offset", 0.0), 3), kw.get("duration")))
        return np.stack([tone(20.0), tone(20.0)]), kw["sr"]

    src = aw.FileSource("/staged/x.flac", complete=True)
    src.duration_s = 200.0
    with Patched(load_audio=fake_load, extract_tail_window=lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("a complete copy was re-read from the stream"))):
        window = src.tail(FakeLibrosa, {"end_ms": 180_000, "duration_ms": 200_000})
        assert not isinstance(window, str), window
        _y, _sr, off = window
        assert off == 180.0 - aw.OUTRO_SECONDS, off
        src.load_tail(FakeLibrosa, sr=aw.DEMUCS_SR, mono=False, offset=off, duration=aw.OUTRO_SECONDS)
    assert loads[0] == ("/staged/x.flac", off, aw.OUTRO_SECONDS), loads
    assert loads[1] == ("/staged/x.flac", off, aw.OUTRO_SECONDS), loads


def t_file_source_reads_a_capped_copys_window_from_the_stream():
    loads, extracted = [], []

    def fake_load(_librosa, path, **kw):
        loads.append((path, round(kw.get("offset", 0.0), 3), kw.get("duration")))
        return np.stack([tone(20.0), tone(20.0)]), kw["sr"]

    def fake_extract(url, offset_s, length_s, input_seek=False):
        extracted.append((url, offset_s, length_s, input_seek))
        fd, p = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        return p

    src = aw.FileSource("/staged/x.mp3", complete=False, stream_url="http://nd/rest/stream?id=1")
    src.duration_s = 60.0  # the capped copy's own (short) length
    with Patched(load_audio=fake_load, extract_tail_window=fake_extract,
                 input_seek_is_exact=lambda _p: False):
        window = src.tail(FakeLibrosa, {"end_ms": 180_000, "duration_ms": 200_000})
        assert not isinstance(window, str), window
        _y, _sr, off = window
        src.load_tail(FakeLibrosa, sr=aw.DEMUCS_SR, mono=False, offset=off, duration=aw.OUTRO_SECONDS)
    start = 180.0 - aw.OUTRO_SECONDS
    assert extracted == [("http://nd/rest/stream?id=1", start, aw.OUTRO_SECONDS, False)], extracted
    # The extracted file starts AT the window: reads are relative to it.
    assert [(l[1], l[2]) for l in loads] == [(0.0, aw.OUTRO_SECONDS), (0.0, aw.OUTRO_SECONDS)], loads
    assert off == start
    tmp = loads[0][0]
    assert os.path.exists(tmp)
    src.close()
    assert not os.path.exists(tmp), "the extracted window outlived its source"


def t_file_source_without_a_stream_still_says_why():
    src = aw.FileSource("/staged/x.mp3", complete=False)
    assert src.tail(FakeLibrosa, {"end_ms": 180_000, "duration_ms": 200_000}) == "capped-download"


def t_a_window_that_decodes_short_is_not_reached():
    src = aw.FileSource("/staged/x.flac", complete=True)
    src.duration_s = 200.0
    with Patched(load_audio=lambda _l, _p, **kw: (tone(3.0), kw["sr"])):
        assert src.tail(FakeLibrosa, {"end_ms": 180_000, "duration_ms": 200_000}) == "tail-not-reached"


def t_a_placed_window_that_reads_silent_is_unmeasurable():
    src = PlacedSource(silence(20.0))
    with Patched(measure_loudness=fixed_loudness, log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, src, ["tail"],
                                tail_window={"end_ms": 180_000, "duration_ms": 200_000})
    assert out["tail"] == {"status": "unmeasurable", "reason": "silent-tail-window"}, out


def _onset_s(path):
    import wave
    with wave.open(path, "rb") as w:
        sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        x = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, ch)[:, 0].astype(np.float32) / 32768
    loud = np.flatnonzero(np.abs(x) > 0.05)
    return (loud[0] / sr if loud.size else None), n / sr


def t_real_ffmpeg_window_lands_on_the_sample():
    # silence 0-10 s, tone 10-25 s, silence 25-30 s; the window [8, 12) must
    # show the tone entering 2.0 s in, for an exact input seek (FLAC) and for
    # the output seek an MP3 gets.
    import shutil
    import subprocess
    if not shutil.which("ffmpeg"):
        print("      (skipped: no ffmpeg)")
        return
    d = tempfile.mkdtemp()
    src = {}
    lavfi = ("aevalsrc='if(between(t,10,25),0.5*sin(2*PI*440*t),0)':s=44100:d=30")
    for ext, codec in (("flac", ["-c:a", "flac"]), ("mp3", ["-c:a", "libmp3lame", "-q:a", "4"])):
        p = os.path.join(d, f"x.{ext}")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", lavfi, *codec, p],
                       check=True, stdin=subprocess.DEVNULL)
        src[ext] = p
    assert aw.input_seek_is_exact(src["flac"]) is True and aw.input_seek_is_exact(src["mp3"]) is False
    for ext, p in src.items():
        out = aw.extract_tail_window(p, 8.0, 4.0, input_seek=aw.input_seek_is_exact(p))
        try:
            onset, length = _onset_s(out)
        finally:
            os.remove(out)
        assert abs(length - 4.0) < 0.05, (ext, length)
        assert onset is not None and abs(onset - 2.0) < 0.03, (ext, onset)


def t_the_flat_analysis_places_the_tail_too():
    # The regular analysis pass (vocal/stem backfills, new tracks) uses the
    # flat request, not the facet protocol: it must place the window as well.
    calls, written, loads = [], [], []

    def fake_load(_librosa, path, **kw):
        loads.append((path, round(kw.get("offset", 0.0), 3), kw.get("duration")))
        return np.stack([tone(20.0), tone(20.0)]), kw["sr"]

    class Lib(FakeLibrosa):
        @staticmethod
        def get_duration(path=None):
            return 200.0

    with Patched(load_audio=fake_load, ensure_fast_decode=lambda p, complete=None: (p, None),
                 get_embedder=lambda force=False: None, get_vocal_detector=lambda force=False: Detector(calls),
                 measure_loudness=fixed_loudness, log=lambda *_a: None,
                 facet_head=lambda y, sr, librosa: {"bpm": 120.0, "key": "Am", "intro_ms": 0, "confidence": 1.0},
                 write_stems=lambda stems, window, d: written.append(window),
                 write_tail_meta=lambda d, off, dur: written.append(("meta", round(off, 3), round(dur, 3))),
                 stems_dir_to_write=lambda d, req=False: d):
        out = aw.analyze(Lib, path="/staged/x.flac", complete=True, vocal=True, stems_dir="/x",
                         tail_window={"end_ms": 180_000, "duration_ms": 200_000},
                         stream_url="http://nd/rest/stream?id=1")
    start = 180.0 - aw.OUTRO_SECONDS
    assert out.get("tail_window") == "edges", out
    assert out["tail_start_ms"] == 180_000 and out["tail_silence_ms"] == 20_000, out
    assert out["outro"]["ending"] == "cold", out
    shift = int(start * 1000)
    assert out["outro"]["vocalRanges"] == [{"startMs": shift + 1000, "endMs": shift + 3000}], out
    assert ("/staged/x.flac", start, aw.OUTRO_SECONDS) in loads, loads
    assert ("meta", start, 200.0) in written, written


def t_the_flat_analysis_without_a_placement_is_unchanged():
    class Lib(FakeLibrosa):
        @staticmethod
        def get_duration(path=None):
            return 200.0

    y = np.concatenate([tone(12.0), silence(8.0)])
    with Patched(load_audio=lambda _l, _p, **kw: (y, kw["sr"]), ensure_fast_decode=lambda p, complete=None: (p, None),
                 get_embedder=lambda force=False: None, get_vocal_detector=lambda force=False: None,
                 measure_loudness=fixed_loudness, log=lambda *_a: None,
                 facet_head=lambda y, sr, librosa: {"bpm": 120.0, "key": "Am", "intro_ms": 0, "confidence": 1.0}):
        out = aw.analyze(Lib, path="/staged/x.flac", complete=True)
    assert "tail_window" not in out, out
    assert abs(out["tail_start_ms"] - 192_000) <= 100, out


def t_the_request_hands_the_placement_and_the_stream_to_the_source():
    seen = {}

    class Src(aw.FileSource):
        def open(self, librosa):
            seen["stream_url"] = self.stream_url
            return self

    def fake_facets(_librosa, source, facets, **kw):
        seen["tail_window"] = kw.get("tail_window")
        return {}

    with Patched(FileSource=Src, analyze_facets=fake_facets):
        aw.analyze_facet_request(FakeLibrosa, {
            "facets": ["tail"], "path": "/staged/x.mp3", "complete": False,
            "stream_url": "http://nd/rest/stream?id=1",
            "tail_window": {"end_ms": 180_000, "duration_ms": 200_000},
        })
    assert seen == {"stream_url": "http://nd/rest/stream?id=1",
                    "tail_window": {"end_ms": 180_000, "duration_ms": 200_000}}, seen


test("the window ends where the music stops", t_place_tail_window_ends_where_the_music_stops)
test("a placement that cannot be honoured is ignored", t_parse_tail_window_refuses_what_cannot_be_placed)
test("an edges answer gives the placement", t_edges_answer_gives_the_placement)
test("a placed tail ends at the music: cold ending, silence from the edges, marked",
     t_a_placed_tail_ends_at_the_music_and_reads_a_cold_ending)
test("an unplaced tail is not marked as placed", t_an_unplaced_tail_is_not_marked)
test("Demucs tail vocals, stems and tail meta use the placed window",
     t_placed_tail_vocals_and_stems_use_the_placed_window)
test("a tail-only request's vocals use the placed window", t_tail_only_vocals_use_the_placed_window)
test("edges measured in the same request place the tail", t_edges_measured_in_the_same_request_place_the_tail)
test("input seek only for formats that seek exactly", t_input_seek_only_where_the_format_seeks_exactly)
test("the window decode puts the seek on the right side", t_window_ffmpeg_args_put_the_seek_on_the_right_side)
test("a complete local copy is read in place", t_file_source_reads_a_complete_copy_in_place)
test("a capped copy's window is decoded from the stream, and cleaned up",
     t_file_source_reads_a_capped_copys_window_from_the_stream)
test("a capped copy with no stream URL is still capped-download", t_file_source_without_a_stream_still_says_why)
test("a window that decodes short is tail-not-reached", t_a_window_that_decodes_short_is_not_reached)
test("a placed window that reads silent is unmeasurable", t_a_placed_window_that_reads_silent_is_unmeasurable)
test("real ffmpeg: the window lands on the sample (FLAC input seek, MP3 output seek)",
     t_real_ffmpeg_window_lands_on_the_sample)
test("the flat analysis places the tail too (vocals, stems, meta)", t_the_flat_analysis_places_the_tail_too)
test("the flat analysis without a placement is unchanged", t_the_flat_analysis_without_a_placement_is_unchanged)
test("the request hands the placement and the stream URL to the source",
     t_the_request_hands_the_placement_and_the_stream_to_the_source)

if failures:
    print(f"✗ analyzer_tail_placement_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_tail_placement_test.py passed")
