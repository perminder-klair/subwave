import assert from 'node:assert/strict';
import test from 'node:test';
import { aboveTrackCeiling } from '../src/music/track-ceiling.js';

test('ceiling is inclusive, unknown-pass and hard even to empty', () => {
  const tracks = [{ duration: 1199 }, { durationSec: 1200 }, { duration: 1201 }, { duration: 2700 }, {}, { duration: 0 }, { duration: -1 }, { duration: Infinity }];
  assert.deepEqual(tracks.map(track => aboveTrackCeiling(track, 1200)), [false, false, true, true, false, false, false, false]);
  assert.equal(aboveTrackCeiling({ duration: 0, durationSec: 1201 }, 1200), true);
  for (const maxSec of [null, undefined, 0, -1]) {
    assert.equal(aboveTrackCeiling({ duration: 2700 }, maxSec), false);
  }
  assert.equal(aboveTrackCeiling(null, 1200), false);
  assert.equal(aboveTrackCeiling(undefined, 1200), false);
});
