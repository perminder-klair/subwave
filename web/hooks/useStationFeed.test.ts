// The feed's copy of /state (#2072). `streamIdleWindow` is published as ages,
// so two polls of a quiet station differ only there. The feed compares each
// poll with the last by JSON and keeps the old object when nothing changed,
// which is what stops a quiet poll re-rendering every feed consumer.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StationState } from '@/lib/types';
import { feedState } from './useStationFeed';

const poll = (startedMsAgo: number, endedMsAgo: number | null): StationState => ({
  current: { title: 'Song', startedAt: '2026-10-29T10:00:00.000Z' },
  upcoming: [],
  history: [],
  streamIdle: endedMsAgo === null,
  streamIdleWindow: { startedMsAgo, endedMsAgo },
  timezone: 'Europe/London',
} as StationState);

test('two polls of a quiet station compare equal once the ages are dropped', () => {
  // A live station paused once, five seconds between polls.
  assert.notEqual(JSON.stringify(poll(905_000, 300_000)), JSON.stringify(poll(910_000, 305_000)));
  assert.equal(JSON.stringify(feedState(poll(905_000, 300_000))), JSON.stringify(feedState(poll(910_000, 305_000))));
  // And during a pause.
  assert.equal(JSON.stringify(feedState(poll(60_000, null))), JSON.stringify(feedState(poll(65_000, null))));
});

test('everything else in the payload is kept', () => {
  const st = feedState(poll(905_000, 300_000)) as StationState & { current?: unknown };
  assert.equal('streamIdleWindow' in st, false);
  assert.deepEqual(st.current, { title: 'Song', startedAt: '2026-10-29T10:00:00.000Z' });
  assert.equal(st.streamIdle, false);
  assert.equal(st.timezone, 'Europe/London');
  // An older controller's payload passes through unchanged.
  assert.deepEqual(feedState({ upcoming: [], history: [] }), { upcoming: [], history: [] });
});
