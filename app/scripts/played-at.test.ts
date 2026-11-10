// The timeline's "N ago" on Played rows. GET /state history entries carry
// startedAt/queuedAt (queue.snapshot), not `t`, so a `t`-only read never
// rendered a time at all (#1848).

import assert from 'node:assert/strict';
import test from 'node:test';
import { playedAt } from '../src/lib/format.ts';

const STARTED = '2026-10-09T12:03:00.000Z';
const QUEUED = '2026-10-09T11:58:00.000Z';
const OLD_T = '2026-10-09T12:02:59.000Z';

test('the live controller shape reads startedAt, not the earlier queuedAt', () => {
  assert.equal(playedAt({ startedAt: STARTED, queuedAt: QUEUED }), STARTED);
});

test('an older payload with only `t` still renders', () => {
  assert.equal(playedAt({ t: OLD_T }), OLD_T);
  assert.equal(playedAt({ t: OLD_T, queuedAt: QUEUED }), OLD_T);
});

test('queuedAt is the last resort', () => {
  assert.equal(playedAt({ queuedAt: QUEUED }), QUEUED);
});

test('unparseable or missing stamps fall through, and none gives null', () => {
  assert.equal(playedAt({ startedAt: 'garbage', queuedAt: QUEUED }), QUEUED);
  assert.equal(playedAt({ startedAt: 1_760_000_000_000, t: OLD_T }), OLD_T, 'numbers are not the wire shape');
  assert.equal(playedAt({}), null);
  assert.equal(playedAt(null), null);
});
