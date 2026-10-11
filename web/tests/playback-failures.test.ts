import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPlaybackFailures } from '../components/admin/debug/queries';

const failure = {
  t: '2026-10-04T10:00:00.000Z', attemptId: 'probe-1', sourceTrackId: 'backend-1',
  title: 'Song', artist: 'Artist', album: 'Album',
  source: 'request', stage: 'fetch', reason: 'source-resolution-failed',
};
const history = { failures: [failure], retentionDays: 14, truncated: false, warnings: [] };
const signal = new AbortController().signal;

test('failure query parses the shared contract and forwards its query signal', async () => {
  const result = await fetchPlaybackFailures(async (path, init) => {
    assert.equal(path, '/debug/playback-failures');
    assert.equal(init?.signal, signal);
    return Response.json(history);
  }, signal);
  assert.deepEqual(result, history);
});

test('failure query rejects malformed nested records before caching them', async () => {
  for (const invalid of [
    null, { ...failure, t: 'invalid date' }, { ...failure, source: 'fallback' },
    { ...failure, attemptId: '' }, { ...failure, stage: 'decode' }, { ...failure, reason: 'unknown' },
  ]) {
    await assert.rejects(
      fetchPlaybackFailures(async () => Response.json({ ...history, failures: [invalid] }), signal),
      /Unexpected failure history response/,
    );
  }
  await assert.rejects(
    fetchPlaybackFailures(async () => Response.json({ ...history, warnings: [{}] }), signal),
    /Unexpected failure history response/,
  );
});

test('generated failure schema applies the same safe metadata projection', async () => {
  const result = await fetchPlaybackFailures(async () => Response.json({
    ...history, failures: [{
      ...failure, title: 'T'.repeat(600), artist: undefined, album: '/private/song',
      streamUrl: 'https://host?token=secret',
    }],
  }), signal);
  assert.deepEqual(result.failures, [{ ...failure, title: 'T'.repeat(500), artist: null, album: null }]);
});
