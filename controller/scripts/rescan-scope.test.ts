// Unit tests for planRun — the pure phase-gating decision behind the re-scan
// scoping fix (option B: "Re-scan redoes already-done work, never forward-
// processes the untagged remainder"). Run: `tsx scripts/rescan-scope.test.ts`
// (folded into `npm run test`). node:assert-via-tsx style, matching the sibling
// pure-helper tests.
//
// The load-bearing invariant: in EVERY re-scan combination, forwardTag is false
// (no seed/propagate/active-learn over untagged tracks), and each pass fires iff
// its own re-* flag is set. A normal run keeps the legacy skip-flag gating.

import assert from 'node:assert/strict';
import { planRun } from '../src/music/rescan-scope.js';

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

// Defaults for the fields a given case doesn't care about.
function flags(over: Partial<Parameters<typeof planRun>[0]> = {}) {
  return {
    rescan: false,
    reseed: false, reEnrich: false, reAnalyze: false, upgrade: false,
    skipEnrich: false, skipTag: false, skipAnalyze: false,
    ...over,
  };
}

console.log('planRun — normal (forward) runs keep the legacy skip-flag gating:');

test('a plain run does the full forward pass, no re-* passes', () => {
  assert.deepEqual(planRun(flags()), {
    enrich: true, forwardTag: true, reEmbed: false, reDecide: false, analyze: true,
  });
});
test('--skip-tag drops forward tagging but keeps enrich + analyze', () => {
  assert.deepEqual(planRun(flags({ skipTag: true })), {
    enrich: true, forwardTag: false, reEmbed: false, reDecide: false, analyze: true,
  });
});
test('--skip-enrich / --skip-analyze gate just their own phase', () => {
  assert.deepEqual(planRun(flags({ skipEnrich: true })), {
    enrich: false, forwardTag: true, reEmbed: false, reDecide: false, analyze: true,
  });
  assert.deepEqual(planRun(flags({ skipAnalyze: true })), {
    enrich: true, forwardTag: true, reEmbed: false, reDecide: false, analyze: false,
  });
});
test('re-* flags WITHOUT --rescan (raw CLI) do NOT suppress forward discovery', () => {
  // The legacy meaning: `npm run tag -- --re-analyze` is a forward pass that also
  // re-analyses. Only the admin Re-scan tab (which adds --rescan) scopes things.
  assert.deepEqual(planRun(flags({ reAnalyze: true })), {
    enrich: true, forwardTag: true, reEmbed: false, reDecide: false, analyze: true,
  });
});

console.log('planRun — re-scans fire ONLY the selected passes, never forward discovery:');

test('re-scan ALWAYS suppresses forward discovery (the core invariant)', () => {
  const combos = [
    { reseed: true }, { reEnrich: true }, { reAnalyze: true }, { upgrade: true },
    { reseed: true, reEnrich: true, reAnalyze: true, upgrade: true },
  ];
  for (const c of combos) {
    assert.equal(planRun(flags({ rescan: true, ...c })).forwardTag, false,
      `forwardTag must be false for re-scan combo ${JSON.stringify(c)}`);
  }
});
test('re-scan: each pass fires iff its own flag is set', () => {
  assert.deepEqual(planRun(flags({ rescan: true, reEnrich: true })), {
    enrich: true, forwardTag: false, reEmbed: false, reDecide: false, analyze: false,
  });
  assert.deepEqual(planRun(flags({ rescan: true, reseed: true })), {
    enrich: false, forwardTag: false, reEmbed: true, reDecide: false, analyze: false,
  });
  assert.deepEqual(planRun(flags({ rescan: true, upgrade: true })), {
    enrich: false, forwardTag: false, reEmbed: false, reDecide: true, analyze: false,
  });
  assert.deepEqual(planRun(flags({ rescan: true, reAnalyze: true })), {
    enrich: false, forwardTag: false, reEmbed: false, reDecide: false, analyze: true,
  });
});
test('full re-scan runs every pass but still no forward discovery', () => {
  assert.deepEqual(
    planRun(flags({ rescan: true, reseed: true, reEnrich: true, reAnalyze: true, upgrade: true })),
    { enrich: true, forwardTag: false, reEmbed: true, reDecide: true, analyze: true },
  );
});
test('re-scan ignores forward skip-flags (they belong to the Run tab)', () => {
  // Even if skip-flags leaked in, a re-scan is driven purely by the re-* flags.
  assert.deepEqual(planRun(flags({ rescan: true, reAnalyze: true, skipAnalyze: true, skipEnrich: true })), {
    enrich: false, forwardTag: false, reEmbed: false, reDecide: false, analyze: true,
  });
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall rescan-scope tests passed');
