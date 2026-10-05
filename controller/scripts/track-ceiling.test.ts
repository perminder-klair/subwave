import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTrackCeiling, aboveTrackCeiling } from '../src/music/track-ceiling.js';

test('ceiling is inclusive, unknown-pass and hard even to empty', () => {
  const tracks = [{ duration: 1199 }, { durationSec: 1200 }, { duration: 1201 }, { duration: 2700 }, {}, { duration: 0 }, { duration: -1 }, { duration: Infinity }];
  assert.deepEqual(applyTrackCeiling(tracks, 1200), [tracks[0], tracks[1], ...tracks.slice(4)]);
  assert.deepEqual(applyTrackCeiling([{ duration: 2700 }], 1200), []);
  assert.equal(aboveTrackCeiling({ duration: 0, durationSec: 1201 }, 1200), true);
  assert.notEqual(applyTrackCeiling(tracks, null), tracks);
  assert.equal(tracks.length, 8);
});
