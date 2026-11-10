// Asking again about the saved station password while the player is stuck
// connecting (#2141): a stall that starts soon after a check waits out the
// gap rather than going unchecked, a network drop does not use up the check
// before the controller denies a rotated password, and nothing asks faster
// than one check per RECHECK_MIN_GAP_MS, since /station-auth is rate-limited
// per household. A 429's Retry-After holds the next one longer (#2164).

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { RATE_LIMIT_MAX_WAIT_MS, rateLimitedUntil, type StationAuthResult } from '../src/lib/station-password.ts';
import { RECHECK_MIN_GAP_MS, STUCK_RECHECK_MS, watchStuckPassword } from '../src/lib/stuck-password-check.ts';

const START = 1_000_000;

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A player stuck connecting from START, with the controller answering
 *  `answers` in turn (the last one for good), each after `latencyMs`. A
 *  'rate-limited' answer carries `retryAfter`, read as the client reads it. */
function stuck(
  t: TestContext,
  opts: {
    answers: StationAuthResult[];
    latencyMs?: number;
    lastCheckAt?: number;
    current?: () => boolean;
    retryAfter?: string;
    heldUntil?: number;
  },
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const asked: number[] = [];
  const denied: number[] = [];
  let lastCheckAt = opts.lastCheckAt ?? 0;
  let heldUntil = opts.heldUntil ?? 0;
  const answers = [...opts.answers];
  const cancel = watchStuckPassword({
    check: () => {
      lastCheckAt = Date.now();
      asked.push(lastCheckAt - START);
      const answer = answers.length > 1 ? answers.shift()! : answers[0];
      return new Promise((resolve) =>
        setTimeout(() => {
          heldUntil = answer === 'rate-limited' ? rateLimitedUntil(opts.retryAfter ?? null, Date.now()) : 0;
          resolve(answer);
        }, opts.latencyMs ?? 0),
      );
    },
    lastCheckAt: () => lastCheckAt,
    heldUntil: () => heldUntil,
    current: opts.current ?? (() => true),
    onDenied: () => {
      denied.push(Date.now() - START);
    },
  });
  t.after(cancel);
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      t.mock.timers.tick(Math.min(250, left));
      await settle();
    }
  };
  return { asked, denied, cancel, tick };
}

test('a stall that starts soon after a check is checked once the gap allows, never skipped', async (t) => {
  // The visit check ran 5 s before the stall.
  const s = stuck(t, { answers: ['denied'], lastCheckAt: START - 5_000 });
  await s.tick(5 * 60_000);
  const first = RECHECK_MIN_GAP_MS - 5_000;
  assert.deepEqual(s.asked, [first], 'not at 15 s: the visit check was too recent');
  assert.deepEqual(s.denied, [first]);
});

test('a network drop does not use up the check before the controller denies the password', async (t) => {
  // Offline when the first check fires and still offline at the second, then
  // the signal is back and the controller denies the rotated password.
  const s = stuck(t, { answers: ['unavailable', 'unavailable', 'denied'] });
  await s.tick(10 * 60_000);
  const third = STUCK_RECHECK_MS + 2 * RECHECK_MIN_GAP_MS;
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS, third]);
  assert.deepEqual(s.denied, [third], 'reported once, and nothing asked after');
});

test('every answer but a denial asks again', async (t) => {
  // A pass goes stale if the password is rotated mid-stall; a 429 or a
  // proxy's answer says nothing about it.
  for (const answer of ['ok', 'unavailable', 'rate-limited'] as const) {
    await t.test(answer, async (st) => {
      const s = stuck(st, { answers: [answer, 'denied'] });
      await s.tick(STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS);
      assert.equal(s.asked.length, 2);
      assert.deepEqual(s.denied, [STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS]);
    });
  }
});

test('no check starts sooner than the gap after the last one, and a long stall stays inside the rate limit', async (t) => {
  // Every answer takes the fetch's whole timeout.
  const s = stuck(t, { answers: ['unavailable'], latencyMs: 8_000 });
  await s.tick(60 * 60_000);
  assert.equal(s.asked[0], STUCK_RECHECK_MS);
  for (let i = 1; i < s.asked.length; i++) {
    const gap = s.asked[i] - s.asked[i - 1];
    assert.ok(gap >= RECHECK_MIN_GAP_MS, `check ${i}: ${gap} ms after the last`);
  }
  // /station-auth allows 20 per 15 minutes per IP, and a household shares one.
  const windowMs = 15 * 60_000;
  const busiest = Math.max(...s.asked.map((at) => s.asked.filter((x) => x >= at && x < at + windowMs).length));
  assert.ok(busiest <= 8, `${busiest} checks in one 15-minute window`);
  assert.deepEqual(s.denied, []);
});

test("a 429's Retry-After holds the next check past the gap (#2164)", async (t) => {
  const s = stuck(t, { answers: ['rate-limited', 'denied'], retryAfter: '300' });
  await s.tick(STUCK_RECHECK_MS + 299_000);
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS], 'held for the 300 s it asked for');
  await s.tick(1_000);
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + 300_000]);
  assert.deepEqual(s.denied, [STUCK_RECHECK_MS + 300_000]);
});

test('a Retry-After shorter than the gap never brings a check forward', async (t) => {
  const s = stuck(t, { answers: ['rate-limited', 'denied'], retryAfter: '30' });
  await s.tick(10 * 60_000);
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS]);
});

test('a 429 with no Retry-After keeps the gap', async (t) => {
  const s = stuck(t, { answers: ['rate-limited', 'denied'] });
  await s.tick(10 * 60_000);
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS]);
});

test("a Retry-After far past the route's window still asks again within it", async (t) => {
  const s = stuck(t, { answers: ['rate-limited', 'denied'], retryAfter: '86400' });
  await s.tick(RATE_LIMIT_MAX_WAIT_MS + STUCK_RECHECK_MS);
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + RATE_LIMIT_MAX_WAIT_MS]);
  assert.deepEqual(s.denied, [STUCK_RECHECK_MS + RATE_LIMIT_MAX_WAIT_MS]);
});

test('a hold from before the stall delays the first check too', async (t) => {
  // The visit check or an unlock took the 429, on the same client.
  const s = stuck(t, { answers: ['denied'], heldUntil: START + 200_000 });
  await s.tick(5 * 60_000);
  assert.deepEqual(s.asked, [200_000]);
});

test('a hold survives the watcher being replaced, and a re-armed one cannot push it back', async (t) => {
  // The status flapping out of `connecting` re-runs the hook's effect.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const heldUntil = rateLimitedUntil('86400', START);
  const asked: number[] = [];
  const watch = () =>
    watchStuckPassword({
      check: async () => {
        asked.push(Date.now() - START);
        return 'unavailable';
      },
      lastCheckAt: () => START,
      heldUntil: () => heldUntil,
      current: () => true,
      onDenied: () => {},
    });
  let cancel = watch();
  for (let at = 0; at < RATE_LIMIT_MAX_WAIT_MS - 60_000; at += 60_000) {
    t.mock.timers.tick(60_000);
    await settle();
    cancel();
    cancel = watch();
  }
  assert.deepEqual(asked, [], 'still held');
  t.mock.timers.tick(60_000);
  await settle();
  cancel();
  assert.deepEqual(asked, [RATE_LIMIT_MAX_WAIT_MS], 'the cap was set once, when the 429 landed');
});

test('a stall that ends before the first check asks nothing', async (t) => {
  const s = stuck(t, { answers: ['denied'] });
  await s.tick(STUCK_RECHECK_MS - 1_000);
  s.cancel();
  await s.tick(5 * 60_000);
  assert.deepEqual(s.asked, []);
});

test('a stall that ends asks nothing more, but a denial already in flight is still reported', async (t) => {
  // A stop while the check was out: the prompt must still say why.
  const s = stuck(t, { answers: ['denied'], latencyMs: 2_000 });
  await s.tick(STUCK_RECHECK_MS + 1_000);
  s.cancel();
  await s.tick(5 * 60_000);
  assert.deepEqual(s.denied, [STUCK_RECHECK_MS + 2_000]);
  assert.equal(s.asked.length, 1);
});

test('a stall that ends drops any other answer in flight and asks nothing more', async (t) => {
  const s = stuck(t, { answers: ['unavailable', 'denied'], latencyMs: 2_000 });
  await s.tick(STUCK_RECHECK_MS + 1_000);
  s.cancel();
  await s.tick(10 * 60_000);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.denied, []);
});

test("an answer about another station's client is dropped and asks nothing more", async (t) => {
  let current = true;
  const s = stuck(t, { answers: ['denied'], latencyMs: 2_000, current: () => current });
  await s.tick(STUCK_RECHECK_MS + 1_000);
  current = false;
  await s.tick(5 * 60_000);
  assert.deepEqual(s.denied, []);
  assert.equal(s.asked.length, 1);
});
