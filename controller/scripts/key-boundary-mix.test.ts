// The boundary-key helpers (music/mix.ts): camelotFor (mirrored from
// analyze_worker.py), openingKeyFrom / endingKeyFrom, and the pair-aware key
// comparison inside mixCompat.

import assert from 'node:assert/strict';
import { camelotFor, openingKeyFrom, endingKeyFrom, mixCompat, keyCompat } from '../src/music/mix.js';

// camelotFor, spot-checked against the worker's MAJOR/MINOR_CAMELOT tables.
assert.equal(camelotFor('C', 'major'), '8B', 'C major → 8B');
assert.equal(camelotFor('A', 'minor'), '8A', 'A minor → 8A');
assert.equal(camelotFor('C#', 'major'), '3B', 'C# major → 3B');
assert.equal(camelotFor('B', 'minor'), '10A', 'B minor → 10A');
assert.equal(camelotFor('F#', 'minor'), '11A', 'F# minor → 11A');
// Case/whitespace tolerated; unknown tonic or mode is null.
assert.equal(camelotFor(' g# ', 'MAJOR'), '4B', 'tonic/mode normalised');
assert.equal(camelotFor('H', 'major'), null, 'unknown tonic → null');
assert.equal(camelotFor('C', 'dorian'), null, 'unknown mode → null');
assert.equal(camelotFor(null, 'major'), null, 'null tonic → null');

// A track modulating inside the analysis window: opens A minor, ends C major.
const ranges = [
  { startMs: 0, endMs: 20000, tonic: 'A', mode: 'minor' },
  { startMs: 20000, endMs: 38000, tonic: 'C', mode: 'major' },
];

assert.equal(openingKeyFrom(ranges, '5A'), '8A', 'opening key is the first range');
assert.equal(openingKeyFrom(null, '5A'), '5A', 'no ranges → fallback');
assert.equal(openingKeyFrom([], '5A'), '5A', 'empty ranges → fallback');

// The analysis window covers only the leading ~40s, so a longer track's last
// range is the key at ~40s, not its ending.
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

// mixCompat: boundary keys beat dominant keys. Dominant clash (5A vs 12B) but
// the seam is locked, 8A into 8A.
const seamLocked = mixCompat(
  { bpm: 120, key: '5A', keyEnd: '8A' },
  { bpm: 120, key: '12B', keyStart: '8A' },
);
const dominantOnly = mixCompat({ bpm: 120, key: '5A' }, { bpm: 120, key: '12B' });
assert.equal(seamLocked, 0.6 * 1 + 0.4 * 1, 'boundary keys drive the compat when present');
assert.equal(dominantOnly, 0.6 * 1, 'dominant keys still drive it when boundaries are absent');
assert.ok(seamLocked > dominantOnly, 'a locked seam scores above clashing dominants');

// keyCompat itself is untouched: boundary resolution happens at the call sites.
assert.equal(keyCompat('8A', '8B'), 0.8, 'relative major/minor unchanged');

console.log('key-boundary-mix: all assertions passed');
