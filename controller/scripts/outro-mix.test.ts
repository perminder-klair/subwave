// Unit tests for the ending-aware transition helpers (music/mix.ts):
// endingCrossSecondsFor (a track's OWN exit canvas sized by its measured
// ending — the stampable replacement for the un-applied pair-sized value,
// #749) and the chop-over-fade veto in effectAllowedFor.
// Run: `tsx scripts/outro-mix.test.ts`.
//
// node:assert-via-tsx style, matching scripts/mix-fx.test.ts.

import assert from 'node:assert/strict';
import { endingCrossSecondsFor, effectAllowedFor, vocalTailFor } from '../src/music/mix.js';

// ── endingCrossSecondsFor ────────────────────────────────────────────────────

// Unknown ending → null (caller leaves crossSec unset — today's behaviour).
assert.equal(endingCrossSecondsFor({ bpm: null, key: null }, 20), null, 'no ending → null');
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: null }, 20),
  null,
  'null ending → null',
);

// A fade rides its wind-down, clamped into the broadcast wash range (8..12).
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20),
  12,
  'long fade clamps to 12s',
);
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 5),
  8,
  'short fade floors at 8s',
);
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, null),
  10,
  'fade with unknown wind-down defaults to 10s',
);

// A cold end cuts tight — same 4s as a locked beat-blend.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'cold' }, null),
  4,
  'cold end → tight 4s',
);

// Bar snap to the track's own tempo: 100 BPM → 2.4s bars → 4s snaps to 4.8s.
assert.equal(
  endingCrossSecondsFor({ bpm: 100, key: null, ending: 'cold' }, null),
  4.8,
  'cold canvas bar-snaps to the tempo',
);
// 120 BPM → 2s bars → a 12s fade canvas stays 12 (already 6 whole bars).
assert.equal(
  endingCrossSecondsFor({ bpm: 120, key: null, ending: 'fade' }, 20),
  12,
  'fade canvas bar-snaps cleanly at 120 BPM',
);

// The operator's crossfade ceiling wins over the fade target.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { maxSec: 6 }),
  6,
  'admin ceiling caps the fade canvas',
);
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'cold' }, null, { maxSec: 6 }),
  4,
  'cold canvas already under the ceiling is untouched',
);

// ── Tail-loudness shaping (fade canvases only) ───────────────────────────────

// A deep drop (≥12 dB below the body) is a true fade — the full wind-down ride
// survives unshaped.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -25, bodyLufs: -10 }),
  12,
  'deep tail drop keeps the full fade canvas',
);
// A shallow drop (≤3 dB) barely recedes — a full-length overlap would double
// two near-full-level tracks, so the canvas trims to its 8s floor.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -12, bodyLufs: -10 }),
  8,
  'shallow tail drop trims the canvas to the floor',
);
// Halfway between the shallow and deep thresholds (7.5 dB) interpolates
// linearly: base 12 → 8 + 4·0.5 = 10.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -17.5, bodyLufs: -10 }),
  10,
  'mid drop interpolates the canvas',
);
// Either loudness missing → no shaping (today's value).
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -25 }),
  12,
  'missing body loudness leaves the canvas unshaped',
);
// A tail LOUDER than the body (negative drop) clamps to the floor, not below.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -8, bodyLufs: -10 }),
  8,
  'louder-than-body tail clamps at the floor',
);
// Cold endings are never shaped — the tight cut IS the intent.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'cold' }, null, { tailLufs: -25, bodyLufs: -10 }),
  4,
  'cold canvas ignores tail loudness',
);

// ── effectAllowedFor: chop-over-fade veto ────────────────────────────────────

// A measured fade ending vetoes the chop outright — gating a fading tail is
// stabs of near-silence — even across a genuine clash.
assert.equal(
  effectAllowedFor('chop', { bpm: 100, key: '8A', ending: 'fade' }, { bpm: 150, key: '3B' }),
  false,
  'chop vetoed over a fade ending',
);
// The same clash with a cold ending keeps the chop available.
assert.equal(
  effectAllowedFor('chop', { bpm: 100, key: '8A', ending: 'cold' }, { bpm: 150, key: '3B' }),
  true,
  'chop allowed over a cold ending across a clash',
);
// The veto precedes the analysed() pass-through: a fade ending on an otherwise
// un-analysed pair still vetoes.
assert.equal(
  effectAllowedFor('chop', { bpm: null, key: null, ending: 'fade' }, { bpm: null, key: null }),
  false,
  'fade veto applies even without bpm/key',
);
// No ending signal → unchanged behaviour (un-analysed pairs pass).
assert.equal(
  effectAllowedFor('chop', { bpm: null, key: null }, { bpm: null, key: null }),
  true,
  'no outro signal → today\'s pass-through',
);

// ── vocalTailFor (feature: vocal-aware transitions) ──────────────────────────

// Tri-state derivation: null data → null (unknown), [] → false (measured
// instrumental tail), a span overlapping the wind-down → true.
assert.equal(vocalTailFor(null, 200_000), null, 'no tail vocal data → unknown');
assert.equal(vocalTailFor(undefined, 200_000), null, 'absent tail vocal data → unknown');
assert.equal(vocalTailFor([], 200_000), false, 'measured instrumental tail → false');
assert.equal(
  vocalTailFor([{ startMs: 195_000, endMs: 208_000 }], 200_000),
  true,
  'vocal span crossing the wind-down start → sung ending',
);
// A span ENTIRELY inside the wind-down also counts (endMs past the start).
assert.equal(
  vocalTailFor([{ startMs: 203_000, endMs: 206_000 }], 200_000),
  true,
  'vocal span inside the wind-down → sung ending',
);
// Vocals that stop BEFORE the wind-down leave the ending instrumental.
assert.equal(
  vocalTailFor([{ startMs: 185_000, endMs: 195_000 }], 200_000),
  false,
  'vocals ending before the wind-down → not a sung ending',
);
// Ranges without a usable wind-down anchor stay unknown, never guessed.
assert.equal(
  vocalTailFor([{ startMs: 1_000, endMs: 2_000 }], null),
  null,
  'no wind-down anchor → unknown',
);

// ── endingCrossSecondsFor: vocal-tail shaping ────────────────────────────────

// A sung fade is pulled to the 8s floor — a long overlap would put the next
// track under a still-singing voice.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { vocalTail: true }),
  8,
  'sung fade pulls the canvas to the floor',
);
// A measured instrumental tail keeps the full wind-down ride.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { vocalTail: false }),
  12,
  'instrumental tail keeps the full canvas',
);
// Unknown (null) changes nothing — today's value.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { vocalTail: null }),
  12,
  'unknown vocal tail leaves the canvas unshaped',
);
// The vocal pull applies after (and overrides) the deep-drop LUFS ride.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'fade' }, 20, { tailLufs: -25, bodyLufs: -10, vocalTail: true }),
  8,
  'vocal tail wins over the deep-drop full ride',
);
// Bar-snap still lands the pulled canvas on a musical unit (120 BPM → 2s bars,
// 8s = 4 bars exactly).
assert.equal(
  endingCrossSecondsFor({ bpm: 120, key: null, ending: 'fade' }, 20, { vocalTail: true }),
  8,
  'sung fade stays bar-snapped',
);
// Cold endings are untouched — 4s is already tight.
assert.equal(
  endingCrossSecondsFor({ bpm: null, key: null, ending: 'cold' }, null, { vocalTail: true }),
  4,
  'cold canvas ignores the vocal tail',
);

// ── effectAllowedFor: chop-over-voice veto ───────────────────────────────────

// A sung ending vetoes the chop even on a cold end across a clash — gating a
// voice mid-word stutters it.
assert.equal(
  effectAllowedFor('chop', { bpm: 100, key: '8A', ending: 'cold', vocalTail: true }, { bpm: 150, key: '3B' }),
  false,
  'chop vetoed over a sung ending',
);
// A measured instrumental tail keeps the chop available (cold + clash).
assert.equal(
  effectAllowedFor('chop', { bpm: 100, key: '8A', ending: 'cold', vocalTail: false }, { bpm: 150, key: '3B' }),
  true,
  'chop allowed over an instrumental cold ending',
);
// Unknown vocal tail → unchanged behaviour.
assert.equal(
  effectAllowedFor('chop', { bpm: 100, key: '8A', ending: 'cold', vocalTail: null }, { bpm: 150, key: '3B' }),
  true,
  'unknown vocal tail keeps today\'s chop behaviour',
);

console.log('outro-mix: all assertions passed');
