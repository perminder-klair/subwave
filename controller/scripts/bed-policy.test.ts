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

const OPTS = { thresholdSec: 12, crossSec: 6, tailSec: 3 };

// The constants ARE the contract: 2.5s of head is the latency budget (1.5s
// watcher tick + 0.5s intro.txt poll + slack) and every formula-shaped
// assertion below would still pass if they drifted — so pin the literals.
assert.equal(BED_HEAD_SEC, 2.5);
assert.equal(BED_TAIL_SEC, 3.0);

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

// ── bedWanted — the 'request' reason ─────────────────────────────────────────
//
// A listener request beds because of what the track IS, not how long the DJ
// talks: its opening bars belong to whoever asked for it (#1465). So every
// input that suppresses a LINK's bed must NOT suppress a request's.

// A six-word shout-out beds, where the identical link would not.
assert.equal(bedWanted(3_000, null, OPTS, 'link'), false);
assert.equal(bedWanted(3_000, null, OPTS, 'request'), true);

// The measured ramp budget gets no vote — a request over a track whose vocals
// start at 0:25 still beds, though the DJ fits inside the intro twice over.
assert.equal(bedWanted(9_000, 25_000, OPTS, 'request'), true);

// Not even an instrumental's unbounded budget, which is the one case that
// short-circuits every other bedWanted path.
assert.equal(bedWanted(9_000, Infinity, OPTS, 'request'), true);

// The threshold is equally irrelevant, in both directions.
assert.equal(bedWanted(1, null, { ...OPTS, thresholdSec: 60 }, 'request'), true);

// Omitting the reason means 'link' — the pre-#1465 behaviour, so an unconverted
// call site can't silently start bedding everything.
assert.equal(bedWanted(3_000, null, OPTS), bedWanted(3_000, null, OPTS, 'link'));

// ── bedWanted — degenerate input ─────────────────────────────────────────────

assert.equal(bedWanted(0, null, OPTS), false);
assert.equal(bedWanted(-5, null, OPTS), false);
assert.equal(bedWanted(NaN, null, OPTS), false);

// A request is not exempt from the zero-length guard: there is nothing to bed
// under a clip that doesn't exist, and a 0s bed would be dead air.
assert.equal(bedWanted(0, null, OPTS, 'request'), false);
assert.equal(bedWanted(NaN, null, OPTS, 'request'), false);

// ── bedLengthFor — the arithmetic ────────────────────────────────────────────

// The quiet an operator actually hears: from the DJ's last word to the moment
// the next song starts fading in. Every assertion in this section is about this
// number, because it is the one the setting names (#1485 FR 5c) — before the
// fix it was a residual of tail minus cross and ran NEGATIVE at the defaults.
function tailGap(voiceSec: number, opts: typeof OPTS, entryCrossSec = 0): number {
  const { bedSec, crossSec } = bedLengthFor(voiceSec * 1000, opts, entryCrossSec);
  const rampStartsAt = bedSec - crossSec;
  const djEndsAt = entryCrossSec + BED_HEAD_SEC + voiceSec;
  return round2(rampStartsAt - djEndsAt);
}

{
  const { bedSec, crossSec } = bedLengthFor(20_000, OPTS);
  assert.equal(bedSec, 31.5);   // literal, not the formula — see the pins above
  assert.equal(crossSec, 6);

  // The load-bearing property: the bed plays ALONE for tailSec after the DJ
  // stops, and only then does the next song start fading in.
  assert.equal(tailGap(20, OPTS), 3);
}

// The entry cross (the predecessor's exit canvas the bed fades in under) is
// dead time the bed carries on top: the marker and cue_out clock start at
// cross-FEED time, a full canvas before the bed is dominant.
{
  const { bedSec, crossSec } = bedLengthFor(20_000, OPTS, 10);
  // 10 entry + 2.5 head + 20 voice + 3 tail + 6 cross
  assert.equal(bedSec, 41.5);
  assert.equal(crossSec, 6);
  assert.equal(tailGap(20, OPTS, 10), 3);
}

// The gap is a property of tailSec ALONE — not of the clip, the entry cross or
// the ramp. That independence is the fix: it is what makes the setting mean the
// same thing on a hard-cut station and on a 15s-ramp one, and it is what fails
// the moment someone takes the cross back out of the sum.
for (const voiceSec of [8, 15, 30, 45]) {
  for (const entry of [0, 6, 12]) {
    for (const crossSec of [0, 2, 6, 15]) {
      assert.equal(
        tailGap(voiceSec, { ...OPTS, crossSec }, entry), 3,
        `tail gap drifted at voiceSec=${voiceSec} entry=${entry} cross=${crossSec}`,
      );
    }
  }
}

// tailSec is honoured across its whole range, 0 included: a 0 puts the ramp on
// the DJ's last syllable. That is the HARD end of this setting, not the old
// behaviour — the pre-#1485 overlap talked over the incoming song and is
// deliberately unreachable now (bed-policy's header says why).
for (const tailSec of [0, 1.5, 3, 15]) {
  assert.equal(tailGap(20, { ...OPTS, tailSec }), tailSec, `tailSec=${tailSec} not honoured`);
}

// A cold-loaded pre-#1485 settings file has no tailSec at all. bed-policy
// coerces rather than producing NaN — the normaliser fills the key on the real
// path, but BedOpts is also built by hand here and at a couple of call sites.
{
  const noTail = { thresholdSec: 12, crossSec: 6 } as typeof OPTS;
  assert.equal(bedLengthFor(20_000, noTail).bedSec, 31.5);
  assert.equal(tailGap(20, noTail), BED_TAIL_SEC);
}

// Garbage in the same key takes the same route (never NaN into cue_out), and a
// negative tail is floored at 0 rather than eating into the voice.
for (const bad of [NaN, Infinity, undefined, null, 'x']) {
  const opts = { ...OPTS, tailSec: bad } as unknown as typeof OPTS;
  assert.equal(bedLengthFor(20_000, opts).bedSec, 31.5, `tailSec=${String(bad)} did not coerce`);
}
assert.equal(tailGap(20, { ...OPTS, tailSec: -5 }), 0);

// Clamp: the ramp can never start before the bed does, even on a script so
// short bedWanted would never pass it. Structurally unreachable since the cross
// joined the sum — kept as arithmetic insurance, so pin that it stays inert.
{
  const { bedSec, crossSec } = bedLengthFor(200, OPTS);
  assert.ok(crossSec <= bedSec - 1, 'cross must leave at least 1s of bed');
  assert.equal(crossSec, OPTS.crossSec, 'clamp bit a case it should no longer reach');
}

// A crossSec of 0 is honoured (hard cut into the next song, no ramp) and the
// bed is sized down with it — the tail is still there.
{
  const { bedSec, crossSec } = bedLengthFor(20_000, { ...OPTS, crossSec: 0 });
  assert.equal(crossSec, 0);
  assert.equal(bedSec, 25.5);   // 2.5 head + 20 voice + 3 tail + 0 cross
}

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
