#!/usr/bin/env python3
"""Pure-stdlib regression tests for CLAP batching and embedding-only passes.

The production worker imports numpy lazily.  This suite supplies the tiny
vector surface these tests exercise so it stays runnable from a contributor's
plain system Python, matching the other analyzer Python suites.
"""

import io
import math
import os
import sys
import tempfile
import types


class Vector(list):
    @property
    def shape(self):
        return (len(self),)

    def __truediv__(self, value):
        return Vector(x / value for x in self)


fake_numpy = types.ModuleType("numpy")
fake_numpy.float64 = float


def fake_asarray(value, dtype=None):
    return value if hasattr(value, "ndim") else Vector(value)


fake_numpy.asarray = fake_asarray
fake_numpy.mean = lambda rows, axis=0: Vector(
    sum(row[i] for row in rows) / len(rows) for i in range(len(rows[0]))
)
fake_numpy.linalg = types.SimpleNamespace(
    norm=lambda row: math.sqrt(sum(x * x for x in row))
)
sys.modules.setdefault("numpy", fake_numpy)

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


class FakeLibrosa:
    def __init__(self):
        self.offsets = []

    def load(self, _path, **kwargs):
        self.offsets.append(kwargs.get("offset", 0.0))
        class AudioWindow:
            def __init__(self, marker):
                self.marker = marker

            def __len__(self):
                return kwargs["sr"] * 40

        return AudioWindow(kwargs.get("offset", 0.0) + 1.0), kwargs["sr"]

    def get_duration(self, **_kwargs):
        return 200.0


def test_clap_windows_share_one_model_forward():
    librosa = FakeLibrosa()

    class Embedder:
        def __init__(self):
            self.calls = []

        def batches_windows(self):
            return True

        def embed_many(self, windows, sr):
            self.calls.append((windows, sr))
            return [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]]

    embedder = Embedder()
    vector = aw.embed_windows(embedder, "/music/track.flac", librosa, 200.0)

    assert len(embedder.calls) == 1, "three CLAP windows must use one batched model forward"
    windows, sr = embedder.calls[0]
    assert len(windows) == 3, windows
    assert sr == aw.CLAP_SR, sr
    assert librosa.offsets == [0.0, 80.0, 128.0], librosa.offsets
    assert len(vector) == 2
    assert abs(math.sqrt(sum(x * x for x in vector)) - 1.0) < 1e-9, vector


def test_embedding_only_skips_baseline_acoustic_work():
    original = (aw.ensure_fast_decode, aw.get_embedder, aw.embed_windows, aw.load_audio)
    try:
        aw.ensure_fast_decode = lambda path, complete=None: (path, None)
        aw.get_embedder = lambda force=False: object()
        aw.embed_windows = lambda embedder, path, librosa, duration: [0.25, 0.75]

        def baseline_decode(*_args, **_kwargs):
            raise AssertionError("embedding-only analysis decoded the baseline acoustic window")

        aw.load_audio = baseline_decode
        result = aw.analyze(
            FakeLibrosa(), path="/music/track.flac", embed=True, embedding_only=True
        )
    finally:
        aw.ensure_fast_decode, aw.get_embedder, aw.embed_windows, aw.load_audio = original

    assert result == {"audio_embedding": [0.25, 0.75]}, result


def test_url_embedding_only_propagates_incomplete_and_cleans_owned_files():
    original = (
        aw.fetch_audio, aw.ensure_fast_decode, aw.get_embedder,
        aw.embed_windows, aw.load_audio,
    )
    src_fd, src = tempfile.mkstemp(suffix=".audio")
    decoded_fd, decoded = tempfile.mkstemp(suffix=".wav")
    os.close(src_fd)
    os.close(decoded_fd)
    seen = []
    try:
        aw.fetch_audio = lambda _url: (src, False)

        def predecode(path, complete=None):
            seen.append((path, complete))
            return decoded, decoded

        aw.ensure_fast_decode = predecode
        aw.get_embedder = lambda force=False: object()

        def embed(_embedder, path, _librosa, _duration):
            assert path == decoded, path
            return [0.5, 0.5]

        aw.embed_windows = embed
        aw.load_audio = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("embedding-only analysis decoded baseline audio")
        )
        result = aw.analyze(
            FakeLibrosa(), url="https://music.invalid/track", embed=True,
            embedding_only=True,
        )
    finally:
        (
            aw.fetch_audio, aw.ensure_fast_decode, aw.get_embedder,
            aw.embed_windows, aw.load_audio,
        ) = original

    assert result == {"audio_embedding": [0.5, 0.5]}, result
    assert seen == [(src, False)], seen
    assert not os.path.exists(src), src
    assert not os.path.exists(decoded), decoded


def test_onnx_exports_keep_the_safe_sequential_fallback():
    embedder = aw.ClapEmbedder()
    embedder.mode = "onnx"
    calls = []

    def embed_one(window, sr):
        calls.append((window, sr))
        vector = Vector([0.0] * aw.CLAP_EMBED_DIM)
        vector[0] = float(window)
        return vector

    embedder._embed_onnx = embed_one
    vectors = embedder.embed_many([1.0, 2.0], aw.CLAP_SR)

    assert calls == [(1.0, aw.CLAP_SR), (2.0, aw.CLAP_SR)], calls
    assert len(vectors) == 2
    assert vectors[0][0] == 1.0 and vectors[1][0] == 1.0, vectors


def test_non_cuda_windows_decode_and_embed_one_at_a_time():
    events = []

    class Librosa(FakeLibrosa):
        def load(self, path, **kwargs):
            window, sr = super().load(path, **kwargs)
            events.append(("decode", window.marker))
            return window, sr

    class Embedder:
        def batches_windows(self):
            return False

        def embed(self, window, _sr):
            events.append(("embed", window.marker))
            return [1.0, 0.0]

    aw.embed_windows(Embedder(), "/music/track.flac", Librosa(), 200.0)

    assert events == [
        ("decode", 1.0), ("embed", 1.0),
        ("decode", 81.0), ("embed", 81.0),
        ("decode", 129.0), ("embed", 129.0),
    ], events


def test_only_cuda_transformers_batches_windows():
    decide = getattr(aw, "clap_batch_enabled", None)
    assert callable(decide), "clap_batch_enabled must define the batching boundary"
    assert decide("transformers", "cuda") is True
    assert decide("transformers", "cpu") is False
    assert decide("onnx", "cuda") is False


def test_cuda_transformers_runs_one_processor_and_model_batch():
    class Features:
        def __init__(self, audio):
            self.audio = audio
            self.device = None

        def to(self, device):
            self.device = device
            return self

    class Rows:
        ndim = 2

        def __init__(self, count):
            self.values = [Vector([1.0] + [0.0] * (aw.CLAP_EMBED_DIM - 1)) for _ in range(count)]
            self.shape = (count, aw.CLAP_EMBED_DIM)

        def __iter__(self):
            return iter(self.values)

    class Tensor:
        def __init__(self, count):
            self.rows = Rows(count)

        def cpu(self):
            return self

        def numpy(self):
            return self.rows

    class Processor:
        def __init__(self):
            self.calls = []

        def __call__(self, **kwargs):
            self.calls.append(kwargs)
            return {"input_features": Features(kwargs.get("audio") or kwargs["audios"])}

    class Model:
        def __init__(self):
            self.calls = []

        def get_audio_features(self, input_features):
            self.calls.append(input_features)
            return Tensor(len(input_features.audio))

    class NoGrad:
        def __enter__(self):
            return None

        def __exit__(self, *_args):
            return False

    fake_torch = types.ModuleType("torch")
    fake_torch.no_grad = lambda: NoGrad()
    original_torch = sys.modules.get("torch")
    original_resolve = aw.resolve_device
    try:
        sys.modules["torch"] = fake_torch
        aw.resolve_device = lambda: "cuda"
        embedder = aw.ClapEmbedder()
        embedder.mode = "transformers"
        embedder.processor = Processor()
        embedder.model = Model()
        vectors = embedder.embed_many([[1.0], [2.0], [3.0]], aw.CLAP_SR)
    finally:
        aw.resolve_device = original_resolve
        if original_torch is None:
            sys.modules.pop("torch", None)
        else:
            sys.modules["torch"] = original_torch

    assert len(embedder.processor.calls) == 1, embedder.processor.calls
    assert len(embedder.model.calls) == 1, embedder.model.calls
    assert embedder.model.calls[0].device == "cuda"
    assert len(vectors) == 3


def test_cuda_batch_failure_retries_windows_sequentially():
    original_resolve = aw.resolve_device
    original_stderr = sys.stderr
    log_output = io.StringIO()
    try:
        aw.resolve_device = lambda: "cuda"
        sys.stderr = log_output
        embedder = aw.ClapEmbedder()
        embedder.mode = "transformers"
        calls = []

        def run(windows, _sr):
            calls.append(len(windows))
            if len(windows) > 1:
                raise RuntimeError("CUDA out of memory")
            return [[1.0, 0.0]]

        embedder._embed_transformers = run
        vectors = embedder.embed_many([1.0, 2.0, 3.0], aw.CLAP_SR)
    finally:
        aw.resolve_device = original_resolve
        sys.stderr = original_stderr

    assert calls == [3, 1, 1, 1], calls
    assert vectors == [[1.0, 0.0]] * 3, vectors
    assert "retrying sequentially" in log_output.getvalue()


print("analyzer embedding efficiency:")
test("CLAP windows share one model forward", test_clap_windows_share_one_model_forward)
test("embedding-only skips baseline acoustic work", test_embedding_only_skips_baseline_acoustic_work)
test("URL embedding-only passes completeness and cleans files", test_url_embedding_only_propagates_incomplete_and_cleans_owned_files)
test("ONNX exports retain sequential fallback", test_onnx_exports_keep_the_safe_sequential_fallback)
test("non-CUDA windows decode and embed one at a time", test_non_cuda_windows_decode_and_embed_one_at_a_time)
test("only CUDA transformers batch windows", test_only_cuda_transformers_batches_windows)
test("CUDA transformers run one processor/model batch", test_cuda_transformers_runs_one_processor_and_model_batch)
test("CUDA batch failure retries sequentially", test_cuda_batch_failure_retries_windows_sequentially)

if failures:
    print(f"✗ analyzer_embedding_test.py: {failures} failure(s)")
    sys.exit(1)
print("✓ analyzer_embedding_test.py passed")
