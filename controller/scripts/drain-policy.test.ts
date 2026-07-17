// Pins the pair-drain policy state machine (broadcast/drain-policy.ts) — the
// pure maths behind WHEN a queued track is handed to Liquidsoap (feature:
// pair-aware transitions, the #749 fix).
// node:assert-via-tsx style, matching scripts/outro-mix.test.ts.

import assert from 'node:assert/strict';
import {
  remainingSec, drainAction, shouldDeadlinePick,
  DRAIN_DEADLINE_SEC, HARD_DEADLINE_SEC,
} from '../src/broadcast/drain-policy.js';

// ── remainingSec ─────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000; // arbitrary epoch anchor

// 200s track, 60s elapsed → 140s left.
assert.equal(remainingSec(T0 + 60_000, T0, 200), 140, 'plain remaining');
// A stamped cue_out shortens the effective end (length-capped track).
assert.equal(remainingSec(T0 + 60_000, T0, 600, 200), 140, 'cue_out caps the effective end');
// cue_out longer than the track never extends it.
assert.equal(remainingSec(T0 + 60_000, T0, 200, 600), 140, 'duration wins when shorter than the cue');
// Past the end goes negative (stale current) — callers treat it as expired.
assert.equal(remainingSec(T0 + 300_000, T0, 200), -100, 'expired goes negative');
// Unknowable inputs → null, never a guess.
assert.equal(remainingSec(T0, null, 200), null, 'no start stamp → null');
assert.equal(remainingSec(T0, T0, null), null, 'no duration → null');
assert.equal(remainingSec(T0, T0, 0), null, 'zero duration → null');
assert.equal(remainingSec(T0, T0, NaN), null, 'NaN duration → null');

// ── drainAction ──────────────────────────────────────────────────────────────

// Successor known → pair-drain immediately, no reason to wait.
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: true, remainingSec: 500 }),
  'send-pair',
  'successor known → send-pair',
);
// Feature off → today's eager intrinsic drain, even with a successor
// (pair stamps are the feature; without it nothing changes byte-for-byte).
assert.equal(
  drainAction({ pairDrain: false, hasSuccessor: true, remainingSec: 500 }),
  'send-intrinsic',
  'pairDrain off + successor → intrinsic',
);
assert.equal(
  drainAction({ pairDrain: false, hasSuccessor: false, remainingSec: 500 }),
  'send-intrinsic',
  'pairDrain off → intrinsic',
);
// Unknowable clock (boot, recover, untracked auto play) → intrinsic.
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: false, remainingSec: null }),
  'send-intrinsic',
  'unknown remaining → intrinsic',
);
// Plenty of time, no successor yet → hold for the deadline pick.
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: false, remainingSec: 500 }),
  'hold',
  'time to spare → hold',
);
// Still inside the pick window → keep holding.
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: false, remainingSec: HARD_DEADLINE_SEC + 1 }),
  'hold',
  'above the hard deadline → hold',
);
// Hard deadline passed without a successor → send with intrinsic stamps.
// Never risk dead air for a prettier seam.
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: false, remainingSec: HARD_DEADLINE_SEC - 1 }),
  'send-intrinsic',
  'past the hard deadline → intrinsic',
);
assert.equal(
  drainAction({ pairDrain: true, hasSuccessor: false, remainingSec: -10 }),
  'send-intrinsic',
  'expired clock → intrinsic',
);

// ── shouldDeadlinePick ───────────────────────────────────────────────────────

// Fires only inside [HARD, DRAIN) — before the window there's nothing to do,
// past the hard deadline the intrinsic fallback owns the endgame.
assert.equal(shouldDeadlinePick(null), false, 'unknown clock → no deadline pick');
assert.equal(shouldDeadlinePick(DRAIN_DEADLINE_SEC + 1), false, 'before the window → no pick');
assert.equal(shouldDeadlinePick(DRAIN_DEADLINE_SEC - 1), true, 'inside the window → pick');
assert.equal(shouldDeadlinePick(HARD_DEADLINE_SEC), true, 'window includes the hard boundary');
assert.equal(shouldDeadlinePick(HARD_DEADLINE_SEC - 1), false, 'past hard deadline → no pick');
assert.equal(shouldDeadlinePick(-5), false, 'expired → no pick');

// The two deadlines must leave a real pick+render window between them.
assert.ok(DRAIN_DEADLINE_SEC - HARD_DEADLINE_SEC >= 60, 'pick window is at least a minute');

console.log('drain-policy: all assertions passed');
