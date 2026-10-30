// The feed's copy of /state (#2072), mirroring web/hooks/useStationFeed.test.ts.
// `streamIdleWindow` is published as ages, so two polls of a quiet station
// differ only there. useStationFeed signs each field by JSON and keeps the old
// object when the signature is unchanged, which is what keeps PlayerScreen's
// memoized pages from re-rendering on a quiet poll.

import assert from 'node:assert/strict';
import test from 'node:test';
import { feedState } from '../src/lib/feed-state.ts';
import type { StationState } from '../src/lib/types.ts';

const poll = (startedMsAgo: number, endedMsAgo: number | null) => ({
  current: { title: 'Song', startedAt: '2026-10-29T10:00:00.000Z' },
  upcoming: [],
  history: [],
  streamIdle: endedMsAgo === null,
  streamIdleWindow: { startedMsAgo, endedMsAgo },
  timezone: 'Europe/London',
} as StationState);

test('two polls of a quiet station sign the same once the ages are dropped', () => {
  // A live station paused once, five seconds between polls.
  assert.notEqual(JSON.stringify(poll(905_000, 300_000)), JSON.stringify(poll(910_000, 305_000)));
  assert.equal(JSON.stringify(feedState(poll(905_000, 300_000))), JSON.stringify(feedState(poll(910_000, 305_000))));
  // And during a pause.
  assert.equal(JSON.stringify(feedState(poll(60_000, null))), JSON.stringify(feedState(poll(65_000, null))));
});

test('everything else in the payload is kept', () => {
  const st = feedState(poll(905_000, 300_000)) as StationState & { streamIdle?: boolean };
  assert.equal('streamIdleWindow' in st, false);
  assert.deepEqual(st.current, { title: 'Song', startedAt: '2026-10-29T10:00:00.000Z' });
  assert.equal(st.streamIdle, false);
  assert.equal(st.timezone, 'Europe/London');
  // An older controller's payload passes through unchanged.
  assert.deepEqual(feedState({ upcoming: [], history: [] }), { upcoming: [], history: [] });
});
