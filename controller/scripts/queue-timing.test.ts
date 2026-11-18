// Running-order timing on GET /state: each queue item's playable
// `duration` and each upcoming item's `airsAt` forecast.
//
// What this pins:
//   * `airsAt` is airForecastSec, row for row. They are one walk
//     (queue.upcomingTiming), so the Dash and the listener wait notice can
//     never disagree about when a request airs.
//   * an unknown length makes every LATER forecast absent, never short, and
//     the unknown item's own `duration` absent, never 0.
//   * a sent item's bed pushes back everything behind it.
//   * no start stamp on the on-air track (boot, recover, an untracked auto
//     play) leaves durations in place and every `airsAt` absent.
//
// Run: npm test -- queue-timing

import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { queue } from '../src/broadcast/queue.js';
import { publicQueueState } from '../src/util/public-feed.js';

// Same neutralisation the other queue tests use: persist() writes JSON and
// drainToLiquidsoap() renders TTS and blocks on a mixer poll.
(queue as any).persist = () => {};
(queue as any).drainToLiquidsoap = async () => {};

function onAir(duration: number, elapsedSec = 0) {
  queue.current = {
    track: { id: 'onair', title: 'On air', duration },
    startedAt: new Date(Date.now() - elapsedSec * 1000).toISOString(),
  } as any;
}

async function push(id: string, duration?: number) {
  await queue.push({
    track: { id, title: id, artist: 'A', ...(duration ? { duration } : {}) },
    requestedBy: 'studio', operator: true, allowDuplicate: true,
  });
}

const upcomingRows = () => queue.snapshot().upcoming as Array<{ duration?: number; airsAt?: string }>;
const airsInSec = (iso: string | undefined) => (iso ? (Date.parse(iso) - Date.now()) / 1000 : null);

beforeEach(() => {
  queue.upcoming = [];
  queue.current = null;
});

test('every upcoming row carries its length and a forecast that matches airForecastSec', async () => {
  onAir(200, 50);
  await push('one', 180);
  await push('two', 240);
  await push('three', 120);

  const rows = upcomingRows();
  assert.deepEqual(rows.map((r) => r.duration), [180, 240, 120]);
  rows.forEach((row, n) => {
    const forecast = queue.airForecastSec(queue.upcoming[n])!;
    assert.ok(Math.abs(airsInSec(row.airsAt)! - forecast) < 2, `row ${n}: ${row.airsAt} vs ${forecast}s`);
  });
  // ~150s left on air, then 180s and 240s ahead of the third.
  assert.ok(Math.abs(airsInSec(rows[2].airsAt)! - 570) < 2);
  assert.equal((queue.snapshot().current as { duration?: number }).duration, 200);
});

test('an unknown length leaves its own duration and every later forecast absent', async () => {
  onAir(200);
  await push('known', 180);
  await push('unknown');
  await push('after', 120);

  const [known, unknown, after] = upcomingRows();
  assert.equal(known.duration, 180);
  assert.ok(known.airsAt, 'the first row still has a forecast');
  assert.ok(unknown.airsAt, 'the unknown row starts after known lengths, so it still has one');
  assert.equal(unknown.duration, undefined);
  assert.equal(after.duration, 120);
  assert.equal(after.airsAt, undefined, 'nothing after an unknown length is forecast');
  assert.equal(queue.airForecastSec(queue.upcoming[2]), null);
});

test("a sent item's bed pushes back everything behind it", async () => {
  onAir(100);
  await push('linked', 200);
  await push('next', 200);
  const before = airsInSec(upcomingRows()[1].airsAt)!;
  queue.upcoming[0].sent = true;
  queue.upcoming[0].bedDelaySec = 24;
  const after = airsInSec(upcomingRows()[1].airsAt)!;
  assert.ok(Math.abs(after - before - 24) < 1, `moved ${after - before}s`);
});

test('no start stamp on air: durations stay, forecasts are absent', async () => {
  queue.current = { track: { id: 'onair', title: 'On air', duration: 200 } } as any;
  await push('one', 180);
  const [row] = upcomingRows();
  assert.equal(row.duration, 180);
  assert.equal(row.airsAt, undefined);
});

test('the public /state projection passes the timing through', async () => {
  onAir(200);
  await push('one', 180);
  const pub = publicQueueState(queue.snapshot()) as { upcoming: Array<{ duration?: number; airsAt?: string }> };
  assert.equal(pub.upcoming[0].duration, 180);
  assert.ok(pub.upcoming[0].airsAt);
});
