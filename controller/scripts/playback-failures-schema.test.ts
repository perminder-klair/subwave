import assert from 'node:assert/strict';
import test from 'node:test';
import {
  playbackFailureIdentitySchema, playbackFailureEventSchema, playbackFailureHistorySchema,
} from '../src/schemas/playback-failures.js';

const event = {
  type: 'track.failed', t: '2026-10-04T10:00:00Z', attemptId: 'probe-1',
  source: 'request', stage: 'fetch', reason: 'source-resolution-failed',
};

test('failure schemas preserve metadata repair, timestamp normalization and safe projection', () => {
  const parsed = playbackFailureEventSchema.parse({
    ...event, sourceTrackId: 'backend-1', title: 'T'.repeat(600),
    artist: 42, album: '/private/music/song', streamUrl: 'https://host?password=secret',
  });
  assert.deepEqual(parsed, {
    ...event, t: '2026-10-04T10:00:00.000Z', sourceTrackId: 'backend-1',
    title: 'T'.repeat(500), artist: null, album: null,
  });
  const identity = playbackFailureIdentitySchema.parse({ attemptId: 'probe-1', source: 'ai' });
  assert.deepEqual(identity, {
    attemptId: 'probe-1', source: 'ai', sourceTrackId: null, title: null, artist: null, album: null,
  });
  for (const unsafe of ['https://host?token=secret', '/private/music/song', 'C:\\music\\song', 'annotate:secret']) {
    assert.equal(playbackFailureIdentitySchema.parse({ ...identity, title: unsafe }).title, null);
    assert.equal(playbackFailureIdentitySchema.safeParse({ ...identity, attemptId: unsafe }).success, false);
  }
});

test('failure schemas reject invalid event identities and stage information', () => {
  for (const patch of [
    { type: 'track.play' }, { type: undefined }, { source: ['ai'] }, { source: 'fallback' },
    { t: 'invalid date' }, { t: 42 }, { attemptId: '' }, { attemptId: undefined },
    { stage: 'decode' }, { stage: undefined }, { reason: 'unknown' }, { reason: undefined },
  ]) {
    assert.equal(playbackFailureEventSchema.safeParse({ ...event, ...patch }).success, false, JSON.stringify(patch));
  }
});

test('history schema validates nested rows and warning strings', () => {
  const history = { failures: [event], retentionDays: 14, truncated: false, warnings: [] };
  assert.equal(playbackFailureHistorySchema.safeParse(history).success, true);
  assert.equal(playbackFailureHistorySchema.safeParse({ ...history, failures: [null] }).success, false);
  assert.equal(playbackFailureHistorySchema.safeParse({ ...history, failures: [{ ...event, source: 'fallback' }] }).success, false);
  assert.equal(playbackFailureHistorySchema.safeParse({ ...history, warnings: [{}] }).success, false);
});
