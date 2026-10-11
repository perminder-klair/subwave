#!/usr/bin/env python3
"""Stems share marker on the analyzer side (controller music/stem-cache.ts).

An analyzer on another machine mounts the stems share itself. If that mount is
missing, the mount point is still there and stems written into it fill the
local disk while the controller sees nothing. With stems_require_marker the
worker writes only when the cache root carries the .subwave-stems marker, and
the sidecar forwards the flag (pinned in analyzer_sidecar_contract_test.py).
Pure stdlib: no numpy, librosa or models.
"""

import os
import sys
import tempfile
import types
from unittest.mock import patch

sys.modules.setdefault("numpy", types.ModuleType("numpy"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

failures = 0


def test(name, fn):
    global failures
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as err:  # noqa: BLE001 - a failed assert is a reported case
        failures += 1
        print(f"  ✗ {name}\n      {err}")


root = tempfile.mkdtemp(prefix="subwave-stems-marker-")
track_dir = os.path.join(root, "track-1")


def no_marker():
    path = os.path.join(root, aw.STEMS_MARKER)
    if os.path.exists(path):
        os.remove(path)


def with_marker():
    with open(os.path.join(root, aw.STEMS_MARKER), "w") as f:
        f.write("{}\n")


def t_marked():
    with_marker()
    assert aw.stems_root_marked(track_dir)
    assert aw.stems_root_marked(track_dir + "/")  # trailing slash
    assert aw.stems_dir_to_write(track_dir, True) == track_dir


def t_unmarked_refused():
    no_marker()
    assert not aw.stems_root_marked(track_dir)
    assert aw.stems_dir_to_write(track_dir, True) is None


def t_old_controller_unchanged():
    # An older controller never sends the flag and never creates a marker:
    # its writes must keep working.
    no_marker()
    assert aw.stems_dir_to_write(track_dir, False) == track_dir
    assert aw.stems_dir_to_write(track_dir, None) == track_dir


def t_no_stems_requested():
    assert aw.stems_dir_to_write(None, True) is None


def analyze_with_mount_loss(stage):
    numpy = types.ModuleType("numpy")
    numpy.size = len
    numpy.atleast_1d = lambda value: [value]
    numpy.mean = lambda _data, **_kwargs: [0.0] * 12
    soundfile = types.ModuleType("soundfile")

    def encode(path, *_args, **_kwargs):
        with open(path, "wb") as output:
            output.write(b"encoded stem")

    soundfile.write = encode

    class Audio:
        @property
        def T(self):
            return self

        def __len__(self):
            return 100

    librosa = types.SimpleNamespace(
        get_duration=lambda **_kwargs: 200,
        to_mono=lambda audio: audio,
        beat=types.SimpleNamespace(beat_track=lambda **_kwargs: (120, [])),
        frames_to_time=lambda *_args, **_kwargs: [],
        feature=types.SimpleNamespace(chroma_cqt=lambda **_kwargs: []),
    )
    with tempfile.TemporaryDirectory(prefix="subwave-stems-unmount-") as temporary:
        mounted = os.path.join(temporary, "stems")
        detached = os.path.join(temporary, "detached")
        destination = os.path.join(mounted, "track-1")
        os.mkdir(mounted)
        with open(os.path.join(mounted, aw.STEMS_MARKER), "w") as marker:
            marker.write("{}\n")

        def unmount():
            os.rename(mounted, detached)
            os.mkdir(mounted)

        class Detector:
            calls = 0

            def separate(self, _audio):
                self.calls += 1
                if (stage == "head" and self.calls == 1) or (stage == "tail" and self.calls == 2):
                    unmount()
                return {name: Audio() for name in ("drums", "bass", "other", "vocals")}

            def detect(self, *_args, **_kwargs):
                return []

        detector = Detector()
        original_write_stems = aw.write_stems

        def write_stems(stems, window, directory):
            original_write_stems(stems, window, directory)
            if stage == "tail-meta" and window == "tail":
                unmount()

        with patch.dict(sys.modules, {"numpy": numpy, "soundfile": soundfile}), patch.multiple(
            aw,
            ensure_fast_decode=lambda path, **_kwargs: (path, None),
            get_embedder=lambda **_kwargs: None,
            load_audio=lambda *_args, **_kwargs: (Audio(), aw.DEMUCS_SR),
            analyze_outro=lambda *_args: {"startMs": 180000},
            get_vocal_detector=lambda **_kwargs: detector,
            estimate_key=lambda *_args: ("8A", 1),
            estimate_key_ranges=lambda *_args: [],
            estimate_intro_ms=lambda *_args: 0,
            silence_edges_ms=lambda *_args: (None, None, None),
            estimate_sections=lambda *_args, **_kwargs: [],
            estimate_pace=lambda *_args: [],
            measure_loudness=lambda *_args: (None, None),
            write_stems=write_stems,
        ):
            result = aw.analyze(
                librosa, path=os.path.join(temporary, "audio"), complete=True,
                vocal=True, stems_dir=destination, stems_require_marker=True,
            )
        assert "stems_cached" not in result, f"{stage} refusal must not stamp an attempt: {result}"
        assert os.listdir(mounted) == [], f"{stage} refusal wrote into the bare mountpoint"
        if stage != "head":
            assert os.path.isfile(os.path.join(detached, "track-1", "head-drums.flac"))


print("analyzer stems marker")
test("marked root: stems written", t_marked)
test("unmarked root with require_marker: no stems written", t_unmarked_refused)
test("no flag (older controller): unchanged", t_old_controller_unchanged)
test("no stems_dir: nothing to write", t_no_stems_requested)
test("mount lost during head separation: no writes or attempt stamp", lambda: analyze_with_mount_loss("head"))
test("mount lost during tail separation: no writes or attempt stamp", lambda: analyze_with_mount_loss("tail"))
test("mount lost before tail metadata: no attempt stamp", lambda: analyze_with_mount_loss("tail-meta"))

if failures:
    print(f"\n{failures} analyzer stems marker test(s) failed")
    sys.exit(1)
print("\nall analyzer stems marker tests passed")
