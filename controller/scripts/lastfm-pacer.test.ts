// Pacing for the track-tag pass (music/lastfm-pacer.ts). Last.fm publishes no
// hard limit, so the rate is ours to keep: about 4 requests a second across the
// whole pool, a real pause on a 429 or error 29, and an end to the pass when
// Last.fm has stopped answering. A fake clock, because the real holds are minutes.
//
// Run: npm test -- lastfm-pacer

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLastfmPacer } from '../src/music/lastfm-pacer.js';
import { mapPool } from '../src/util/async-pool.js';

function fakeClock() {
  const clock = {
    t: 1_000_000,
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms; },
  };
  return clock;
}

test('the default gap keeps the total at or under 4 a second, however wide the pool', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep });
  const starts: number[] = [];
  await mapPool(Array.from({ length: 40 }), 8, async () => {
    assert.equal(await pacer.turn(), true);
    starts.push(clock.t);
  });
  assert.equal(starts.length, 40);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= 250, `gap ${i}: ${starts[i] - starts[i - 1]} ms`);
  }
});

test('a rate limit holds every worker, and for longer than a server error does', async () => {
  const hold = async (rateLimited: boolean) => {
    const clock = fakeClock();
    const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep });
    await pacer.turn();
    const before = clock.t;
    pacer.failed(rateLimited);
    await pacer.turn();
    return clock.t - before;
  };
  assert.ok((await hold(true)) >= 30_000);
  const serverError = await hold(false);
  assert.ok(serverError >= 5_000 && serverError < 30_000);
});

test('the hold doubles while failures run on, and an answer resets it', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep, maxConsecutiveFailures: 99 });
  const holds: number[] = [];
  for (let i = 0; i < 3; i++) {
    await pacer.turn();
    const before = clock.t;
    pacer.failed(true);
    await pacer.turn();
    holds.push(clock.t - before);
  }
  assert.deepEqual(holds, [30_000, 60_000, 120_000]);

  pacer.answered();
  const before = clock.t;
  pacer.failed(true);
  await pacer.turn();
  assert.equal(clock.t - before, 30_000);
});

test('the hold has a ceiling', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep, maxConsecutiveFailures: 99 });
  for (let i = 0; i < 9; i++) {
    await pacer.turn();
    pacer.failed(true);
  }
  const before = clock.t;
  await pacer.turn();
  assert.ok(clock.t - before <= 300_000);
});

test('requests in flight when a hold begins are the same incident', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep, maxConsecutiveFailures: 2 });
  await pacer.turn();
  pacer.failed(true);
  // Three more of the pool's requests land inside that hold. Counted, they would
  // end the pass on the strength of one 429.
  pacer.failed(true);
  pacer.failed(true);
  pacer.failed(true);
  assert.equal(pacer.gaveUp, false);
});

test('enough consecutive failures end the pass, and no later turn is granted', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep });
  let granted = 0;
  while (await pacer.turn()) {
    granted += 1;
    assert.ok(granted < 50, 'the pass never gave up');
    pacer.failed(false);
  }
  assert.equal(granted, 6);
  assert.equal(pacer.gaveUp, true);
  assert.equal(await pacer.turn(), false);
});

test('a rate-limited pass gives up inside a quarter of an hour', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep });
  const started = clock.t;
  let turns = 0;
  while (await pacer.turn()) {
    turns += 1;
    assert.ok(turns < 50, 'the pass never gave up');
    pacer.failed(true);
  }
  assert.ok(clock.t - started <= 15 * 60_000, `${(clock.t - started) / 1000} s`);
});

test('scattered failures never add up to giving up', async () => {
  const clock = fakeClock();
  const pacer = createLastfmPacer({ now: clock.now, sleep: clock.sleep });
  for (let i = 0; i < 30; i++) {
    await pacer.turn();
    pacer.failed(false);
    await pacer.turn();
    pacer.answered();
  }
  assert.equal(pacer.gaveUp, false);
});
