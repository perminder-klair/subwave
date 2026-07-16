// Unit tests for the programme arc's pure helpers (broadcast/programme-pure.ts):
// showSpan (position of an hour inside a show's consecutive schedule run —
// drives which hour gets which feature and when the outro fires) and
// planFeature (per-hour feature lookup with last-feature reuse).
// Run: `tsx scripts/programme.test.ts`.
//
// node:assert-via-tsx style, matching scripts/auto-pool.test.ts.

import assert from 'node:assert/strict';
import { showSpan, overrideSpan, planFeature, beatWindow } from '../src/broadcast/programme-pure.js';

// A 7×24 grid with every slot null.
function emptyWeek(): Record<number, (string | null)[]> {
  const week: Record<number, (string | null)[]> = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill(null);
  return week;
}

// ── showSpan ─────────────────────────────────────────────────────────────────

// Single-hour show: the hour is its own span.
{
  const week = emptyWeek();
  week[1]![9] = 's_a';
  assert.deepEqual(showSpan(week, 1, 9), { index: 0, total: 1 }, 'single scheduled hour');
}

// Multi-hour block: 07:00–09:59 → three hours, indexed from the top.
{
  const week = emptyWeek();
  week[1]![7] = 's_a'; week[1]![8] = 's_a'; week[1]![9] = 's_a';
  assert.deepEqual(showSpan(week, 1, 7), { index: 0, total: 3 }, 'first hour of a 3h block');
  assert.deepEqual(showSpan(week, 1, 8), { index: 1, total: 3 }, 'middle hour');
  assert.deepEqual(showSpan(week, 1, 9), { index: 2, total: 3 }, 'final hour');
}

// A different show adjacent to the block does NOT extend the span.
{
  const week = emptyWeek();
  week[1]![7] = 's_b'; week[1]![8] = 's_a'; week[1]![9] = 's_a'; week[1]![10] = 's_c';
  assert.deepEqual(showSpan(week, 1, 8), { index: 0, total: 2 }, 'neighbouring shows are not part of the run');
}

// Midnight crossing: Sunday 23:00 → Monday 01:59 is one 3-hour run.
{
  const week = emptyWeek();
  week[0]![23] = 's_a'; week[1]![0] = 's_a'; week[1]![1] = 's_a';
  assert.deepEqual(showSpan(week, 0, 23), { index: 0, total: 3 }, 'run starts before midnight');
  assert.deepEqual(showSpan(week, 1, 0), { index: 1, total: 3 }, 'second hour, past midnight');
  assert.deepEqual(showSpan(week, 1, 1), { index: 2, total: 3 }, 'final hour, past midnight');
}

// Week seam: Saturday 23:00 → Sunday 00:00 wraps day 6 → day 0.
{
  const week = emptyWeek();
  week[6]![23] = 's_a'; week[0]![0] = 's_a';
  assert.deepEqual(showSpan(week, 6, 23), { index: 0, total: 2 }, 'run crosses the week seam');
  assert.deepEqual(showSpan(week, 0, 0), { index: 1, total: 2 }, 'second hour on the far side of the seam');
}

// Empty slot: no show scheduled → a degenerate 1-hour span (callers gate on
// the show's existence before ever using this).
{
  assert.deepEqual(showSpan(emptyWeek(), 3, 12), { index: 0, total: 1 }, 'empty slot degenerates safely');
}

// Wall-to-wall grid (one show painted on all 168 slots) terminates and reports
// a full-week run — the loop caps, no hang.
{
  const week = emptyWeek();
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) week[d]![h] = 's_a';
  const span = showSpan(week, 3, 12);
  assert.equal(span.total, 7 * 24, 'wall-to-wall run spans the whole week');
  assert.ok(span.index >= 0 && span.index < span.total, 'index stays inside the run');
}

// Malformed schedule shapes degrade instead of throwing.
{
  assert.deepEqual(showSpan(null, 0, 0), { index: 0, total: 1 }, 'null schedule');
  assert.deepEqual(showSpan({}, 2, 5), { index: 0, total: 1 }, 'missing day');
}

// ── planFeature ──────────────────────────────────────────────────────────────

// One feature per hour, straight lookup.
{
  const plan = { features: [{ topic: 'headlines', kind: 'news' }, { topic: 'deep cut', kind: null }] };
  assert.deepEqual(planFeature(plan, 0), { topic: 'headlines', kind: 'news' }, 'hour 0 gets feature 0');
  assert.deepEqual(planFeature(plan, 1), { topic: 'deep cut', kind: null }, 'hour 1 gets feature 1');
}

// A short plan reuses its LAST feature for tail hours instead of going silent.
{
  const plan = { features: [{ topic: 'only one', kind: null }] };
  assert.deepEqual(planFeature(plan, 3), { topic: 'only one', kind: null }, 'tail hours reuse the last feature');
}

// Negative / missing input degrades to null (fallback path airs the raw brief).
{
  assert.equal(planFeature(null, 0), null, 'no plan');
  assert.equal(planFeature({ features: [] }, 0), null, 'empty features');
  assert.equal(planFeature({ features: [{ kind: 'news' }] }, 0), null, 'feature without a topic is unusable');
  assert.deepEqual(planFeature({ features: [{ topic: 't' }] }, -2), { topic: 't', kind: null }, 'negative index clamps to the first feature');
}

// ── beatWindow ───────────────────────────────────────────────────────────────

// Station-minute windows: feature :35–:39, outro :55–:59, silence elsewhere.
{
  assert.equal(beatWindow(34), null, ':34 is quiet');
  assert.equal(beatWindow(35), 'feature', ':35 opens the feature window');
  assert.equal(beatWindow(39), 'feature', ':39 still feature');
  assert.equal(beatWindow(40), null, ':40 is quiet again');
  assert.equal(beatWindow(54), null, ':54 is quiet');
  assert.equal(beatWindow(55), 'outro', ':55 opens the outro window');
  assert.equal(beatWindow(59), 'outro', ':59 still outro');
  assert.equal(beatWindow(0), null, 'top of the hour belongs to the hourly/intro');
}

// Every 15-minute zone offset lands a */5 process cron inside each window
// exactly once — the invariant that lets one 5-min tick serve IST/Nepal/etc.
{
  for (let offset = 0; offset < 60; offset += 15) {
    for (const [start, kind] of [[35, 'feature'], [55, 'outro']] as const) {
      const hits = [];
      for (let p = 0; p < 60; p += 5) {
        const stationMin = (p + offset) % 60;
        const w = beatWindow(stationMin);
        if (w === kind && stationMin >= start && stationMin < start + 5) hits.push(p);
      }
      assert.equal(hits.length, 1, `offset ${offset}: exactly one */5 tick lands in the ${kind} window`);
    }
  }
}

// ── overrideSpan ─────────────────────────────────────────────────────────────
// A timed takeover's window IS the episode: total = whole hours (rounded up),
// index = hours elapsed since the pin, clamped inside the window.
{
  const HOUR = 3_600_000;
  const t0 = 1_752_000_000_000;
  const oneHour = { startedAt: t0, expiresAt: t0 + HOUR };
  assert.deepEqual(overrideSpan(oneHour, t0), { index: 0, total: 1 }, '1h pin, at the start');
  assert.deepEqual(overrideSpan(oneHour, t0 + HOUR - 1), { index: 0, total: 1 }, '1h pin, final minute');

  const threeHours = { startedAt: t0, expiresAt: t0 + 3 * HOUR };
  assert.deepEqual(overrideSpan(threeHours, t0 + HOUR / 2), { index: 0, total: 3 }, '3h pin, first hour');
  assert.deepEqual(overrideSpan(threeHours, t0 + HOUR), { index: 1, total: 3 }, '3h pin, second hour');
  assert.deepEqual(overrideSpan(threeHours, t0 + 3 * HOUR - 1), { index: 2, total: 3 }, '3h pin, final hour');

  const ninetyMin = { startedAt: t0, expiresAt: t0 + 1.5 * HOUR };
  assert.deepEqual(overrideSpan(ninetyMin, t0), { index: 0, total: 2 }, 'partial hours round the total up');
  assert.deepEqual(overrideSpan(ninetyMin, t0 + 1.4 * HOUR), { index: 1, total: 2 }, '90min pin, past the hour mark');

  // Ticks fractionally outside the window clamp instead of indexing off the end.
  assert.deepEqual(overrideSpan(oneHour, t0 + HOUR + 1), { index: 0, total: 1 }, 'just past expiry clamps');
  assert.deepEqual(overrideSpan(oneHour, t0 - 1), { index: 0, total: 1 }, 'just before start clamps');
}

console.log('programme.test.ts: all assertions passed');
