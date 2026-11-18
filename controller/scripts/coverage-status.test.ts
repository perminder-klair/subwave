// Unit tests for dimensionStatus / isBackfillable — the pure per-dimension
// coverage-status decision behind the /admin/library sounds-like + vocal rows.
// Run: `npm test -- coverage-status` (folded into `npm run test`).
//
// The load-bearing invariant: every legacy panel string maps to exactly one enum
// case, and capability facts (pending-heavy / incapable) surface even when the
// dimension is disabled so a lean-engine row can read "off · needs the heavy
// analyzer" (the panel pairs the enum with the enable prop for wording).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dimensionStatus,
  isBackfillable,
  type DimensionInputs,
  type DimensionStatus,
} from '../src/music/coverage-status.js';

// A capable, reachable, enabled engine with nothing covered — the baseline each
// case tweaks.
function inputs(over: Partial<DimensionInputs> = {}): DimensionInputs {
  return {
    enabled: true,
    analysisAvailable: true,
    capable: true,
    analysed: 0,
    count: 0,
    percent: null,
    ...over,
  };
}

test('disabled + capable engine, nothing covered → off', () => {
  assert.equal(dimensionStatus(inputs({ enabled: false })), 'off');
});
test('disabled but engine is lean (capable=false) → pending-heavy (row shows "off · needs the heavy analyzer")', () => {
  assert.equal(dimensionStatus(inputs({ enabled: false, capable: false })), 'pending-heavy');
});
test('disabled + starved (unknown capability, bpm/key ran, zero here) → incapable, still surfaced', () => {
  assert.equal(
    dimensionStatus(inputs({ enabled: false, capable: null, analysed: 500, count: 0 })),
    'incapable',
  );
});
test('disabled but coverage exists (paused-with-data) → keeps showing partial/complete', () => {
  assert.equal(dimensionStatus(inputs({ enabled: false, count: 10, percent: 40 })), 'partial');
  assert.equal(dimensionStatus(inputs({ enabled: false, count: 10, percent: 100 })), 'complete');
});
test('disabled + engine down → off (pending-engine is gated on enable)', () => {
  assert.equal(dimensionStatus(inputs({ enabled: false, analysisAvailable: false })), 'off');
});

test('enabled but no backend reachable → pending-engine', () => {
  assert.equal(dimensionStatus(inputs({ analysisAvailable: false })), 'pending-engine');
});
test('enabled, engine up, lean image (capable=false) → pending-heavy', () => {
  assert.equal(dimensionStatus(inputs({ capable: false })), 'pending-heavy');
});
test('pending-heavy wins even with existing coverage (engine downgraded to lean)', () => {
  assert.equal(dimensionStatus(inputs({ capable: false, count: 5, percent: 20 })), 'pending-heavy');
});
test('capable=false WITH a load error → load-failed, not pending-heavy', () => {
  // The image HAS the model and it didn't load. Same `capable: false` as a lean
  // build, opposite advice — telling someone already on the heavy image to
  // switch to the heavy image is what left #1300 bug 3 unexplained.
  assert.equal(
    dimensionStatus(inputs({ capable: false, loadError: 'weights download failed' })),
    'load-failed',
  );
});
test('load-failed wins over existing coverage too', () => {
  // Same reasoning as pending-heavy above: a dimension that can no longer
  // progress says so, even with numbers already on the meter.
  assert.equal(
    dimensionStatus(inputs({ capable: false, loadError: 'boom', count: 5, percent: 20 })),
    'load-failed',
  );
});
test('a load error on a CAPABLE backend changes nothing', () => {
  // Defensive: the error only means anything alongside capable === false.
  assert.equal(dimensionStatus(inputs({ capable: true, loadError: 'stale' })), 'ready');
});
test('still probing (analysisAvailable=null) does NOT jump to pending-engine', () => {
  assert.equal(dimensionStatus(inputs({ analysisAvailable: null })), 'ready');
});

test('enabled, unknown capability, bpm/key ran, zero here → incapable (starved)', () => {
  assert.equal(dimensionStatus(inputs({ capable: null, analysed: 500, count: 0 })), 'incapable');
});
test('enabled, unknown capability, nothing analysed yet → ready (not starved)', () => {
  assert.equal(dimensionStatus(inputs({ capable: null, analysed: 0, count: 0 })), 'ready');
});

test('enabled + capable, nothing yet → ready', () => {
  assert.equal(dimensionStatus(inputs()), 'ready');
});
test('some coverage < 100% → partial', () => {
  assert.equal(dimensionStatus(inputs({ count: 30, percent: 60 })), 'partial');
});
test('coverage at 100% → complete', () => {
  assert.equal(dimensionStatus(inputs({ count: 100, percent: 100 })), 'complete');
});
test('count>0 but percent unknown (total not scanned yet) → partial, not complete', () => {
  assert.equal(dimensionStatus(inputs({ count: 5, percent: null })), 'partial');
});

test('backfillable for ready / partial / incapable / off (off = just-enabled, pre-poll)', () => {
  const yes: DimensionStatus[] = ['ready', 'partial', 'incapable', 'off'];
  for (const s of yes) assert.equal(isBackfillable(s), true, `${s} should be backfillable`);
});
test('NOT backfillable for pending-heavy / load-failed / pending-engine / complete', () => {
  // load-failed joins them: the run would analyse every track for a guaranteed
  // no-op, which is the churn the whole fix exists to stop.
  const no: DimensionStatus[] = ['pending-heavy', 'load-failed', 'pending-engine', 'complete'];
  for (const s of no) assert.equal(isBackfillable(s), false, `${s} should not be backfillable`);
});
