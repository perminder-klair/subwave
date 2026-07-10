#!/usr/bin/env python3
"""Tiny tests for analyze_worker audio-shape helpers."""

import importlib.util
import pathlib
import sys

import numpy as np


worker_path = pathlib.Path(__file__).with_name("analyze_worker.py")
spec = importlib.util.spec_from_file_location("analyze_worker", worker_path)
worker = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(worker)


def assert_shape(name, arr, shape):
    if arr.shape != shape:
        raise AssertionError(f"{name}: expected shape {shape}, got {arr.shape}")


def main():
    mono = np.arange(5, dtype=np.float32)
    mono_stereo = worker.ensure_demucs_stereo(mono)
    assert_shape("mono", mono_stereo, (2, 5))
    np.testing.assert_allclose(mono_stereo[0], mono)
    np.testing.assert_allclose(mono_stereo[1], mono)

    stereo = np.vstack([np.arange(5), np.arange(5) + 10]).astype(np.float32)
    stereo_out = worker.ensure_demucs_stereo(stereo)
    assert_shape("stereo", stereo_out, (2, 5))
    np.testing.assert_allclose(stereo_out, stereo)

    surround = np.vstack([np.full(5, i, dtype=np.float32) for i in range(6)])
    surround_out = worker.ensure_demucs_stereo(surround)
    assert_shape("surround", surround_out, (2, 5))
    expected_mono = np.mean(surround, axis=0)
    np.testing.assert_allclose(surround_out[0], expected_mono)
    np.testing.assert_allclose(surround_out[1], expected_mono)

    print("analyze-worker audio helper tests passed")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"analyze-worker audio helper tests failed: {exc}", file=sys.stderr)
        raise
