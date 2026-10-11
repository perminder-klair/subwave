#!/usr/bin/env python3
# Contract tests for the analyzer's facet functions — the pure, array-in
# pieces analyze() is built from (facet_head, facet_loudness, facet_tail,
# facet_clap) and the decoders that feed them (decode_tail, iter_clap_windows).
# Run: `python3 scripts/analyzer_facets_test.py` (exit 0 = pass), and via
# scripts/analyzer-python.test.ts as part of `npm test`.
#
# numpy is the one dependency; librosa is replaced by a tiny numpy fake, so no
# audio files, no torch, no network. What analyze() returns for real audio is
# pinned separately by analyzer_characterisation_test.py (analyzer runtime).
#
# Why this is pinned:
#
#   * A facet function never reads a file. Later work feeds the same functions
#     from other sources (a ranged HTTP read of just the tail, exact CLAP
#     windows), which only works if the measurement is separate from the
#     decode. Each test below makes load_audio raise while a facet runs.
#   * The path wrappers (analyze_outro, embed_windows) stay exactly
#     decode + facet, so the tail and CLAP results can't drift between the
#     old entry points and the new ones.
#   * decode_tail keeps the completeness gates: a short track of unknown
#     completeness is refused BEFORE decoding, and a tail that decodes short is
#     refused — for stereo (c, n) buffers too, where len() is the channel count.

import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

try:
    import numpy as np
except ImportError:
    print("FAIL: numpy is required for this suite (pip install numpy)")
    sys.exit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

SR = aw.ANALYZE_SR
failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 — a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


def tone(sec, amp=0.5, sr=SR):
    t = np.arange(int(sr * sec), dtype=np.float32) / sr
    return (amp * np.sin(2 * np.pi * 440.0 * t)).astype(np.float32)


def silence(sec, sr=SR):
    return np.zeros(int(sr * sec), dtype=np.float32)


class FakeLibrosa:
    """The handful of librosa calls facet_tail makes, in numpy."""

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
            raise RuntimeError("no beat tracker in the fake")  # grid is garnish


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


def no_decode(*_a, **_k):
    raise AssertionError("a facet function decoded audio")


def fixed_loudness(*_a, **_k):
    return (-11.0, -1.5)


# ── tail ────────────────────────────────────────────────────────────────────

def t_facet_tail_is_pure_and_matches_analyze_outro():
    # 200 s track: the last 20 s are 12 s of tone then 8 s of dead air.
    y = np.concatenate([tone(12.0), silence(8.0)])
    quiet = {"log": lambda *_a: None}
    with Patched(load_audio=lambda *_a, **_k: (y, SR), measure_loudness=fixed_loudness, **quiet):
        via_path = aw.analyze_outro("x.flac", FakeLibrosa, 200.0, True)
    with Patched(load_audio=no_decode, measure_loudness=fixed_loudness, **quiet):
        direct = aw.facet_tail(y, SR, 180.0, 200.0, FakeLibrosa)
    assert via_path == direct, f"{via_path} != {direct}"
    # Lands near-silent after a wind-down of 3 s or more: "fade" for transitions.
    assert direct["ending"] == "fade", direct
    assert abs(direct["startMs"] - 192000) <= 100, direct
    assert abs(direct["tail_silence_ms"] - 8000) <= 100, direct
    # Absolute: the gap opens 12 s into a window that starts at 180 s.
    assert abs(direct["tail_start_ms"] - 192000) <= 100, direct
    assert direct["lufs"] == -11.0, direct


def t_decode_tail_refuses_unknown_short_track_without_decoding():
    with Patched(load_audio=no_decode):
        assert aw.decode_tail("x.flac", FakeLibrosa, 10.0, None) is None
        assert aw.decode_tail("x.flac", FakeLibrosa, 10.0, False) is None
        assert aw.decode_tail("x.flac", FakeLibrosa, 0.0, True) is None


def t_decode_tail_measures_samples_not_channels():
    stereo_full = np.stack([tone(20.0), tone(20.0)])
    stereo_short = np.stack([tone(5.0), tone(5.0)])
    with Patched(load_audio=lambda *_a, **_k: (stereo_full, SR)):
        got = aw.decode_tail("x.flac", FakeLibrosa, 200.0, None)
    assert got is not None and got[2] == 180.0, got
    with Patched(load_audio=lambda *_a, **_k: (stereo_short, SR)):
        assert aw.decode_tail("x.flac", FakeLibrosa, 200.0, None) is None, "short stereo tail accepted"


# ── loudness ───────────────────────────────────────────────────────────────

def t_facet_loudness_omits_unmeasured_fields():
    with Patched(measure_loudness=lambda *_a, **_k: (None, None)):
        assert aw.facet_loudness(tone(1.0), SR) == {}
    with Patched(measure_loudness=lambda *_a, **_k: (-9.0, None)):
        assert aw.facet_loudness(tone(1.0), SR) == {"loudness_lufs": -9.0}
    with Patched(measure_loudness=fixed_loudness):
        assert aw.facet_loudness(tone(1.0), SR) == {"loudness_lufs": -11.0, "peak_db": -1.5}


# ── clap ───────────────────────────────────────────────────────────────────

class OneAtATime:
    def __init__(self):
        self.seen = []

    def batches_windows(self):
        return False

    def embed(self, window, _sr):
        self.seen.append(len(window))
        return [float(len(window)), 0.0]


class Batched(OneAtATime):
    def batches_windows(self):
        return True

    def embed_many(self, windows, sr):
        return [self.embed(w, sr) for w in windows]


def t_facet_clap_embeds_given_windows_without_decoding():
    windows = [np.ones(10), np.ones(30)]
    for emb in (OneAtATime(), Batched()):
        with Patched(load_audio=no_decode):
            vec = aw.facet_clap(emb, windows)
        assert emb.seen == [10, 30], emb.seen
        assert abs(vec[0] - 1.0) < 1e-9 and vec[1] == 0.0, vec  # mean, renormalised
    assert aw.facet_clap(OneAtATime(), []) is None


def t_iter_clap_windows_skips_failed_and_truncated_windows():
    # 200 s → offsets 0, 80, 128. Middle window fails, late one is truncated.
    def load(_lib, _path, sr, mono, offset, duration):
        if offset == 0.0:
            return np.ones(sr * 40), sr
        if offset == 80.0:
            raise RuntimeError("bad window")
        return np.ones(sr * 2), sr  # under 5 s: a capped download's "tail"
    with Patched(load_audio=load, log=lambda *_a: None):
        got = list(aw.iter_clap_windows("x.flac", None, 200.0))
    assert [o for o, _y in got] == [0.0], got


def t_embed_windows_is_decode_then_facet():
    def load(_lib, _path, sr, mono, offset, duration):
        return np.full(sr * 40, offset + 1.0), sr
    with Patched(load_audio=load):
        via_path = aw.embed_windows(Batched(), "x.flac", None, 200.0)
        windows = [y for _o, y in aw.iter_clap_windows("x.flac", None, 200.0)]
    with Patched(load_audio=no_decode):
        direct = aw.facet_clap(Batched(), windows)
    assert via_path == direct, f"{via_path} != {direct}"



# ── facet protocol ────────────────────────────────────────────────────────

class FakeSource:
    """Stands in for FileSource: records what was decoded."""

    def __init__(self, tail=None, duration_s=200.0):
        self.loads = []
        self._tail = tail
        self.duration_s = duration_s

    def load(self, librosa, sr, mono, offset=0.0, duration=None):
        self.loads.append((sr, offset, duration))
        return tone(duration or 20.0, sr=SR), sr

    def tail(self, librosa):
        return self._tail

    def clap_windows(self, librosa):
        self.loads.append(("clap",))
        return iter([np.ones(10)])


def t_parse_facets_rejects_unknown_and_dedupes():
    assert aw.parse_facets(["tail", "head", "tail"]) == ["tail", "head"]
    for bad in ([], "tail", ["bogus"]):
        try:
            aw.parse_facets(bad)
        except aw.FacetRequestError:
            continue
        raise AssertionError(f"accepted {bad!r}")


def t_clap_only_decodes_nothing_but_clap_windows():
    src = FakeSource()
    with Patched(get_embedder=lambda force=False: Batched(), get_vocal_detector=no_decode):
        out = aw.analyze_facets(FakeLibrosa, src, ["clap"])
    assert src.loads == [("clap",)], src.loads
    assert out["clap"]["status"] == "ok" and len(out["clap"]["data"]["audio_embedding"]) == 2, out


def t_missing_models_answer_unavailable_with_the_reason():
    src = FakeSource(tail="capped-download")
    with Patched(get_embedder=lambda force=False: None, get_vocal_detector=lambda force=False: None,
                 _embed_error="CLAP load failed: offline", _vocal_error=None):
        out = aw.analyze_facets(FakeLibrosa, src, ["clap", "vocal", "stems"])
    assert out["clap"] == {"status": "unavailable", "reason": "CLAP load failed: offline"}, out
    assert out["vocal"]["status"] == "unavailable" and "WITH_DEMUCS" in out["vocal"]["reason"], out
    assert out["stems"]["status"] == "unavailable", out


def t_head_only_never_loads_a_model():
    src = FakeSource()
    with Patched(get_embedder=no_decode, get_vocal_detector=no_decode, measure_loudness=fixed_loudness,
                 facet_head=lambda y, sr, librosa: {"bpm": 120.0, "key": "Am", "intro_ms": 0, "confidence": 1.0}):
        out = aw.analyze_facets(FakeLibrosa, src, ["head", "loudness"])
    assert [l[0] for l in src.loads] == [aw.ANALYZE_SR], src.loads  # one shared head decode
    assert out["head"]["data"]["bpm"] == 120.0
    assert out["loudness"] == {"status": "ok", "data": {"loudness_lufs": -11.0, "peak_db": -1.5}}, out


def t_tail_reports_why_it_is_unmeasurable():
    for reason in ("capped-download", "unknown-completeness", "tail-not-reached"):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(tail=reason), ["tail"])
        assert out["tail"] == {"status": "unmeasurable", "reason": reason}, out
    silent = (np.zeros(SR * 20, dtype=np.float32), SR, 180.0)
    with Patched(log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(tail=silent), ["tail"])
    assert out["tail"] == {"status": "unmeasurable", "reason": "silent-tail-window"}, out


def t_tail_ok_lifts_silence_fields_like_the_flat_response():
    y = np.concatenate([tone(12.0), silence(8.0)])
    with Patched(measure_loudness=fixed_loudness, log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(tail=(y, SR, 180.0)), ["tail"])
    data = out["tail"]["data"]
    assert abs(data["tail_start_ms"] - 192000) <= 100, data
    assert "tail_silence_ms" not in data["outro"] and data["outro"]["ending"] == "fade", data


def t_file_source_tail_gates():
    src = aw.FileSource("x.flac", complete=False)
    assert src.tail(FakeLibrosa) == "capped-download"
    src = aw.FileSource("x.flac", complete=None)
    src.decoded_tmp = "/tmp/x.wav"
    assert src.tail(FakeLibrosa) == "unknown-completeness"


def t_vocal_and_stems_share_one_separation_and_shift_tail_ranges():
    calls = []

    class Detector:
        def separate(self, y):
            calls.append("separate")
            return {"vocals": y}

        def detect(self, y, sr, librosa, min_loud=None, stems=None):
            return [{"startMs": 1000, "endMs": 3000}]

    written = []
    y = np.concatenate([tone(12.0), silence(8.0)])
    with Patched(get_vocal_detector=lambda force=False: Detector(), measure_loudness=fixed_loudness,
                 write_stems=lambda stems, window, d: written.append(window),
                 write_tail_meta=lambda d, off, dur: written.append("meta"), log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(tail=(y, SR, 180.0)), ["vocal", "stems"], stems_dir="/x")
    assert calls == ["separate", "separate"], calls  # head + tail, shared by both facets
    assert written == ["head", "tail", "meta"], written
    assert out["vocal"]["data"]["vocal_ranges"] == [{"startMs": 1000, "endMs": 3000}], out
    # Tail ranges are ABSOLUTE: shifted by the tail window's offset (200 - 20 s).
    assert out["vocal"]["data"]["tail_vocal_ranges"] == [{"startMs": 181000, "endMs": 183000}], out
    assert out["stems"] == {"status": "ok", "data": {"stems_cached": True, "tail_stems": True}}, out


def t_a_facet_failure_stays_in_its_facet():
    def boom(*_a, **_k):
        raise RuntimeError("loudness meter exploded")
    with Patched(measure_loudness=boom,
                 facet_head=lambda y, sr, librosa: {"bpm": 1.0, "key": None, "intro_ms": None, "confidence": 0.0}):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(), ["head", "loudness"])
    assert out["head"]["status"] == "ok", out
    assert out["loudness"] == {"status": "failed", "reason": "loudness meter exploded"}, out


def t_head_decode_failure_keeps_independent_facets():
    class Source(FakeSource):
        def load(self, *args, **kwargs):
            if empty:
                return np.zeros((2, 0), dtype=np.float32), SR
            raise OSError("head decoder failed")

    y = np.concatenate([tone(12.0), silence(8.0)])
    for empty in (False, True):
        for requested in (["head"], ["loudness"], ["head", "loudness"]):
            src = Source(tail=(y, SR, 180.0))
            with Patched(get_embedder=lambda force=False: Batched(),
                         facet_head=no_decode, facet_loudness=no_decode,
                         measure_loudness=fixed_loudness, log=lambda *_a: None):
                out = aw.analyze_facets(FakeLibrosa, src, [*requested, "tail", "clap"])
            assert set(out) == set(requested) | {"tail", "clap"}, out
            for name in requested:
                assert out[name] == {"status": "failed", "reason": "decoded empty audio" if empty else "head decoder failed"}, out
            assert out["tail"]["status"] == out["clap"]["status"] == "ok", out


def t_tail_dependency_failure_returns_only_requested_facets():
    class Source(FakeSource):
        def tail(self, librosa):
            raise OSError("tail decoder failed")

    class Detector:
        def separate(self, y):
            return {"vocals": y}

        def detect(self, *_args, **_kwargs):
            return []

    for requested in (["vocal"], ["stems"], ["vocal", "stems"], ["vocal", "tail"]):
        with Patched(get_vocal_detector=lambda force=False: Detector(), log=lambda *_a: None):
            out = aw.analyze_facets(FakeLibrosa, Source(), requested)
        assert set(out) == set(requested), out
        if "vocal" in requested:
            assert out["vocal"] == {"status": "ok", "data": {"vocal_ranges": []}}, out
        if "tail" in requested:
            assert out["tail"] == {"status": "failed", "reason": "tail decoder failed"}, out


def _cache_publication(stage, flat=False):
    # Replace only the codec; write_stems/write_tail_meta still publish through
    # real files and os.replace. A directory at the final name makes rename
    # fail deterministically, even for root, without relying on chmod.
    soundfile = types.ModuleType("soundfile")
    soundfile.write = lambda path, *_a, **_kw: Path(path).write_bytes(b"encoded stem")

    class Detector:
        def separate(self, y):
            return {name: y for name in ("drums", "bass", "other", "vocals")}

        def detect(self, *_args, **_kwargs):
            return [{"startMs": 1000, "endMs": 3000}]

    class Source(FakeSource):
        def load(self, librosa, sr, mono, offset=0.0, duration=None):
            return np.ones((2, 1024), dtype=np.float32), sr

    class Librosa(FakeLibrosa):
        @staticmethod
        def get_duration(path):
            return 200.0

    with tempfile.TemporaryDirectory(prefix="subwave-facet-publication-") as root:
        dest = Path(root) / "track-1"
        dest.mkdir()
        (Path(root) / aw.STEMS_MARKER).write_text("{}\n")
        if stage is not None:
            name = "tail-meta.json" if stage == "tail-meta" else f"{stage}-drums.flac"
            (dest / name).mkdir()
        src = Source(tail="capped-download")
        with patch.dict(sys.modules, {"soundfile": soundfile}), Patched(
            get_vocal_detector=lambda force=False: Detector(), get_embedder=lambda force=False: None,
            facet_tail=lambda *_a: {"startMs": 190000, "ending": "cold"},
            ensure_fast_decode=lambda path, **_kw: (path, None),
            load_audio=lambda librosa, path, **kw: src.load(librosa, **kw),
            analyze_outro=lambda *_a: {"startMs": 190000, "ending": "cold"},
            facet_head=lambda *_a: {"bpm": 120.0, "key": "Am", "intro_ms": 0, "confidence": 1.0},
            measure_loudness=fixed_loudness, log=lambda *_a: None,
        ):
            if flat:
                out = aw.analyze(Librosa, path="unused.flac", complete=True, vocal=True,
                                 stems_dir=str(dest), stems_require_marker=True)
            else:
                src._tail = (np.ones(10), SR, 180.0)
                out = aw.analyze_facets(Librosa, src, ["vocal", "stems"],
                                        stems_dir=str(dest), stems_require_marker=True)
        return out, sorted(p.name for p in dest.iterdir() if p.is_file())


def t_stem_publication_error_preserves_vocals(stage):
    out, files = _cache_publication(stage)
    assert out["stems"]["status"] == "failed", out
    assert out["stems"]["reason"], out
    assert set(out) == {"vocal", "stems"}, out
    assert out["vocal"] == {"status": "ok", "data": {
        "vocal_ranges": [{"startMs": 1000, "endMs": 3000}],
        "tail_vocal_ranges": [{"startMs": 181000, "endMs": 183000}],
    }}, out
    if stage == "tail-meta":
        assert "tail-meta.json" not in files, files
        assert all(f"tail-{name}.flac" in files for name in ("drums", "bass", "other", "vocals")), files


def t_stem_publication_success():
    out, files = _cache_publication(None)
    assert out["stems"] == {"status": "ok", "data": {"stems_cached": True, "tail_stems": True}}, out
    assert all(f"{window}-{name}.flac" in files for window in ("head", "tail")
               for name in ("drums", "bass", "other", "vocals")), files
    assert "tail-meta.json" in files, files


def t_flat_publication_errors_keep_best_effort_outcomes():
    for stage in ("head", "tail", "tail-meta"):
        out, _files = _cache_publication(stage, flat=True)
        assert out["stems_cached"] is (stage != "head"), out
        assert out["vocal_ranges"] == [{"startMs": 1000, "endMs": 3000}], out
        assert out["outro"]["vocalRanges"] == [{"startMs": 181000, "endMs": 183000}], out


def _stems_marker_run(mark, lose_after=None):
    """vocal + stems with stems_require_marker against a real temp root.
    lose_after: separation call count after which the marker disappears
    (the share is unmounted mid-pass)."""
    import tempfile
    root = tempfile.mkdtemp(prefix="subwave-facet-stems-")
    marker = os.path.join(root, aw.STEMS_MARKER)
    if mark:
        with open(marker, "w") as f:
            f.write("{}\n")
    calls = []

    class Detector:
        def separate(self, y):
            calls.append("separate")
            if lose_after is not None and len(calls) == lose_after and os.path.exists(marker):
                os.remove(marker)
            return {"vocals": y}

        def detect(self, y, sr, librosa, min_loud=None, stems=None):
            return [{"startMs": 1000, "endMs": 3000}]

    written = []
    y = np.concatenate([tone(12.0), silence(8.0)])
    with Patched(get_vocal_detector=lambda force=False: Detector(), measure_loudness=fixed_loudness,
                 write_stems=lambda stems, window, d: written.append(window),
                 write_tail_meta=lambda d, off, dur: written.append("meta"), log=lambda *_a: None):
        out = aw.analyze_facets(FakeLibrosa, FakeSource(tail=(y, SR, 180.0)), ["vocal", "stems"],
                                stems_dir=os.path.join(root, "track-1"), stems_require_marker=True)
    return out, written, calls


def t_stems_facet_marked_root_writes():
    out, written, _calls = _stems_marker_run(mark=True)
    assert written == ["head", "tail", "meta"], written
    assert out["stems"] == {"status": "ok", "data": {"stems_cached": True, "tail_stems": True}}, out


def t_stems_facet_unmarked_root_is_unavailable_and_writes_nothing():
    out, written, calls = _stems_marker_run(mark=False)
    assert written == [], written
    assert out["stems"]["status"] == "unavailable" and aw.STEMS_MARKER in out["stems"]["reason"], out
    # Vocal activity does not need the share: it still answers.
    assert calls == ["separate", "separate"], calls
    assert out["vocal"]["status"] == "ok", out


def t_stems_facet_mount_lost_mid_pass_is_unavailable():
    # Marker gone after the head separation: the head stems are already on
    # the share, nothing more is written, and stems is not reported ok.
    out, written, _calls = _stems_marker_run(mark=True, lose_after=1)
    assert written == [], written
    assert out["stems"]["status"] == "unavailable", out
    out, written, _calls = _stems_marker_run(mark=True, lose_after=2)
    assert written == ["head"], written
    assert out["stems"]["status"] == "unavailable", out
    assert out["vocal"]["status"] == "ok", out


test("facet_tail is pure and equals analyze_outro", t_facet_tail_is_pure_and_matches_analyze_outro)
test("decode_tail refuses a short track of unknown completeness before decoding",
     t_decode_tail_refuses_unknown_short_track_without_decoding)
test("decode_tail length check counts samples, not channels", t_decode_tail_measures_samples_not_channels)
test("facet_loudness omits unmeasured fields", t_facet_loudness_omits_unmeasured_fields)
test("facet_clap embeds the windows it is given, no decode", t_facet_clap_embeds_given_windows_without_decoding)
test("iter_clap_windows skips failed and truncated windows", t_iter_clap_windows_skips_failed_and_truncated_windows)
test("embed_windows is iter_clap_windows + facet_clap", t_embed_windows_is_decode_then_facet)
test("parse_facets rejects unknown names and dedupes", t_parse_facets_rejects_unknown_and_dedupes)
test("a clap-only request decodes only the CLAP windows", t_clap_only_decodes_nothing_but_clap_windows)
test("missing models answer 'unavailable' with the reason", t_missing_models_answer_unavailable_with_the_reason)
test("head + loudness share one decode and load no model", t_head_only_never_loads_a_model)
test("an unmeasurable tail says why", t_tail_reports_why_it_is_unmeasurable)
test("a measured tail lifts the silence fields like the flat response", t_tail_ok_lifts_silence_fields_like_the_flat_response)
test("FileSource refuses to prove the end of a capped or unprovable file", t_file_source_tail_gates)
test("a failure in one facet does not fail the others", t_a_facet_failure_stays_in_its_facet)
test("a head decode failure keeps independent tail/CLAP facets", t_head_decode_failure_keeps_independent_facets)
test("a tail dependency failure returns only requested facets", t_tail_dependency_failure_returns_only_requested_facets)
for stage in ("head", "tail", "tail-meta"):
    test(f"{stage} publication errors fail stems and preserve vocals",
         lambda stage=stage: t_stem_publication_error_preserves_vocals(stage))
test("successful stem publication keeps the cache outcome", t_stem_publication_success)
test("flat stem publication errors keep best-effort outcomes", t_flat_publication_errors_keep_best_effort_outcomes)
test("vocal + stems share one separation; tail ranges are absolute", t_vocal_and_stems_share_one_separation_and_shift_tail_ranges)
test("stems facet, marked root: stems written", t_stems_facet_marked_root_writes)
test("stems facet, unmarked root: unavailable, nothing written, vocal still ok",
     t_stems_facet_unmarked_root_is_unavailable_and_writes_nothing)
test("stems facet, share lost mid-pass: unavailable, no further writes", t_stems_facet_mount_lost_mid_pass_is_unavailable)

if failures:
    print(f"✗ analyzer_facets_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_facets_test.py passed")
