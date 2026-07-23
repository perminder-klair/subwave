// Unit tests for the bed policy's pure helpers (broadcast/bed-policy.ts):
// rampBudgetMs (the three-state vocal read), bedWanted (threshold vs vocal
// onset), bedLengthFor (the bed/ramp arithmetic) and pickBed (pool selection).
// Run: `tsx scripts/bed-policy.test.ts`.
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import {
  rampBudgetMs,
  bedWanted,
  bedLengthFor,
  pickBed,
  BED_HEAD_SEC,
  BED_TAIL_SEC,
} from '../src/broadcast/bed-policy.js';

const OPTS = { thresholdSec: 12, crossSec: 6 };

// The constants ARE the contract: 2.5s of head is the latency budget (1.5s
// watcher tick + 0.5s intro.txt poll + slack) and every formula-shaped
// assertion below would still pass if they drifted — so pin the literals.
assert.equal(BED_HEAD_SEC, 2.5);
assert.equal(BED_TAIL_SEC, 2.0);

// ── rampBudgetMs — the three-state vocal read ────────────────────────────────

// Not computed (null) → unknown, so the caller falls back to the threshold.
assert.equal(rampBudgetMs({ vocalRanges: null }), null);

// Instrumental ([]) → nothing to trample, so the budget is unbounded.
assert.equal(rampBudgetMs({ vocalRanges: [] }), Infinity);

// Vocals measured → the earliest range's start IS the onset. Read off the
// ranges themselves, never intro_ms: a heavy-then-lean analysis history
// rewrites intro_ms from the energy heuristic while COALESCE keeps the old
// ranges, so the two columns can disagree — the ranges are the measurement.
assert.equal(rampBudgetMs({ vocalRanges: [{ startMs: 15_000 }] }), 15_000);

// Ranges aren't guaranteed sorted — the earliest wins.
assert.equal(rampBudgetMs({ vocalRanges: [{ startMs: 42_000 }, { startMs: 9_000 }] }), 9_000);

// Vocals from the first beat → zero budget (any script outlasts it → bed).
assert.equal(rampBudgetMs({ vocalRanges: [{ startMs: 0 }] }), 0);
assert.equal(bedWanted(3_000, 0, OPTS), true);

// A negative/garbage onset is nonsense — treat as unknown, don't propagate it.
assert.equal(rampBudgetMs({ vocalRanges: [{ startMs: -1 }] }), null);

// No track at all.
assert.equal(rampBudgetMs(null), null);

// ── bedWanted — known budget ─────────────────────────────────────────────────

// The DJ outlasts the intro → bed.
assert.equal(bedWanted(20_000, 15_000, OPTS), true);

// The DJ fits inside the intro → no bed, keep the craft move (talk over it).
assert.equal(bedWanted(9_000, 15_000, OPTS), false);

// Exactly the budget is not "outlasting" it.
assert.equal(bedWanted(15_000, 15_000, OPTS), false);

// Instrumental: an unbounded budget can never be outlasted, however long the
// script runs — this is the property that keeps beds off instrumentals.
assert.equal(bedWanted(120_000, Infinity, OPTS), false);

// A known budget wins over the threshold — a 20s script against a 25s intro
// gets no bed even though it's well past thresholdSec.
assert.equal(bedWanted(20_000, 25_000, OPTS), false);

// ── bedWanted — unknown budget falls back to the threshold ───────────────────

assert.equal(bedWanted(13_000, null, OPTS), true);
assert.equal(bedWanted(11_000, null, OPTS), false);
assert.equal(bedWanted(12_000, null, OPTS), false);   // boundary: not >

// A short link on a default install stays as it is today.
assert.equal(bedWanted(6_000, null, OPTS), false);

// thresholdSec: 0 beds everything with an unknown budget (the "always" dial).
assert.equal(bedWanted(1, null, { ...OPTS, thresholdSec: 0 }), true);

// ── bedWanted — degenerate input ─────────────────────────────────────────────

assert.equal(bedWanted(0, null, OPTS), false);
assert.equal(bedWanted(-5, null, OPTS), false);
assert.equal(bedWanted(NaN, null, OPTS), false);

// ── bedLengthFor — the arithmetic ────────────────────────────────────────────

{
  const { bedSec, crossSec } = bedLengthFor(20_000, OPTS);
  assert.equal(bedSec, 24.5);   // literal, not the formula — see the pins above
  assert.equal(crossSec, 6);

  // The load-bearing property: the next song's fade-in starts ~4s before the
  // DJ's clip ends, so the closing words ride over the incoming track.
  const rampStartsAt = bedSec - crossSec;      // 18.5
  const djEndsAt = BED_HEAD_SEC + 20;          // 22.5
  assert.equal(round2(djEndsAt - rampStartsAt), 4);
}

// The entry cross (the predecessor's exit canvas the bed fades in under) is
// dead time the bed carries on top: the marker and cue_out clock start at
// cross-FEED time, a full canvas before the bed is dominant.
{
  const { bedSec, crossSec } = bedLengthFor(20_000, OPTS, 10);
  assert.equal(bedSec, 34.5);   // 10 entry + 2.5 head + 20 voice + 2 tail
  assert.equal(crossSec, 6);
  // The DJ now lands at entry+head and still ends ~4s into the ramp.
  const djEndsAt = 10 + BED_HEAD_SEC + 20;     // 32.5
  assert.equal(round2(djEndsAt - (bedSec - crossSec)), 4);
}

// The 4s ramp holds at any script length — it's a property of the constants,
// not of the clip.
for (const voiceSec of [8, 15, 30, 45]) {
  const { bedSec, crossSec } = bedLengthFor(voiceSec * 1000, OPTS);
  const overlap = round2((BED_HEAD_SEC + voiceSec) - (bedSec - crossSec));
  assert.equal(overlap, 4, `ramp overlap drifted at voiceSec=${voiceSec}`);
}

// Clamp: the ramp can never start before the bed does, even on a script so
// short bedWanted would never pass it.
{
  const { bedSec, crossSec } = bedLengthFor(200, OPTS);
  assert.ok(crossSec <= bedSec - 1, 'cross must leave at least 1s of bed');
  assert.ok(crossSec > 0);
}

// A crossSec of 0 is honoured (hard cut into the next song, no ramp).
assert.equal(bedLengthFor(20_000, { ...OPTS, crossSec: 0 }).crossSec, 0);

// ── pickBed ──────────────────────────────────────────────────────────────────

const BEDS = [
  { name: 'short', durationSec: 10 },
  { name: 'warm-pad', durationSec: 90 },
  { name: 'drone', durationSec: 60 },
  { name: 'unmeasured', durationSec: null },
];

// Too-short and unmeasured beds are both excluded — a bed that runs out
// mid-link drops the DJ into silence.
{
  const picked = pickBed(BEDS, 24.5, null, 0);
  assert.ok(picked && ['warm-pad', 'drone'].includes(picked.name));
}

// Anti-repeat: with two candidates, the last-used one is skipped.
assert.equal(pickBed(BEDS, 24.5, 'warm-pad', 0)!.name, 'drone');
assert.equal(pickBed(BEDS, 24.5, 'drone', 0)!.name, 'warm-pad');

// ...but never at the cost of airing no bed: one candidate, already used → reuse.
assert.equal(pickBed([{ name: 'only', durationSec: 60 }], 24.5, 'only', 0)!.name, 'only');

// The roll spreads across the pool and never runs off the end at roll = 1.
{
  const names = [0, 0.5, 0.99, 1].map(r => pickBed(BEDS, 24.5, null, r)!.name);
  assert.ok(names.every(n => ['warm-pad', 'drone'].includes(n)));
  assert.equal(new Set(names).size, 2, 'roll should reach both candidates');
}

// Nothing long enough → no bed, caller falls back to today's behaviour.
assert.equal(pickBed(BEDS, 120, null, 0), null);
assert.equal(pickBed([], 10, null, 0), null);

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

console.log('bed-policy: all assertions passed');
