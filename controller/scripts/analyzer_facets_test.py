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


test("facet_tail is pure and equals analyze_outro", t_facet_tail_is_pure_and_matches_analyze_outro)
test("decode_tail refuses a short track of unknown completeness before decoding",
     t_decode_tail_refuses_unknown_short_track_without_decoding)
test("decode_tail length check counts samples, not channels", t_decode_tail_measures_samples_not_channels)
test("facet_loudness omits unmeasured fields", t_facet_loudness_omits_unmeasured_fields)
test("facet_clap embeds the windows it is given, no decode", t_facet_clap_embeds_given_windows_without_decoding)
test("iter_clap_windows skips failed and truncated windows", t_iter_clap_windows_skips_failed_and_truncated_windows)
test("embed_windows is iter_clap_windows + facet_clap", t_embed_windows_is_decode_then_facet)

if failures:
    print(f"✗ analyzer_facets_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_facets_test.py passed")
