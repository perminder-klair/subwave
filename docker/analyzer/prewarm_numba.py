"""Build-time numba JIT cache pre-warm for the analyzer image.

librosa compiles its numba kernels (beat tracking, constant-Q helpers) on
first use and writes them to NUMBA_CACHE_DIR. That cache sits in the
container's writable layer, so every recreate starts it empty, and the pool's
workers all compile the same kernels on their first analysis job, at the same
moment. Concurrent cache writes are not safe: a worker that later loads the
torn index/data pair segfaults inside numba's gufunc dispatch (exit -11), and
every respawn of that slot dies the same way on its first job while the
workers that compiled in memory keep running. One pool slot crash-loops and
roughly one track in N fails.

Compiling once here, single-process, ships a complete cache in the image, so
runtime workers only read it. The cache entries are keyed on the CPU, so the
image pins NUMBA_CPU_NAME=generic (features empty): a cache built on the CI
runner then matches every host the image runs on, instead of missing and
recompiling (racing) on the first job.

The pre-warm drives the real worker over its stdio protocol on a synthetic
clip, so it compiles exactly what the analysis path calls, and follows the
worker when a facet starts using another numba kernel. Models stay off: the
pre-warm covers the librosa lane only. A worker error fails the build, since
the same image would fail at runtime; an empty cache afterwards only warns.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100
SECONDS = 30
BPM = 120.0


def synth_clip(path: Path) -> None:
    """A beat over a held A-minor chord, with silent edges for the edge facets."""
    t = np.arange(int(SR * SECONDS)) / SR
    chord = sum(np.sin(2 * np.pi * f * t) for f in (220.0, 261.63, 329.63)) / 3
    beat = np.zeros_like(t)
    click = np.exp(-np.arange(int(SR * 0.05)) / (SR * 0.008)) * np.sin(
        2 * np.pi * 60.0 * np.arange(int(SR * 0.05)) / SR
    )
    for start in np.arange(0.0, SECONDS, 60.0 / BPM):
        i = int(start * SR)
        beat[i:i + len(click)] += click[: len(beat) - i]
    y = 0.3 * chord + 0.6 * beat
    edge = int(SR * 1.0)
    y[:edge] = 0.0
    y[-edge:] = 0.0
    sf.write(str(path), y.astype(np.float32), SR, subtype="PCM_16")


def read_message(proc: subprocess.Popen) -> dict:
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(f"worker exited (code {proc.wait()}) before answering")
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)


def main() -> int:
    worker = os.environ.get("ANALYZE_WORKER", "/app/workers/analyze_worker.py")
    cache_dir = Path(os.environ.get("NUMBA_CACHE_DIR", ""))
    env = {
        **os.environ,
        "ANALYZE_AUDIO_EMBEDDING": "0",
        "ANALYZE_VOCAL_ACTIVITY": "0",
        "ANALYZE_DEVICE": "cpu",
    }
    with tempfile.TemporaryDirectory() as tmp:
        clip = Path(tmp) / "prewarm.wav"
        synth_clip(clip)
        proc = subprocess.Popen(
            [sys.executable, worker],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env,
        )
        assert proc.stdin is not None and proc.stdout is not None
        try:
            ready = read_message(proc)
            if not ready.get("ready"):
                raise RuntimeError(f"worker did not come up: {ready}")
            requests = [
                # The pool's facet lane (head = beat_track + chroma_cqt, tail). Only
                # facets every worker version knows: an unknown one fails the request.
                {"path": str(clip), "complete": True, "facets": ["head", "tail", "loudness"]},
                # The flat lane older controllers and the backfills still use.
                {"path": str(clip), "complete": True},
            ]
            for req in requests:
                proc.stdin.write(json.dumps(req) + "\n")
                proc.stdin.flush()
                msg = read_message(proc)
                if not msg.get("ok"):
                    raise RuntimeError(f"pre-warm request failed: {msg.get('error')}")
                facets = msg.get("facets") or {}
                statuses = {k: (v or {}).get("status") for k, v in facets.items()}
                print(f"[prewarm] {'facets ' + json.dumps(statuses) if facets else 'flat ok'}")
        finally:
            proc.stdin.close()
            proc.wait(timeout=60)

    indexes = sorted(p.relative_to(cache_dir) for p in cache_dir.rglob("*.nbi")) if cache_dir.is_dir() else []
    if not indexes:
        print(f"[prewarm] WARNING: no numba cache written under {cache_dir!s}", file=sys.stderr)
        return 0
    print(f"[prewarm] numba cache: {len(indexes)} kernels")
    for p in indexes:
        print(f"[prewarm]   {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
