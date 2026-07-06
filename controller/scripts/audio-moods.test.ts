// Unit tests for the zero-shot audio-mood pure helpers (music/audio-moods.ts):
// topAudioMoods (relative top-K selection over a {mood: cosine} map — the rule
// that decides which labels land in tracks.audio_moods) and moodVocabHash
// (the invalidation key that re-scores the library when vocabulary/prompts
// change). Run: `tsx scripts/audio-moods.test.ts`.
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import { topAudioMoods, moodVocabHash, moodPrompt } from '../src/music/audio-moods.js';
import { SHOW_MOODS } from '../src/settings.js';

// ── topAudioMoods ────────────────────────────────────────────────────────────

// Clear winner with the rest far below the margin → single label.
assert.deepEqual(
  topAudioMoods({ energetic: 0.35, calm: 0.1, night: 0.05 }),
  ['energetic'],
  'only the runaway top mood survives',
);

// Scores within the margin of the best all survive, ordered best-first.
assert.deepEqual(
  topAudioMoods({ calm: 0.3, rainy: 0.28, night: 0.27, energetic: 0.1 }),
  ['calm', 'rainy', 'night'],
  'near-ties within the margin are kept, best first',
);

// The cap bounds the label count even when many moods tie.
assert.deepEqual(
  topAudioMoods({ a: 0.3, b: 0.3, c: 0.3, d: 0.3 }, { max: 2, margin: 0.05 }),
  ['a', 'b'],
  'max caps the label count',
);

// Negative cosines are fine — selection is relative to the best score.
assert.deepEqual(
  topAudioMoods({ calm: -0.02, energetic: -0.2 }),
  ['calm'],
  'relative selection works below zero',
);

// Empty and non-finite input degrade to no labels rather than throwing.
assert.deepEqual(topAudioMoods({}), [], 'empty score map → no labels');
assert.deepEqual(topAudioMoods({ calm: NaN }), [], 'non-finite scores are dropped');

// max is clamped to at least 1 — a winner always survives a zero/negative cap.
assert.deepEqual(
  topAudioMoods({ calm: 0.3, night: 0.1 }, { max: 0 }),
  ['calm'],
  'max clamps to ≥1',
);

// ── moodVocabHash ────────────────────────────────────────────────────────────

// Stable for the same vocabulary, sensitive to any entry change or reorder
// (order is part of the identity — prompts map positionally onto embeds).
assert.equal(moodVocabHash(), moodVocabHash(), 'hash is deterministic');
assert.notEqual(
  moodVocabHash(SHOW_MOODS),
  moodVocabHash([...SHOW_MOODS, 'brand-new-mood']),
  'adding a mood changes the hash',
);
assert.notEqual(
  moodVocabHash(['calm', 'energetic']),
  moodVocabHash(['energetic', 'calm']),
  'reordering changes the hash',
);
assert.equal(moodVocabHash().length, 16, 'hash is the 16-char short form');

// ── moodPrompt ───────────────────────────────────────────────────────────────

// Every vocabulary entry has a curated prompt (no accidental bare-word
// fallbacks for the shipped vocab), and unknown moods still produce something.
for (const m of SHOW_MOODS) {
  assert.notEqual(moodPrompt(m), `${m} music`, `curated prompt exists for "${m}"`);
}
assert.equal(moodPrompt('zydeco'), 'zydeco music', 'unknown mood falls back to the bare word');

console.log('audio-moods: all assertions passed');
