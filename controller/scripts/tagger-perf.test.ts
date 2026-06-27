// Unit tests for the library tagger's performance helpers:
//   - mapPool / memoizeByKey (src/util/async-pool.ts) — the bounded-concurrency
//     pool + per-artist promise dedup behind Phase-0 enrichment.
//   - sortedPhaseTimings / formatPhaseBreakdown (src/music/tagger-progress.ts) —
//     the per-phase breakdown shown in the CLI + admin panel.
// These are the testable cores extracted from tag-library.ts (which can't be
// imported directly — it runs main() on import). Pinned so the enrichment
// parallelism (each item once, cap honoured, one call per artist) and the
// breakdown shape can't silently regress.
// Run: `tsx scripts/tagger-perf.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mapPool, memoizeByKey } from '../src/util/async-pool.js';
import { sortedPhaseTimings, formatPhaseBreakdown } from '../src/music/tagger-progress.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main() {
  console.log('mapPool (bounded-concurrency drain):');

  await test('processes every item exactly once, results in INPUT order', async () => {
    const seen: number[] = [];
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (x) => { seen.push(x); return x * 10; });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);          // input order, not completion order
    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]); // each once
  });

  await test('never exceeds the concurrency cap, and reaches it', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    assert.equal(peak, 3); // 12 items / cap 3 → cap is both the ceiling and reached
  });

  await test('caps at item count when concurrency exceeds it', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3], 10, async (x) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      return x;
    });
    assert.deepEqual(out, [1, 2, 3]);
    assert.equal(peak, 3); // only 3 items, so never more than 3 in flight
  });

  await test('empty input resolves to []', async () => {
    assert.deepEqual(await mapPool([], 6, async (x) => x), []);
  });

  await test('non-positive / NaN concurrency degrades to serial (1)', async () => {
    let inFlight = 0;
    let peak = 0;
    const run = (c: number) => mapPool([1, 2, 3], c, async (x) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(3);
      inFlight--;
      return x;
    });
    assert.deepEqual(await run(0), [1, 2, 3]);
    peak = 0;
    assert.deepEqual(await run(NaN), [1, 2, 3]);
    assert.equal(peak, 1);
  });

  await test('a throwing worker rejects the whole pool', async () => {
    await assert.rejects(
      () => mapPool([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error('boom'); return x; }),
      /boom/,
    );
  });

  console.log('memoizeByKey (in-flight promise dedup):');

  await test('calls the underlying fn once per distinct key under concurrency', async () => {
    let calls = 0;
    const memo = memoizeByKey<string>(async (k) => { calls++; await sleep(5); return `v:${k}`; });
    const results = await Promise.all([memo('a'), memo('a'), memo('b'), memo('a'), memo('b')]);
    assert.deepEqual(results, ['v:a', 'v:a', 'v:b', 'v:a', 'v:b']);
    assert.equal(calls, 2); // 'a' and 'b' — NOT 5
  });

  await test('returns the same promise instance for a repeated key', () => {
    const memo = memoizeByKey<number>(async () => 1);
    assert.equal(memo('x'), memo('x'));
  });

  console.log('sortedPhaseTimings / formatPhaseBreakdown (run breakdown):');

  await test('sorts slowest-first and drops zero-duration phases', () => {
    const sorted = sortedPhaseTimings({ embed: 1000, seed: 5000, walk: 0, enrich: 2000 });
    assert.deepEqual(sorted, [['seed', 5000], ['enrich', 2000], ['embed', 1000]]);
  });

  await test('empty / all-zero timings → []', () => {
    assert.deepEqual(sortedPhaseTimings({}), []);
    assert.deepEqual(sortedPhaseTimings({ walk: 0, setup: 0 }), []);
  });

  await test('formats slowest-first with rounded seconds', () => {
    assert.equal(
      formatPhaseBreakdown({ embed: 120000, seed: 480000, learn: 60000 }),
      'seed 480s · embed 120s · learn 60s',
    );
  });

  await test('rounds sub-second-resolution values and empties cleanly', () => {
    assert.equal(formatPhaseBreakdown({ a: 1500 }), 'a 2s'); // Math.round(1.5) = 2
    assert.equal(formatPhaseBreakdown({}), '');
    assert.equal(formatPhaseBreakdown({ a: 0 }), '');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tagger-perf tests passed');
}

main();
