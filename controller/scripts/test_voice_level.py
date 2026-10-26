#!/usr/bin/env python3
"""Tests for voice_level.level, the on-air leveller both heavy-engine workers use.

Needs numpy and nothing else (no torch, no model), so any python3 with numpy
runs it:

    python3 controller/scripts/test_voice_level.py

CI runs eslint + tsc only (no Python runner), so this is a manual/regression
harness, like test_chatterbox_chunk.py. Exits non-zero on the first failure.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voice_level import CEILING, KNEE, level  # noqa: E402

FAILS = []


def check(name, cond):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name}")
    if not cond:
        FAILS.append(name)


def rms(a):
    return float(np.sqrt(np.mean(np.asarray(a, dtype=np.float64) ** 2)))


rng = np.random.default_rng(1130)
t = np.arange(24000) / 24000.0

# A quiet, low-crest clip: scaled to the target, the limiter never engages.
quiet = (0.02 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
out = level(quiet, 0.135)
check("quiet clip reaches the target RMS", abs(rms(out) - 0.135) < 1e-4)
check("below the knee the shape is only scaled", np.allclose(out, quiet * (0.135 / rms(quiet)), atol=1e-6))
check("output is float32", out.dtype == np.float32)

# A peaky clip at a hot target: the knee engages, nothing passes the ceiling.
# An extreme over saturates float32's tanh to exactly 1.0 and lands ON it.
peaky = (rng.standard_normal(48000) * 0.01).astype(np.float32)
peaky[::997] = 0.3
hot = level(peaky, 0.245)
# Compared in float32: CEILING stored as float32 is 0.97000003.
check("no sample passes the ceiling", np.max(np.abs(hot)) <= np.float32(CEILING))
check("the limiter engaged", bool(np.any(np.abs(level(peaky, 0.245)) > KNEE)))
check("signs survive the limiter", bool(np.all(np.sign(hot[peaky != 0]) == np.sign(peaky[peaky != 0]))))
# The limiter only ever pulls a sample in, so the RMS lands at or under target.
check("limited clip lands at or under the target", rms(hot) <= 0.245 + 1e-4)

# Edges: silence and an empty clip pass through.
check("silence stays silence", np.array_equal(level(np.zeros(100, dtype=np.float32), 0.2), np.zeros(100, dtype=np.float32)))
check("empty clip stays empty", level(np.zeros(0, dtype=np.float32), 0.2).size == 0)

# Chatterbox's stitched clips can be [samples, channels]; the gain is shared.
stereo = np.stack([quiet, quiet * 0.5], axis=1)
out2 = level(stereo, 0.1)
check("multichannel keeps its shape", out2.shape == stereo.shape)
check("multichannel keeps the channel balance", np.allclose(out2[:, 1], out2[:, 0] * 0.5, atol=1e-6))

if FAILS:
    print(f"\n{len(FAILS)} failure(s)")
    sys.exit(1)
print("\nall passed")
