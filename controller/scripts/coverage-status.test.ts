// Unit tests for dimensionStatus / isBackfillable — the pure per-dimension
// coverage-status decision behind the /admin/library sounds-like + vocal rows.
// Run: `tsx scripts/coverage-status.test.ts` (folded into `npm run test`).
// node:assert-via-tsx style, matching the sibling pure-helper tests.
//
// The load-bearing invariant: every legacy panel string maps to exactly one enum
// case, and capability facts (pending-heavy / incapable) surface even when the
// dimension is disabled so a lean-engine row can read "off · needs the heavy
// analyzer" (the panel pairs the enum with the enable prop for wording).

import assert from 'node:assert/strict';
import {
  dimensionStatus,
  isBackfillable,
  type DimensionInputs,
  type DimensionStatus,
} from '../src/music/coverage-status.js';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

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

console.log('dimensionStatus — off / disabled:');

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

console.log('dimensionStatus — enabled, engine problems:');

test('enabled but no backend reachable → pending-engine', () => {
  assert.equal(dimensionStatus(inputs({ analysisAvailable: false })), 'pending-engine');
});
test('enabled, engine up, lean image (capable=false) → pending-heavy', () => {
  assert.equal(dimensionStatus(inputs({ capable: false })), 'pending-heavy');
});
test('pending-heavy wins even with existing coverage (engine downgraded to lean)', () => {
  assert.equal(dimensionStatus(inputs({ capable: false, count: 5, percent: 20 })), 'pending-heavy');
});
test('still probing (analysisAvailable=null) does NOT jump to pending-engine', () => {
  assert.equal(dimensionStatus(inputs({ analysisAvailable: null })), 'ready');
});

console.log('dimensionStatus — enabled, capability unknown / starved:');

test('enabled, unknown capability, bpm/key ran, zero here → incapable (starved)', () => {
  assert.equal(dimensionStatus(inputs({ capable: null, analysed: 500, count: 0 })), 'incapable');
});
test('enabled, unknown capability, nothing analysed yet → ready (not starved)', () => {
  assert.equal(dimensionStatus(inputs({ capable: null, analysed: 0, count: 0 })), 'ready');
});

console.log('dimensionStatus — enabled + capable, coverage progression:');

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

console.log('isBackfillable — action gate (panel ANDs with the optimistic enable):');

test('backfillable for ready / partial / incapable / off (off = just-enabled, pre-poll)', () => {
  const yes: DimensionStatus[] = ['ready', 'partial', 'incapable', 'off'];
  for (const s of yes) assert.equal(isBackfillable(s), true, `${s} should be backfillable`);
});
test('NOT backfillable for pending-heavy / pending-engine / complete', () => {
  const no: DimensionStatus[] = ['pending-heavy', 'pending-engine', 'complete'];
  for (const s of no) assert.equal(isBackfillable(s), false, `${s} should not be backfillable`);
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall coverage-status tests passed');
