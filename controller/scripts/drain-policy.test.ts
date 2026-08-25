// Pins the pair-drain policy state machine (broadcast/drain-policy.ts) — the
// pure maths behind WHEN a queued track is handed to Liquidsoap (feature:
// pair-aware transitions, the #749 fix).
// node:assert-via-tsx style, matching scripts/outro-mix.test.ts.

import assert from 'node:assert/strict';
import {
  remainingSec, drainAction, shouldDeadlinePick, introRenderBudgetSec,
  DRAIN_DEADLINE_SEC, HARD_DEADLINE_SEC, DEADLINE_PICK_COOLDOWN_SEC,
  DRAIN_COMMIT_RESERVE_SEC, MIN_PRERENDER_BUDGET_SEC,
} from '../src/broadcast/drain-policy.js';

// ── remainingSec ─────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000; // arbitrary epoch anchor

// 200s track, 60s elapsed → 140s left.
assert.equal(remainingSec(T0 + 60_000, T0, 200), 140, 'plain remaining');
// A stamped cue_out shortens the effective end (length-capped track).
assert.equal(remainingSec(T0 + 60_000, T0, 600, 200), 140, 'cue_out caps the effective end');
// A cue_in shortens the on-air span too: startedAt is stamped when the cued
// audio begins, not at byte zero. Forgetting this delays the deadline by the
// skipped head and can leave too little time to hand the successor over.
assert.equal(remainingSec(T0 + 60_000, T0, 200, null, 30), 110, 'cue_in shortens the effective span');
// Both cues describe absolute offsets in the file, so the playable span is
// cue_out - cue_in rather than either value on its own.
assert.equal(remainingSec(T0 + 60_000, T0, 600, 200, 30), 110, 'cue pair bounds the playable span');
// A cue pair that would invert (a degenerate stamp) floors at zero rather than
// running the clock backwards.
assert.equal(remainingSec(T0, T0, 200, 30, 60), 0, 'an inverted cue pair floors at zero');
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

// The failure-retry cooldown must be long enough to matter against the 1.5s
// watcher tick, yet short enough that the pick window still fits at least two
// honest attempts — the deadline routine is a backstop, not a single shot.
assert.ok(DEADLINE_PICK_COOLDOWN_SEC >= 10, 'cooldown actually meters the 1.5s tick');
assert.ok(
  (DRAIN_DEADLINE_SEC - HARD_DEADLINE_SEC) / DEADLINE_PICK_COOLDOWN_SEC >= 2,
  'pick window fits at least two attempts',
);

// ── introRenderBudgetSec ─────────────────────────────────────────────────────
// The drain verdict only decides "send"; the intro pre-render sits between the
// verdict and the next.txt write, and on a slow local TTS engine it can outlast
// the runway (#1409). The budget is what keeps music commitment off the speech
// critical path.

// Unknowable clock → unbounded, exactly today's behaviour. No seam is known to
// be at risk, so there is no basis for cutting a render short.
assert.equal(introRenderBudgetSec(null), null, 'unknown clock → unbounded render');

// Plenty of runway → render freely, minus the commit reserve.
assert.equal(introRenderBudgetSec(300), 300 - DRAIN_COMMIT_RESERVE_SEC, 'long runway → runway minus reserve');

// The boundary: a budget of exactly the minimum still renders.
assert.equal(
  introRenderBudgetSec(DRAIN_COMMIT_RESERVE_SEC + MIN_PRERENDER_BUDGET_SEC),
  MIN_PRERENDER_BUDGET_SEC,
  'exactly the minimum window still renders',
);
// One second under it → skip. A render that cannot finish only delays the music.
assert.equal(
  introRenderBudgetSec(DRAIN_COMMIT_RESERVE_SEC + MIN_PRERENDER_BUDGET_SEC - 1),
  0,
  'below the minimum window → skip the pre-render',
);

// The reserve itself is never spent on speech: at exactly the reserve, and
// anywhere below it, the answer is skip — including an expired clock, where the
// seam has already passed and the only useful act is committing the music.
assert.equal(introRenderBudgetSec(DRAIN_COMMIT_RESERVE_SEC), 0, 'no runway past the reserve → skip');
assert.equal(introRenderBudgetSec(5), 0, 'almost no runway → skip');
assert.equal(introRenderBudgetSec(0), 0, 'seam is now → skip');
assert.equal(introRenderBudgetSec(-30), 0, 'expired clock → skip, never a negative budget');

// A budget is never negative — the call site feeds it to setTimeout.
for (const r of [-100, -1, 0, 1, 11, 12, 17, 18, 60, 600]) {
  const b = introRenderBudgetSec(r);
  assert.ok(b != null && b >= 0, `budget for remaining=${r} is non-negative`);
}

// The hard-deadline drain is the emergency path — the pick did NOT land in time
// and Liquidsoap must have the track resolved before the crossfade. Whatever
// render window survives there must leave the commit reserve intact.
const atHardDeadline = introRenderBudgetSec(HARD_DEADLINE_SEC);
assert.ok(
  atHardDeadline != null && atHardDeadline <= HARD_DEADLINE_SEC - DRAIN_COMMIT_RESERVE_SEC,
  'a hard-deadline drain still reserves the commit tail',
);

// The reserve must cover the commit tail it is named for: two writeHandoff
// waits (5s each) plus slack. Shrinking it below that reintroduces #1409.
assert.ok(DRAIN_COMMIT_RESERVE_SEC >= 10, 'reserve covers both 5s handoff waits');

console.log('drain-policy: all assertions passed');
