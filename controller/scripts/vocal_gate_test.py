#!/usr/bin/env python3
# Unit test for the vocal gate (analyze_worker.vocal_ranges_from_rms) — the
# mix-anchored floor that fixes the #1125 mass false-positive. Pure numpy: no
# torch, no demucs, no audio, so it runs anywhere. Feeds synthesized RMS
# envelopes (the exact inputs the Demucs path produces) and asserts the floor
# behaves. Run: `python3 scripts/vocal_gate_test.py` (exit 0 = pass).

import os
import sys

import numpy as np

# Import the worker with default thresholds (VOCAL_MIX_FLOOR=0.06, STEM_REL=0.15).
# Heavy imports (torch/demucs/librosa) are lazy, so importing is stdlib-cheap.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze_worker as aw  # noqa: E402

SR = 44100
HOP = 512
FPS = SR / HOP  # frames per second (~86)


def frames(seconds):
    return int(round(seconds * FPS))


def const(seconds, value):
    return np.full(frames(seconds), value, dtype=np.float32)


assert aw.VOCAL_MIX_FLOOR == 0.06, "test assumes the shipped default floor"
assert aw.VOCAL_STEM_REL == 0.15, "test assumes the shipped default self-rel"

# ── Case 1: a pure instrumental (the #1125 bug) ──────────────────────────────
# Loud full mix (a normal song, ~0.5 RMS) but the vocal STEM is only separation
# bleed — low-level content Demucs leaves behind on an instrumental. Modelled
# here well below the 6% mix floor (mean ~0.01, peaks ~0.022 = ~2-4% of the
# 0.5 mix), with one sustained leak spike. NOTE: the exact 0.06 default is a
# reasoned starting value, NOT empirically calibrated against real Demucs bleed
# (no torch/audio in CI) — hence env-tunable. This case validates the MECHANISM:
# stem content below the mix floor is suppressed, content above it isn't.
rng = np.random.default_rng(0)
bleed = np.abs(rng.normal(0.01, 0.003, frames(40))).astype(np.float32)
bleed[frames(5):frames(6)] = 0.022  # a pad-swell leak spike, still < the 0.03 floor
mix_loud = const(40, 0.5)

# OLD behaviour (no mix floor) mass-flagged this as vocal: the self-relative gate
# (0.15 * the bleed's OWN 90th-pct) scales right down to the bleed and trips.
old = aw.vocal_ranges_from_rms(bleed, np.zeros_like(bleed), SR, HOP)
assert len(old) > 0, "sanity: without a mix floor the bleed DOES trip (the bug)"

# NEW behaviour: the mix floor (0.06 * 0.5 = 0.03) sits above the bleed → no
# vocal ranges → the track is correctly classed instrumental ([]).
new = aw.vocal_ranges_from_rms(bleed, mix_loud, SR, HOP)
assert new == [], f"instrumental must read as [] with the mix floor, got {new}"

# ── Case 2: a real vocal track ───────────────────────────────────────────────
# 27s instrumental intro (bleed only), then a sustained vocal at 0.3 (60% of the
# 0.5 mix) — the Fleetwood "The Chain" shape. The vocal must be detected, and its
# onset must land at the real entry, NOT during the guitar intro.
voc = np.abs(rng.normal(0.02, 0.008, frames(40))).astype(np.float32)
voc[frames(27):frames(38)] = 0.3
mix2 = const(40, 0.5)
ranges = aw.vocal_ranges_from_rms(voc, mix2, SR, HOP)
assert len(ranges) >= 1, "a real sustained vocal must be detected"
onset_s = ranges[0]["startMs"] / 1000.0
assert 26.5 <= onset_s <= 27.5, f"onset should be ~27s (the sung entry), got {onset_s:.1f}s"

# ── Case 3: the floor is tunable (reporter's fix #2) ──────────────────────────
# A borderline stem at 0.04 with mix loud 0.5: default floor 0.03 lets it
# through; raising VOCAL_MIX_FLOOR to 0.10 (floor 0.05) gates it out.
border = const(10, 0.04)
mix3 = const(10, 0.5)
assert len(aw.vocal_ranges_from_rms(border, mix3, SR, HOP)) > 0
saved = aw.VOCAL_MIX_FLOOR
try:
    aw.VOCAL_MIX_FLOOR = 0.10
    assert aw.vocal_ranges_from_rms(border, mix3, SR, HOP) == [], "raising the floor gates it"
finally:
    aw.VOCAL_MIX_FLOOR = saved

# ── Case 4: empty / silent inputs degrade cleanly ────────────────────────────
assert aw.vocal_ranges_from_rms(np.array([], dtype=np.float32), np.array([]), SR, HOP) == []
assert aw.vocal_ranges_from_rms(np.zeros(frames(5), dtype=np.float32), const(5, 0.5), SR, HOP) == []

# ── Case 5: DEMUCS_OVERLAP parses, falls back and clamps ─────────────────────
saved_env = os.environ.get("DEMUCS_OVERLAP")
try:
    for raw, want in [("", 0.25), ("0.1", 0.1), ("junk", 0.25), ("nan", 0.25), ("-1", 0.0), ("1", 0.9)]:
        os.environ["DEMUCS_OVERLAP"] = raw
        assert aw.demucs_overlap() == want, f"DEMUCS_OVERLAP={raw!r}: {aw.demucs_overlap()} != {want}"
finally:
    if saved_env is None:
        os.environ.pop("DEMUCS_OVERLAP", None)
    else:
        os.environ["DEMUCS_OVERLAP"] = saved_env

# ── Case 6: separate() hands DEMUCS_OVERLAP to apply_model ───────────────────
# Needs torch (heavy image); demucs itself is stubbed, so no model download.
try:
    import torch
except ImportError:
    torch = None
if torch is None:
    print("  (case 6 skipped: torch not installed)")
else:
    import types

    seen = {}

    def fake_apply_model(model, mix, device=None, overlap=None, **_kw):
        seen["overlap"] = overlap
        return torch.zeros(1, 4, *mix.shape[1:])

    stub = types.ModuleType("demucs.apply")
    stub.apply_model = fake_apply_model
    saved_mods = {k: sys.modules.get(k) for k in ("demucs", "demucs.apply")}
    sys.modules.setdefault("demucs", types.ModuleType("demucs"))
    sys.modules["demucs.apply"] = stub
    try:
        det = aw.VocalActivityDetector()
        det.model = object()
        det.sources = ["drums", "bass", "other", "vocals"]
        stems = det.separate(np.zeros((2, 64), dtype=np.float32))
        assert seen["overlap"] == aw.DEMUCS_OVERLAP, f"apply_model got overlap={seen.get('overlap')}"
        assert set(stems) == set(det.sources)
    finally:
        for k, v in saved_mods.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v

print("✓ vocal_gate_test.py passed")
