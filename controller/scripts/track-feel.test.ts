// Unit tests for the track feel resolver (llm/internal/prompts/track-feel.ts)
// — the one adjective the script generators get about how a track actually
// sounds (issue #1443).
//
// Two families of pins: the arousal split must read the AUDIO moods (never the
// editorial `moods`, which is what produced the reported bug), and every
// unknown case must degrade to '' so an un-analysed track builds a prompt
// byte-identical to the pre-change one.
//
// Run: `npm test -- track-feel`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { trackFeel, trackFeelSuffix } from '../src/llm/internal/prompts/track-feel.js';

await test('the reported track reads high-energy from its audio moods', () => {
  // Arctic Monkeys — "Balaclava", 143.6 BPM. The DJ introduced this with
  // "slow down and let a steady groove take over".
  const balaclava = { audioMoods: ['workout', 'festival', 'celebratory'] };
  assert.equal(trackFeel(balaclava), 'high-energy');
  assert.equal(trackFeelSuffix(balaclava), ' — high-energy');
});

await test('the editorial moods field is ignored, even when it disagrees', () => {
  // Same track: `moods` says ["reflective","night"] — the tagger reading the
  // metadata. Reading that field instead would keep the bug.
  const balaclava = {
    moods: ['reflective', 'night'],
    audioMoods: ['workout', 'festival', 'celebratory'],
  };
  assert.equal(trackFeel(balaclava), 'high-energy');
});

await test('a genuinely quiet track reads low-key', () => {
  assert.equal(trackFeel({ audioMoods: ['calm', 'reflective', 'night'] }), 'low-key');
  assert.equal(trackFeelSuffix({ audioMoods: ['calm', 'night'] }), ' — low-key');
});

await test('mixed moods resolve to the dominant end', () => {
  assert.equal(trackFeel({ audioMoods: ['workout', 'driving', 'night'] }), 'high-energy');
  assert.equal(trackFeel({ audioMoods: ['calm', 'focus', 'energetic'] }), 'low-key');
});

await test('an even split is not a feel', () => {
  assert.equal(trackFeel({ audioMoods: ['workout', 'calm'] }), null);
  assert.equal(trackFeelSuffix({ audioMoods: ['workout', 'calm'] }), '');
});

await test('un-analysed and malformed tracks are a no-op', () => {
  // Every one of these must produce '' — the prompt is then byte-identical to
  // the pre-change one, which is the upgrade contract in CLAUDE.md.
  for (const track of [
    {}, null, undefined,
    { audioMoods: [] },
    { audioMoods: null },
    { audioMoods: 'workout' },      // not an array
    { moods: ['reflective'] },      // editorial moods only, no audio scoring
  ]) {
    assert.equal(trackFeelSuffix(track as any), '', `expected no suffix for ${JSON.stringify(track)}`);
  }
});

await test('labels outside the vocabulary degrade rather than guess', () => {
  // Moods are operator-editable, so a renamed or deleted label must not flip
  // the answer — it must drop out of the count.
  assert.equal(trackFeel({ audioMoods: ['brooding', 'wintry'] }), null);
  assert.equal(trackFeel({ audioMoods: ['brooding', 'workout'] }), 'high-energy');
});

await test('matching is case-insensitive', () => {
  assert.equal(trackFeel({ audioMoods: ['Workout', 'FESTIVAL'] }), 'high-energy');
});
