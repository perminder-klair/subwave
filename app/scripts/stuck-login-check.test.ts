// Asking again about a saved Station login while the player is stuck
// connecting (#1873): a network drop or a weak link must not use up the check
// before the station refuses the login, and nothing asks faster than one check
// per RECHECK_MIN_GAP_MS.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { HealthResult } from '../src/lib/api.ts';
import { RECHECK_MIN_GAP_MS, STUCK_RECHECK_MS, watchStuckLogin } from '../src/lib/stuck-login-check.ts';

const START = 1_000_000;
const BASIC = 'Basic realm="radio"';
const REFUSED: HealthResult = { ok: false, kind: 'http', status: 401, challenge: BASIC };
const OFFLINE: HealthResult = { ok: false, kind: 'network', message: 'Network request failed' };
const TIMEOUT: HealthResult = { ok: false, kind: 'timeout' };

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** A player stuck connecting from START, with the station answering `answers`
 *  in turn (the last one for good), each after `latencyMs`. */
function stuck(
  t: TestContext,
  opts: { answers: HealthResult[]; latencyMs?: number; lastCheckAt?: number; current?: () => boolean },
) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
  const asked: number[] = [];
  const refused: number[] = [];
  let lastCheckAt = opts.lastCheckAt ?? 0;
  const answers = [...opts.answers];
  const cancel = watchStuckLogin({
    probe: () => {
      lastCheckAt = Date.now();
      asked.push(lastCheckAt - START);
      const answer = answers.length > 1 ? answers.shift()! : answers[0];
      return new Promise((resolve) => setTimeout(() => resolve(answer), opts.latencyMs ?? 0));
    },
    lastCheckAt: () => lastCheckAt,
    current: opts.current ?? (() => true),
    onRefused: () => {
      refused.push(Date.now() - START);
    },
  });
  t.after(cancel);
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 250) {
      t.mock.timers.tick(Math.min(250, left));
      await settle();
    }
  };
  return { asked, refused, cancel, tick };
}

test('a network drop does not use up the check before the station refuses the login', async (t) => {
  // Offline when the first check fires, a weak link at the second, then the
  // signal is back and the proxy refuses the rotated login.
  const s = stuck(t, { answers: [OFFLINE, TIMEOUT, REFUSED] });
  await s.tick(5 * 60_000);
  const third = STUCK_RECHECK_MS + 2 * RECHECK_MIN_GAP_MS;
  assert.deepEqual(s.asked, [STUCK_RECHECK_MS, STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS, third]);
  assert.deepEqual(s.refused, [third], 'reported once, and nothing asked after');
});

test('every answer but a refusal asks again', async (t) => {
  const silent: HealthResult[] = [
    // The login was good when asked; the stall can outlast a password change.
    { ok: true },
    TIMEOUT,
    OFFLINE,
    // A tunnel or CDN in front of the proxy while the origin restarts.
    { ok: false, kind: 'http', status: 502 },
    { ok: false, kind: 'http', status: 530 },
    { ok: false, kind: 'http', status: 403, challenge: BASIC },
    { ok: false, kind: 'http', status: 401 },
    { ok: false, kind: 'http', status: 401, challenge: 'Bearer realm="radio"' },
  ];
  for (const answer of silent) {
    await t.test(JSON.stringify(answer), async (st) => {
      const s = stuck(st, { answers: [answer, REFUSED] });
      await s.tick(STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS);
      assert.equal(s.asked.length, 2);
      assert.deepEqual(s.refused, [STUCK_RECHECK_MS + RECHECK_MIN_GAP_MS]);
    });
  }
});

test('no check starts sooner than the gap after the last one of any kind', async (t) => {
  // The visit check ran 5 s before the stall, and every answer takes the
  // probe's whole timeout.
  const s = stuck(t, { answers: [OFFLINE], latencyMs: 4_500, lastCheckAt: START - 5_000 });
  await s.tick(10 * 60_000);
  assert.equal(s.asked[0], RECHECK_MIN_GAP_MS - 5_000, 'not at 8 s: the visit check was too recent');
  for (let i = 1; i < s.asked.length; i++) {
    const gap = s.asked[i] - s.asked[i - 1];
    assert.ok(gap >= RECHECK_MIN_GAP_MS, `check ${i}: ${gap} ms after the last`);
  }
  assert.equal(s.asked.length, 20, 'one check per gap across a 10-minute stall');
  assert.deepEqual(s.refused, []);
});

test('a stall that ends before the first check asks nothing', async (t) => {
  const s = stuck(t, { answers: [REFUSED] });
  await s.tick(STUCK_RECHECK_MS - 1_000);
  s.cancel();
  await s.tick(5 * 60_000);
  assert.deepEqual(s.asked, []);
});

test('a stall that ends drops the answer in flight and asks nothing more', async (t) => {
  const s = stuck(t, { answers: [REFUSED], latencyMs: 2_000 });
  await s.tick(STUCK_RECHECK_MS + 1_000);
  assert.equal(s.asked.length, 1);
  s.cancel();
  await s.tick(5 * 60_000);
  assert.deepEqual(s.refused, [], 'the player came unstuck before the answer');
  assert.equal(s.asked.length, 1);
});

test("an answer about another station's client is dropped and asks nothing more", async (t) => {
  let current = true;
  const s = stuck(t, { answers: [REFUSED], latencyMs: 2_000, current: () => current });
  await s.tick(STUCK_RECHECK_MS + 1_000);
  current = false;
  await s.tick(5 * 60_000);
  assert.deepEqual(s.refused, []);
  assert.equal(s.asked.length, 1);
});
