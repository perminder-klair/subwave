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
import test from 'node:test';
import { nextIdleState, type IdleState } from '../src/broadcast/stream-idle-pure.js';
import { gatedCount } from '../src/broadcast/listeners.js';

const LIVE: IdleState = { idle: false, zeroSince: null };
const IDLE: IdleState = { idle: true, zeroSince: null };
const AFTER = 10 * 60_000; // 10 min window
const T0 = 1_000_000;

test('disabled toggle is inert while live', () => {
  const r = nextIdleState(LIVE, { enabled: false, count: 0, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.deepEqual(r.state, LIVE);
});

test('disabling the toggle mid-pause resumes the programme', () => {
  const r = nextIdleState(IDLE, { enabled: false, count: 0, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, 'resume');
  assert.equal(r.state.idle, false);
});

test('first zero sample starts the empty clock, no action', () => {
  const r = nextIdleState(LIVE, { enabled: true, count: 0, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.equal(r.state.idle, false);
  assert.equal(r.state.zeroSince, T0);
});

test('still-empty before the window elapses stays live', () => {
  const armed: IdleState = { idle: false, zeroSince: T0 };
  const r = nextIdleState(armed, { enabled: true, count: 0, now: T0 + AFTER - 1, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.equal(r.state.idle, false);
  assert.equal(r.state.zeroSince, T0); // clock keeps its original start
});

test('window elapsed with the room still empty pauses', () => {
  const armed: IdleState = { idle: false, zeroSince: T0 };
  const r = nextIdleState(armed, { enabled: true, count: 0, now: T0 + AFTER, idleAfterMs: AFTER });
  assert.equal(r.action, 'pause');
  assert.equal(r.state.idle, true);
});

test('a listener resets the empty clock', () => {
  const armed: IdleState = { idle: false, zeroSince: T0 };
  const r = nextIdleState(armed, { enabled: true, count: 2, now: T0 + AFTER, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.equal(r.state.zeroSince, null);
});

test('an unknown count resets the empty clock (fail-open)', () => {
  const armed: IdleState = { idle: false, zeroSince: T0 };
  const r = nextIdleState(armed, { enabled: true, count: null, now: T0 + AFTER, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.equal(r.state.zeroSince, null);
});

test('a listener connecting while idle resumes', () => {
  const r = nextIdleState(IDLE, { enabled: true, count: 1, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, 'resume');
  assert.equal(r.state.idle, false);
});

test('an unknown count while idle resumes (fail-open)', () => {
  const r = nextIdleState(IDLE, { enabled: true, count: null, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, 'resume');
  assert.equal(r.state.idle, false);
});

test('a still-empty room while idle re-asserts the gate', () => {
  const r = nextIdleState(IDLE, { enabled: true, count: 0, now: T0, idleAfterMs: AFTER });
  assert.equal(r.action, 'reassert');
  assert.equal(r.state.idle, true);
});

test('resume immediately after re-arms rather than instantly re-pausing', () => {
  // After a resume the empty clock must be null — a stale zeroSince from
  // before the pause would re-pause on the very next zero sample.
  const resumed = nextIdleState(IDLE, { enabled: true, count: 1, now: T0, idleAfterMs: AFTER }).state;
  const r = nextIdleState(resumed, { enabled: true, count: 0, now: T0 + 1, idleAfterMs: AFTER });
  assert.equal(r.action, null);
  assert.equal(r.state.idle, false);
  assert.equal(r.state.zeroSince, T0 + 1); // clock restarts from now
});

// ── The #1256 regression, driven the way the monitor drives it ────────────
// stream-idle.ts forces a fresh Icecast poll every 5s while paused — ~120
// polls per 10-minute pause — and feeds the result to nextIdleState. The
// branching above is right; what was wrong was the INPUT: on the raw poll
// result one 1.5s timeout read as null, which is the fail-open branch, so a
// sub-1% poll failure rate released nearly every pause (measured: paused,
// resumed 28s later, 13 times in one night). The count now comes through
// listeners.gatedCount, so these two must be tested together.
const LIMIT = 4;   // STALE_STATUS_LIMIT

// Replay a pause window: `polls` is one raw poll result per 5s tick (null =
// failed fetch). Returns every action the monitor would have fired.
function replay(polls: (number | null)[], idle: boolean): (string | null)[] {
  let st: IdleState = { idle, zeroSince: null };
  let lastGood: number | null = idle ? 0 : null;
  let consecutive = 0;
  const actions: (string | null)[] = [];
  polls.forEach((raw, i) => {
    if (raw === null) consecutive++;
    else { consecutive = 0; lastGood = raw; }
    const count = gatedCount(raw, lastGood, consecutive, LIMIT);
    const r = nextIdleState(st, {
      enabled: true, count, now: T0 + i * 5_000, idleAfterMs: AFTER,
    });
    actions.push(r.action);
    st = r.state;
  });
  return actions;
}

test('a single failed poll mid-pause no longer releases the pause', () => {
  const polls: (number | null)[] = Array(120).fill(0);
  polls[37] = null;                                   // one AbortError, next poll fine
  const actions = replay(polls, true);
  assert.equal(actions.includes('resume'), false);    // the whole window held
  assert.equal(actions.every(a => a === 'reassert'), true);
});

test('scattered isolated blips still hold the pause', () => {
  const polls: (number | null)[] = Array(120).fill(0);
  for (const i of [3, 4, 5, 40, 41, 90]) polls[i] = null;  // never 4 in a row
  const actions = replay(polls, true);
  assert.equal(actions.includes('resume'), false);
});

test('a sustained outage still resumes (fail-open preserved)', () => {
  const polls: (number | null)[] = Array(120).fill(0);
  for (let i = 10; i < 20; i++) polls[i] = null;      // Icecast genuinely gone
  const actions = replay(polls, true);
  assert.equal(actions[12], 'reassert');              // 3rd failure: still held
  assert.equal(actions[13], 'resume');                // 4th: unknown → fail open
});

test('a real listener still wakes the stream on the next tick', () => {
  const polls: (number | null)[] = Array(120).fill(0);
  polls[8] = null;                                    // blip first, so it can't
  polls[9] = 1;                                       // be credited with the wake
  const actions = replay(polls, true);
  assert.equal(actions[8], 'reassert');
  assert.equal(actions[9], 'resume');
});

// The other half of #1256, which the field report couldn't see from the
// symptom: while LIVE, an unknown count takes nextIdleState's "occupied (or
// unknown) — reset the empty clock" branch. So a blip inside the 10-minute
// window used to restart it, and the pause was being DELAYED by blips as well
// as released by them. Same gatedCount fix, opposite direction, so it needs
// its own replay: a live window is 120 ticks of the monitor's cached count.

// 10 min / 5s = tick 120 is the first one past the window, so a clean run
// pauses there. Every case below is measured against that baseline.
const PAUSE_TICK = AFTER / 5_000;

test('an empty room with clean polls pauses exactly on the window', () => {
  const actions = replay(Array(PAUSE_TICK + 5).fill(0), false);
  assert.equal(actions.indexOf('pause'), PAUSE_TICK);
});

test('a blip mid-window no longer restarts the empty clock', () => {
  const polls: (number | null)[] = Array(PAUSE_TICK + 5).fill(0);
  polls[60] = null;                                   // halfway through the wait
  const actions = replay(polls, false);
  assert.equal(actions.indexOf('pause'), PAUSE_TICK); // not deferred by 5 min
});

test('scattered blips still let the pause land on time', () => {
  const polls: (number | null)[] = Array(PAUSE_TICK + 5).fill(0);
  for (const i of [7, 8, 40, 41, 42, 99, 118]) polls[i] = null;  // never 4 in a row
  const actions = replay(polls, false);
  assert.equal(actions.indexOf('pause'), PAUSE_TICK);
});

test('a sustained outage while live still defers the pause (fail-open)', () => {
  // Unknown reads as occupied here, so the window genuinely restarts — that is
  // the documented fail-open, not the bug. Ticks 60-62 are held at 0; failure
  // #4 at tick 63 goes unknown and clears zeroSince, and it stays cleared
  // until tick 70 reads a real 0 again — so the clock starts there.
  const polls: (number | null)[] = Array(200).fill(0);
  for (let i = 60; i < 70; i++) polls[i] = null;
  const actions = replay(polls, false);
  assert.equal(actions.indexOf('pause'), 70 + PAUSE_TICK);
});

test('a real listener mid-window restarts the clock, blip or not', () => {
  const polls: (number | null)[] = Array(200).fill(0);
  polls[49] = null;                                   // blip first…
  polls[50] = 2;                                      // …then someone actually tunes in
  const actions = replay(polls, false);
  // The blip is absorbed; tick 50 clears the clock and tick 51 restarts it.
  assert.equal(actions.indexOf('pause'), 51 + PAUSE_TICK);
});
