#!/usr/bin/env python3
"""Stem provenance on the analyzer side (#2238; controller music/stem-provenance.ts).

A track's stem dir is keyed by its id, which outlives a change of audio, and
its two windows are written at different times. Rewriting one window in place
must never leave another recording's other window (or its tail-meta.json)
beside it, and a write that dies part way must not leave a mixed window. Each
window carries a stamp (file size + decoded duration) written after its stems.
Pure stdlib: numpy and soundfile are stubbed, no models, no audio.
"""

import atexit
import json
import os
import shutil
import sys
import tempfile
import types
from unittest.mock import patch

numpy = types.ModuleType("numpy")
numpy.size = len
numpy.atleast_1d = lambda value: [value]
numpy.mean = lambda _data, **_kwargs: [0.0] * 12
sys.modules["numpy"] = numpy
soundfile = types.ModuleType("soundfile")


def _encode(path, data, *_args, **_kwargs):
    with open(path, "w") as output:
        output.write(data.tag)


soundfile.write = _encode
sys.modules["soundfile"] = soundfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0
STEMS = ("drums", "bass", "other", "vocals")


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 - a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err!r}")


root = tempfile.mkdtemp(prefix="subwave-stem-provenance-")
atexit.register(shutil.rmtree, root, ignore_errors=True)
_n = [0]


class Audio:
    def __init__(self, tag):
        self.tag = tag

    @property
    def T(self):
        return self

    def __len__(self):
        return 100


class Detector:
    """Separates a window into stems tagged with the recording's name."""

    def __init__(self, tag, tail_fails=False):
        self.tag, self.tail_fails = tag, tail_fails

    def separate(self, y):
        if y.tag == "tail" and self.tail_fails:
            raise RuntimeError("tail separation failed")
        return {name: Audio(f"{self.tag}:{y.tag}") for name in STEMS}

    def detect(self, *_args, **_kwargs):
        return []


def load(sr, mono, offset=0.0, duration=None):
    return Audio("tail" if offset else "head"), sr


def new_dir(seed=None):
    """A track dir, optionally holding an OLD recording's full set.
    seed: (head_meta | None, tail_meta | None)."""
    _n[0] += 1
    d = os.path.join(root, f"track-{_n[0]}")
    os.makedirs(d)
    if seed is not None:
        head_meta, tail_meta = seed
        for w in ("head", "tail"):
            for name in STEMS:
                with open(os.path.join(d, f"{w}-{name}.flac"), "w") as f:
                    f.write(f"OLD:{w}")
        if head_meta is not None:
            with open(os.path.join(d, aw.HEAD_META), "w") as f:
                json.dump(head_meta, f)
        if tail_meta is not None:
            with open(os.path.join(d, aw.TAIL_META), "w") as f:
                json.dump(tail_meta, f)
    return d


def window_tags(d, window):
    tags = set()
    for name in STEMS:
        p = os.path.join(d, f"{window}-{name}.flac")
        if os.path.exists(p):
            with open(p) as f:
                tags.add(f.read())
        else:
            tags.add(None)
    return tags


def meta(d, window):
    p = os.path.join(d, aw.WINDOW_META[window])
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


OLD_TAIL = {"tail_start_sec": 170.0, "duration_sec": 200.0, "file_size": 5_000_000}
NEW = {"file_size": 6_000_000, "duration_sec": 260.0}


def t_same_recording_rule():
    assert aw.same_recording({"file_size": 10}, {"file_size": 10})
    assert not aw.same_recording({"file_size": 10, "duration_sec": 200}, {"file_size": 11, "duration_sec": 200})
    # Sizes decide over durations when both are known.
    assert aw.same_recording({"file_size": 10, "duration_sec": 100}, {"file_size": 10, "duration_sec": 300})
    # One size unknown: durations, within the tolerance.
    assert aw.same_recording({"file_size": None, "duration_sec": 200}, {"file_size": 10, "duration_sec": 201.5})
    assert not aw.same_recording({"file_size": None, "duration_sec": 200}, {"file_size": 10, "duration_sec": 203})
    # Nothing known: a match (an old dir, a capped source).
    assert aw.same_recording({"file_size": None, "duration_sec": None}, {"file_size": 10, "duration_sec": 200})
    assert aw.same_recording({}, {})


def t_source_stamp():
    p = os.path.join(root, "audio.flac")
    with open(p, "wb") as f:
        f.write(b"x" * 1234)
    assert aw.source_stamp(p, True, 200.12345) == {"file_size": 1234, "duration_sec": 200.123}
    # A capped or unknown-completeness source says nothing.
    assert aw.source_stamp(p, False, 200.0) == {"file_size": None, "duration_sec": None}
    assert aw.source_stamp(p, None, 200.0) == {"file_size": None, "duration_sec": None}
    assert aw.source_stamp(os.path.join(root, "missing"), True, 0.0) == {"file_size": None, "duration_sec": None}


def t_head_rewrite_drops_another_recordings_tail():
    # The issue's case: a new recording's head over the old one's full set,
    # with its tail unproven this time (demucs_tail never runs).
    d = new_dir(seed=(None, OLD_TAIL))
    _vr, cached = aw.demucs_head(Detector("NEW"), load, None, d, stamp=NEW)
    assert cached is True
    assert window_tags(d, "head") == {"NEW:head"}, window_tags(d, "head")
    assert window_tags(d, "tail") == {None}, window_tags(d, "tail")
    assert meta(d, "tail") is None
    assert meta(d, "head") == NEW, meta(d, "head")


def t_head_rewrite_keeps_the_same_recordings_tail():
    d = new_dir(seed=(None, {**OLD_TAIL, "file_size": NEW["file_size"]}))
    aw.demucs_head(Detector("NEW"), load, None, d, stamp=NEW)
    assert window_tags(d, "tail") == {"OLD:tail"}
    assert meta(d, "tail")["file_size"] == NEW["file_size"]


def t_head_rewrite_judges_an_old_tail_meta_by_duration():
    # A tail-meta.json from before the stamps has no file_size.
    legacy = {"tail_start_sec": 170.0, "duration_sec": 200.0}
    d = new_dir(seed=(None, legacy))
    aw.demucs_head(Detector("NEW"), load, None, d, stamp=NEW)  # 260 s: another recording
    assert window_tags(d, "tail") == {None}
    d = new_dir(seed=(None, legacy))
    aw.demucs_head(Detector("NEW"), load, None, d, stamp={"file_size": 6_000_000, "duration_sec": 200.4})
    assert window_tags(d, "tail") == {"OLD:tail"}


def t_head_rewrite_with_an_unknown_stamp_clears_nothing():
    # A capped download stamps nothing: it cannot tell, so it keeps (upgrade-neutral).
    d = new_dir(seed=(None, OLD_TAIL))
    aw.demucs_head(Detector("NEW"), load, None, d, stamp=aw.source_stamp(None, False, 0))
    assert window_tags(d, "tail") == {"OLD:tail"}
    assert meta(d, "head") == {"file_size": None, "duration_sec": None}


def t_unreadable_other_meta_is_dropped():
    d = new_dir(seed=(None, None))
    with open(os.path.join(d, aw.TAIL_META), "w") as f:
        f.write("{not json")
    aw.demucs_head(Detector("NEW"), load, None, d, stamp=NEW)
    assert window_tags(d, "tail") == {None}


def t_failed_head_write_drops_the_head_window():
    d = new_dir(seed=({"file_size": NEW["file_size"], "duration_sec": 260.0},
                      {**OLD_TAIL, "file_size": NEW["file_size"]}))
    calls = []

    def flaky(path, data, *_a, **_kw):
        calls.append(path)
        if len(calls) == 3:
            raise OSError(28, "No space left on device")
        _encode(path, data)

    with patch.object(soundfile, "write", flaky):
        _vr, cached = aw.demucs_head(Detector("NEW"), load, None, d, stamp=NEW)
    assert cached is False
    # Two new files and two old ones would read as one head; none is left.
    assert window_tags(d, "head") == {None}, window_tags(d, "head")
    assert meta(d, "head") is None
    assert window_tags(d, "tail") == {"OLD:tail"}  # the same recording's tail stays


def t_tail_meta_failure_leaves_no_new_stems_beside_old_meta():
    # Case C: the old tail-meta.json goes before the new tail stems, and a
    # failed meta write drops the new stems; never new stems + old offset.
    d = new_dir(seed=(None, {**OLD_TAIL, "file_size": NEW["file_size"]}))
    errors, report = [], {}

    def no_meta(*_a, **_kw):
        raise OSError(28, "No space left on device")

    with patch.object(aw, "write_tail_meta", no_meta):
        ok = aw.demucs_tail(Detector("NEW"), load, None, 260.0, {"startMs": 230000}, d,
                            cache_errors=errors, file_size=NEW["file_size"], report=report)
    assert ok is True  # the tail vocals were still measured
    assert errors and report == {"tail_stems_landed": False}, (errors, report)
    assert window_tags(d, "tail") == {None}, window_tags(d, "tail")
    assert meta(d, "tail") is None


def t_tail_rewrite_stamps_and_reports():
    d = new_dir(seed=(None, OLD_TAIL))
    report = {}
    aw.demucs_tail(Detector("NEW"), load, None, 260.0, {"startMs": 230000}, d,
                   file_size=NEW["file_size"], report=report)
    assert report == {"tail_stems_landed": True}
    assert window_tags(d, "tail") == {"NEW:tail"}
    assert meta(d, "tail") == {"tail_start_sec": 240.0, "duration_sec": 260.0, "file_size": 6_000_000}, meta(d, "tail")


def t_tail_rewrite_drops_a_stale_head():
    # Pick-time stems separating the tail alone into a dir whose head is stamped
    # with another recording.
    d = new_dir(seed=({"file_size": 5_000_000, "duration_sec": 200.0}, None))
    aw.demucs_tail(Detector("NEW"), load, None, 260.0, {"startMs": 230000}, d, file_size=NEW["file_size"])
    assert window_tags(d, "head") == {None}
    assert meta(d, "head") is None
    assert window_tags(d, "tail") == {"NEW:tail"}


def t_tail_rewrite_keeps_an_unstamped_head():
    # A head from before the stamps: unknown, which matches (upgrade-neutral).
    d = new_dir(seed=(None, None))
    aw.demucs_tail(Detector("NEW"), load, None, 260.0, {"startMs": 230000}, d, file_size=NEW["file_size"])
    assert window_tags(d, "head") == {"OLD:head"}


def t_tail_separation_failure_reports_not_landed():
    d = new_dir(seed=(None, None))
    report = {}
    ok = aw.demucs_tail(Detector("NEW", tail_fails=True), load, None, 260.0, {"startMs": 230000}, d,
                        report=report)
    assert ok is False and report == {"tail_stems_landed": False}, report
    # No stems_dir: nothing asked, nothing reported.
    report = {}
    aw.demucs_tail(Detector("NEW"), load, None, 260.0, {"startMs": 230000}, None, report=report)
    assert report == {}, report


def _flat(outro, tail_fails=False):
    librosa = types.SimpleNamespace(
        get_duration=lambda **_kwargs: 260,
        to_mono=lambda audio: audio,
    )
    d = new_dir(seed=(None, OLD_TAIL))
    src = os.path.join(root, f"flat-{_n[0]}.flac")
    with open(src, "wb") as f:
        f.write(b"x" * NEW["file_size"])
    with patch.multiple(
        aw,
        ensure_fast_decode=lambda path, **_kwargs: (path, None),
        get_embedder=lambda **_kwargs: None,
        load_audio=lambda _l, _p, sr=None, mono=None, offset=0.0, duration=None: (
            Audio("tail" if offset else "head"), sr),
        analyze_outro=lambda *_args: outro,
        get_vocal_detector=lambda **_kwargs: Detector("NEW", tail_fails=tail_fails),
        facet_head=lambda *_a: {"bpm": 120.0, "key": "8A", "intro_ms": 0, "confidence": 1.0},
        measure_loudness=lambda *_args: (None, None),
        log=lambda *_a: None,
    ):
        result = aw.analyze(librosa, path=src, complete=True, vocal=True, stems_dir=d)
    return result, d


def t_flat_reports_tail_stems():
    result, d = _flat({"startMs": 230000})
    assert result["stems_cached"] is True and result["tail_stems_landed"] is True, result
    assert list(result)[-2:] == ["stems_cached", "tail_stems_landed"], list(result)
    assert meta(d, "head") == {"file_size": NEW["file_size"], "duration_sec": 260.0}, meta(d, "head")
    assert meta(d, "tail")["file_size"] == NEW["file_size"]

    result, d = _flat({"startMs": 230000}, tail_fails=True)
    assert result["stems_cached"] is True and result["tail_stems_landed"] is False, result
    # The old recording's tail went with the head rewrite.
    assert window_tags(d, "tail") == {None}

    # An unproven tail: no tail to cut, so no tail_stems at all.
    result, d = _flat(None)
    assert result["stems_cached"] is True and "tail_stems_landed" not in result, result
    assert window_tags(d, "tail") == {None}  # another recording's: dropped


print("analyzer stem provenance")
test("same_recording: sizes, then durations, then unknown matches", t_same_recording_rule)
test("source_stamp: only a whole file states size and duration", t_source_stamp)
test("head rewrite drops another recording's tail (#2238)", t_head_rewrite_drops_another_recordings_tail)
test("head rewrite keeps the same recording's tail", t_head_rewrite_keeps_the_same_recordings_tail)
test("an unstamped tail-meta is judged by duration", t_head_rewrite_judges_an_old_tail_meta_by_duration)
test("an unknown stamp clears nothing", t_head_rewrite_with_an_unknown_stamp_clears_nothing)
test("an unreadable other meta is dropped", t_unreadable_other_meta_is_dropped)
test("a head write failing part way drops the head window", t_failed_head_write_drops_the_head_window)
test("tail meta failure: no new stems beside the old offset", t_tail_meta_failure_leaves_no_new_stems_beside_old_meta)
test("tail rewrite stamps file_size and reports landed", t_tail_rewrite_stamps_and_reports)
test("tail rewrite drops a stale stamped head", t_tail_rewrite_drops_a_stale_head)
test("tail rewrite keeps an unstamped head", t_tail_rewrite_keeps_an_unstamped_head)
test("tail separation failure reports not landed", t_tail_separation_failure_reports_not_landed)
test("flat analyze reports tail_stems_landed only for a proven tail", t_flat_reports_tail_stems)

if failures:
    print(f"\n{failures} analyzer stem provenance test(s) failed")
    sys.exit(1)
print("\nall analyzer stem provenance tests passed")
