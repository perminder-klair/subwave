// What a stem budget would delete, as the operator types it.
// The hourly sweep evicts until the cache fits the budget, so a budget under
// the measured size deletes about the difference; the per-track figure is the
// cache's own measured average. GB here is the controller's unit (1024³ B,
// `stem-cache.ts` budgetBytes).
//
// Run: npm test -- stem-budget

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stemBudgetImpact, fmtGb, usageCaveat, pickTimeOvershoot } from './stem-budget';

const GB = 1024 ** 3;
const usage = { bytes: 778 * GB, dirs: 76_000, estTrackBytes: Math.round((778 * GB) / 76_000) };

test('a budget at or above the cache deletes nothing', () => {
  assert.equal(stemBudgetImpact(usage, 778), null);
  assert.equal(stemBudgetImpact(usage, 900), null);
});

test('a budget under the cache deletes the difference, in tracks too', () => {
  const r = stemBudgetImpact(usage, 15);
  assert.ok(r);
  assert.equal(r.deleteBytes, 763 * GB);
  // 763/778 of 76,000 dirs
  assert.ok(Math.abs(r.deleteTracks - Math.round((763 / 778) * 76_000)) <= 1, String(r.deleteTracks));
  assert.equal(r.keepTracks, 76_000 - r.deleteTracks);
});

test('the track count never exceeds what is cached', () => {
  const r = stemBudgetImpact({ bytes: 10 * GB, dirs: 3, estTrackBytes: 1 }, 1);
  assert.equal(r?.deleteTracks, 3);
  assert.equal(r?.keepTracks, 0);
});

test('nothing measured, or an unparseable budget, says nothing', () => {
  assert.equal(stemBudgetImpact(null, 15), null);
  assert.equal(stemBudgetImpact(usage, Number.NaN), null);
  assert.equal(stemBudgetImpact(usage, 0), null);
});

test('GB display', () => {
  assert.equal(fmtGb(778 * GB), '778 GB');
  assert.equal(fmtGb(1.25 * GB), '1.3 GB');
  assert.equal(fmtGb(0.2 * GB), '0.2 GB');
  assert.equal(fmtGb(12_345 * GB), '12,345 GB');
});

test('a figure an orphan pass left stale still drives the cut: the confirm must not vanish', () => {
  const usage = { bytes: 80 * GB, dirs: 4000, estTrackBytes: 20 * 1024 ** 2, fresh: false, stale: true };
  const impact = stemBudgetImpact(usage, 50);
  assert.ok(impact, 'a lowered budget still has something to confirm');
  assert.equal(impact.deleteBytes, 30 * GB);
});

test('the measured note names why a figure is not current, and only then', () => {
  assert.equal(usageCaveat({ bytes: 1, dirs: 1, estTrackBytes: 1, fresh: true }), '');
  assert.equal(usageCaveat({ bytes: 1, dirs: 1, estTrackBytes: 1, fresh: false, passRunning: true }), ', analysis pass adding more');
  assert.equal(usageCaveat({ bytes: 1, dirs: 1, estTrackBytes: 1, fresh: false, stale: true }), ', a cleanup pass has run since');
  assert.equal(usageCaveat({ bytes: 1, dirs: 1, estTrackBytes: 1, fresh: false }), ', over a day old');
});

test('pick-time stems: a cache over its unchanged budget by no more than the designed overshoot is not a fault', () => {
  const MB = 1024 ** 2;
  const usageAt = (bytes: number) => ({ bytes, dirs: 1000, estTrackBytes: 15 * MB });
  const resp = (bytes: number, extra: object = {}) => ({
    usage: usageAt(bytes), budgetBytes: 15 * GB, pickTimeOvershootBytes: 315 * MB, ...extra,
  });
  assert.equal(pickTimeOvershoot(resp(15 * GB + 200 * MB), 15), 200 * MB, 'between sweeps: say so, no warning');
  assert.equal(pickTimeOvershoot(resp(15 * GB + 315 * MB), 15), 315 * MB, 'at the edge of the design');
  assert.equal(pickTimeOvershoot(resp(15 * GB + 316 * MB), 15), null, 'past it: the warning stands');
  assert.equal(pickTimeOvershoot(resp(15 * GB), 15), null, 'not over at all');
  assert.equal(pickTimeOvershoot(resp(15 * GB + 200 * MB), 14), null, 'a lowered budget deletes stems: the warning stands');
  assert.equal(pickTimeOvershoot(resp(15 * GB + 200 * MB, { pickTimeOvershootBytes: undefined }), 15), null,
    'the feature off: the controller sends no overshoot, so nothing changes');
  assert.equal(pickTimeOvershoot({ usage: null, budgetBytes: 15 * GB, pickTimeOvershootBytes: 315 * MB }, 15), null);
  assert.equal(pickTimeOvershoot(null, 15), null);
});
