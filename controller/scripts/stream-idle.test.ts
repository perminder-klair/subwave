// Unit tests for the pure idle-pause transition helper in
// broadcast/stream-idle-pure.ts. Run: `tsx scripts/stream-idle.test.ts`
// (folded into `npm run test`).
//
// nextIdleState decides when the programme idle-pauses (zero listeners for
// the configured window) and when it resumes. The branching is
// regression-critical: too eager and a zero-blip between listeners silences
// a live station; too lax and the wake-on-connect never fires, leaving a
// tuned-in listener staring at silence. node:assert-via-tsx style, matching
// listeners-status.test.ts.

import assert from 'node:assert/strict';
import { nextIdleState, type IdleState } from '../src/broadcast/stream-idle-pure.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const LIVE: IdleState = { idle: false, zeroSince: null };
const IDLE: IdleState = { idle: true, zeroSince: null };
const AFTER = 10 * 60_000; // 10 min window
const T0 = 1_000_000;

async function main() {
  console.log('nextIdleState (idle-pause transitions):');

  await test('disabled toggle is inert while live', () => {
    const r = nextIdleState(LIVE, { enabled: false, count: 0, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.deepEqual(r.state, LIVE);
  });

  await test('disabling the toggle mid-pause resumes the programme', () => {
    const r = nextIdleState(IDLE, { enabled: false, count: 0, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, 'resume');
    assert.equal(r.state.idle, false);
  });

  await test('first zero sample starts the empty clock, no action', () => {
    const r = nextIdleState(LIVE, { enabled: true, count: 0, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.equal(r.state.idle, false);
    assert.equal(r.state.zeroSince, T0);
  });

  await test('still-empty before the window elapses stays live', () => {
    const armed: IdleState = { idle: false, zeroSince: T0 };
    const r = nextIdleState(armed, { enabled: true, count: 0, now: T0 + AFTER - 1, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.equal(r.state.idle, false);
    assert.equal(r.state.zeroSince, T0); // clock keeps its original start
  });

  await test('window elapsed with the room still empty pauses', () => {
    const armed: IdleState = { idle: false, zeroSince: T0 };
    const r = nextIdleState(armed, { enabled: true, count: 0, now: T0 + AFTER, idleAfterMs: AFTER });
    assert.equal(r.action, 'pause');
    assert.equal(r.state.idle, true);
  });

  await test('a listener resets the empty clock', () => {
    const armed: IdleState = { idle: false, zeroSince: T0 };
    const r = nextIdleState(armed, { enabled: true, count: 2, now: T0 + AFTER, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.equal(r.state.zeroSince, null);
  });

  await test('an unknown count resets the empty clock (fail-open)', () => {
    const armed: IdleState = { idle: false, zeroSince: T0 };
    const r = nextIdleState(armed, { enabled: true, count: null, now: T0 + AFTER, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.equal(r.state.zeroSince, null);
  });

  await test('a listener connecting while idle resumes', () => {
    const r = nextIdleState(IDLE, { enabled: true, count: 1, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, 'resume');
    assert.equal(r.state.idle, false);
  });

  await test('an unknown count while idle resumes (fail-open)', () => {
    const r = nextIdleState(IDLE, { enabled: true, count: null, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, 'resume');
    assert.equal(r.state.idle, false);
  });

  await test('a still-empty room while idle re-asserts the gate', () => {
    const r = nextIdleState(IDLE, { enabled: true, count: 0, now: T0, idleAfterMs: AFTER });
    assert.equal(r.action, 'reassert');
    assert.equal(r.state.idle, true);
  });

  await test('resume immediately after re-arms rather than instantly re-pausing', () => {
    // After a resume the empty clock must be null — a stale zeroSince from
    // before the pause would re-pause on the very next zero sample.
    const resumed = nextIdleState(IDLE, { enabled: true, count: 1, now: T0, idleAfterMs: AFTER }).state;
    const r = nextIdleState(resumed, { enabled: true, count: 0, now: T0 + 1, idleAfterMs: AFTER });
    assert.equal(r.action, null);
    assert.equal(r.state.idle, false);
    assert.equal(r.state.zeroSince, T0 + 1); // clock restarts from now
  });

  process.exit(failures ? 1 : 0);
}

main();
