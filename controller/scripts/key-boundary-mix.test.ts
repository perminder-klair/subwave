// Unit tests for the boundary-key helpers (music/mix.ts): camelotFor (the
// tonic+mode → Camelot table mirrored from analyze_worker.py), openingKeyFrom /
// endingKeyFrom (per-region key ranges → the two keys a transition actually
// meets), and the pair-aware key comparison inside mixCompat.
// Run: `tsx scripts/key-boundary-mix.test.ts`.
//
// node:assert-via-tsx style, matching scripts/mix-fx.test.ts.

import assert from 'node:assert/strict';
import { camelotFor, openingKeyFrom, endingKeyFrom, mixCompat, keyCompat } from '../src/music/mix.js';

// ── camelotFor ───────────────────────────────────────────────────────────────

// Spot-checks against the worker's MAJOR_CAMELOT / MINOR_CAMELOT tables.
assert.equal(camelotFor('C', 'major'), '8B', 'C major → 8B');
assert.equal(camelotFor('A', 'minor'), '8A', 'A minor → 8A');
assert.equal(camelotFor('C#', 'major'), '3B', 'C# major → 3B');
assert.equal(camelotFor('B', 'minor'), '10A', 'B minor → 10A');
assert.equal(camelotFor('F#', 'minor'), '11A', 'F# minor → 11A');
// Case/whitespace tolerated; unknown tonic or mode → null.
assert.equal(camelotFor(' g# ', 'MAJOR'), '4B', 'tonic/mode normalised');
assert.equal(camelotFor('H', 'major'), null, 'unknown tonic → null');
assert.equal(camelotFor('C', 'dorian'), null, 'unknown mode → null');
assert.equal(camelotFor(null, 'major'), null, 'null tonic → null');

// ── openingKeyFrom / endingKeyFrom ───────────────────────────────────────────

// A track that modulates inside the analysis window: opens in A minor,
// window ends in C major.
const ranges = [
  { startMs: 0, endMs: 20000, tonic: 'A', mode: 'minor' },
  { startMs: 20000, endMs: 38000, tonic: 'C', mode: 'major' },
];

assert.equal(openingKeyFrom(ranges, '5A'), '8A', 'opening key is the first range');
assert.equal(openingKeyFrom(null, '5A'), '5A', 'no ranges → fallback');
assert.equal(openingKeyFrom([], '5A'), '5A', 'empty ranges → fallback');

// Ending key is only trusted when the ranges genuinely reach the track's end
// (the analysis window covers only the leading ~40s, so a longer track's last
// range is the key at ~40s, NOT its ending).
assert.equal(
  endingKeyFrom(ranges, 40000, '5A'),
  '8B',
  'ranges reaching the end (within slack) → last range wins',
);
assert.equal(
  endingKeyFrom(ranges, 240000, '5A'),
  '5A',
  'track longer than the window → fallback to the dominant key',
);
assert.equal(endingKeyFrom(ranges, null, '5A'), '5A', 'unknown duration → fallback');
assert.equal(endingKeyFrom(null, 40000, '5A'), '5A', 'no ranges → fallback');

// ── mixCompat: boundary keys beat dominant keys ──────────────────────────────

// Dominant keys clash (5A vs 12B → 0) but the seam is locked: the outgoing
// track ENDS in 8A and the incoming one OPENS in 8A.
const seamLocked = mixCompat(
  { bpm: 120, key: '5A', keyEnd: '8A' },
  { bpm: 120, key: '12B', keyStart: '8A' },
);
const dominantOnly = mixCompat({ bpm: 120, key: '5A' }, { bpm: 120, key: '12B' });
assert.equal(seamLocked, 0.6 * 1 + 0.4 * 1, 'boundary keys drive the compat when present');
assert.equal(dominantOnly, 0.6 * 1, 'dominant keys still drive it when boundaries are absent');
assert.ok(seamLocked > dominantOnly, 'a locked seam scores above clashing dominants');

// keyCompat itself is untouched — the boundary resolution happens at the
// call sites, so a direct dominant-key comparison still behaves as before.
assert.equal(keyCompat('8A', '8B'), 0.8, 'relative major/minor unchanged');

console.log('key-boundary-mix: all assertions passed');
