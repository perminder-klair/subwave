// Unit tests for the propagation self-check scoring (music/propagation-eval.ts)
// — the pure math behind the tagger's held-out agreement line. Pinned so the
// gate mirror (votingNeighbours ≥ 1 && confidence ≥ threshold && moods > 0)
// never drifts from tag-library's real propagation gate, and the metrics stay
// honest (agreement scored over gate-passed cases only).
// Run: `tsx scripts/propagation-eval.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { moodJaccard, summariseEval, formatEvalSummary } from '../src/music/propagation-eval.js';
import type { VoteResult } from '../src/music/tag-propagator.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const result = (over: Partial<VoteResult>): VoteResult => ({
  moods: ['warm'],
  energy: null,
  confidence: 0.5,
  votingNeighbours: 3,
  ...over,
});

async function main() {
  console.log('moodJaccard:');

  await test('identical, disjoint, and partial sets', () => {
    assert.equal(moodJaccard(['a', 'b'], ['a', 'b']), 1);
    assert.equal(moodJaccard(['a'], ['b']), 0);
    assert.equal(moodJaccard(['a', 'b'], ['b', 'c']), 1 / 3);
    assert.equal(moodJaccard([], []), 1); // correctly predicted nothing
  });

  console.log('summariseEval (gate mirror + metrics):');

  await test('mirrors the propagation gate exactly', () => {
    const s = summariseEval(
      [
        { actual: { moods: ['warm'], energy: null }, result: result({}) },                    // passes
        { actual: { moods: ['warm'], energy: null }, result: result({ confidence: 0.3 }) },   // below threshold
        { actual: { moods: ['warm'], energy: null }, result: result({ moods: [] }) },         // no moods
        { actual: { moods: ['warm'], energy: null }, result: result({ votingNeighbours: 0 }) },
      ],
      0.35,
    );
    assert.equal(s.sampled, 4);
    assert.equal(s.gatePassed, 1);
  });

  await test('mood agreement averages over gate-passed cases only', () => {
    const s = summariseEval(
      [
        { actual: { moods: ['warm'], energy: null }, result: result({ moods: ['warm'] }) },          // 1.0
        { actual: { moods: ['warm', 'chill'], energy: null }, result: result({ moods: ['warm'] }) }, // 0.5
        { actual: { moods: ['gloomy'], energy: null }, result: result({ confidence: 0 }) },          // gated out
      ],
      0.35,
    );
    assert.equal(s.gatePassed, 2);
    assert.ok(Math.abs((s.moodJaccard ?? 0) - 0.75) < 1e-9);
  });

  await test('energy compared only when both sides have one', () => {
    const s = summariseEval(
      [
        { actual: { moods: ['warm'], energy: 'high' }, result: result({ energy: 'high' }) },
        { actual: { moods: ['warm'], energy: 'low' }, result: result({ energy: 'high' }) },
        { actual: { moods: ['warm'], energy: null }, result: result({ energy: 'high' }) },
        { actual: { moods: ['warm'], energy: 'low' }, result: result({ energy: null }) },
      ],
      0.35,
    );
    assert.equal(s.energyComparable, 2);
    assert.equal(s.energyMatched, 1);
  });

  await test('nothing gate-passed → null agreement, no NaN', () => {
    const s = summariseEval(
      [{ actual: { moods: ['warm'], energy: null }, result: result({ confidence: 0 }) }],
      0.35,
    );
    assert.equal(s.moodJaccard, null);
    assert.ok(formatEvalSummary(s).includes('0%'));
  });

  await test('formatEvalSummary reads sanely', () => {
    const s = summariseEval(
      [
        { actual: { moods: ['warm'], energy: 'high' }, result: result({ energy: 'high' }) },
        { actual: { moods: ['warm'], energy: null }, result: result({}) },
      ],
      0.35,
    );
    const line = formatEvalSummary(s);
    assert.ok(line.includes('2 held-out tracks'));
    assert.ok(line.includes('mood agreement 100%'));
    assert.ok(line.includes('energy match 100%'));
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall propagation-eval tests passed');
}

main();
