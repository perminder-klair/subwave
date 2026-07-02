// Unit tests for the KNN vote logic (music/tag-propagator.ts) — the pure math
// that propagates moods/energy from LLM-tagged seeds to their neighbours.
//
// Pins the similarity-WEIGHTED voting: each neighbour votes with
// max(0, similarity) rather than a flat 1, so a 0.9-similar neighbour outvotes
// two 0.3-similar ones (under flat counting it was the other way round — the
// far tail of the K list drowned out the one genuinely-similar match). The
// confidence formula (topSim * coverage) is deliberately unchanged; pinned
// here so the weighting never silently re-tunes the operator's
// confidenceThreshold semantics.
// Run: `tsx scripts/tag-propagator.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { vote, type NeighbourTags } from '../src/music/tag-propagator.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

// KNN results arrive closest-first; keep fixtures in that order.
const hit = (id: string, similarity: number) => ({ id, similarity });
const tagsOf = (map: Record<string, NeighbourTags>) => (id: string) => map[id] ?? null;

async function main() {
  console.log('vote (similarity-weighted KNN propagation):');

  await test('a close neighbour outvotes two far ones (the flat-count regression)', () => {
    // Flat counting: chill has 2 of 3 votes and wins, warm (1 of 3) loses —
    // exactly backwards given the similarities.
    const result = vote(
      [hit('a', 0.9), hit('b', 0.3), hit('c', 0.3)],
      tagsOf({
        a: { moods: ['warm'], energy: null },
        b: { moods: ['chill'], energy: null },
        c: { moods: ['chill'], energy: null },
      }),
      { moodVoteThreshold: 0.5, k: 3 },
    );
    // totalWeight 1.5 → threshold 0.75. warm carries 0.9, chill only 0.6.
    assert.deepEqual(result.moods, ['warm']);
  });

  await test('unanimous moods pass and sort by carried weight, capped at 3', () => {
    const result = vote(
      [hit('a', 0.8), hit('b', 0.7), hit('c', 0.6)],
      tagsOf({
        a: { moods: ['chill', 'warm', 'dreamy', 'mellow'], energy: null },
        b: { moods: ['chill', 'warm', 'dreamy', 'mellow'], energy: null },
        c: { moods: ['chill', 'warm', 'dreamy', 'mellow'], energy: null },
      }),
      { moodVoteThreshold: 0.5, k: 3 },
    );
    assert.equal(result.moods.length, 3); // vocab arrays cap at 3
  });

  await test('a mood carried only by weight-0 neighbours never passes', () => {
    const result = vote(
      [hit('a', 0.9), hit('b', -0.2)],
      tagsOf({
        a: { moods: ['warm'], energy: null },
        b: { moods: ['gloomy'], energy: null },
      }),
      { moodVoteThreshold: 0, k: 2 }, // even a zero threshold
    );
    assert.deepEqual(result.moods, ['warm']);
  });

  await test('energy is a weighted plurality, not a head-count', () => {
    const result = vote(
      [hit('a', 0.9), hit('b', 0.4), hit('c', 0.4)],
      tagsOf({
        a: { moods: ['warm'], energy: 'high' },
        b: { moods: ['warm'], energy: 'low' },
        c: { moods: ['warm'], energy: 'low' },
      }),
      { moodVoteThreshold: 0.5, k: 3 },
    );
    assert.equal(result.energy, 'high'); // 0.9 vs 0.8
  });

  await test('energy ties break toward the closest neighbour', () => {
    const result = vote(
      [hit('a', 0.5), hit('b', 0.5)],
      tagsOf({
        a: { moods: ['warm'], energy: 'medium' },
        b: { moods: ['warm'], energy: 'low' },
      }),
      { moodVoteThreshold: 0.5, k: 2 },
    );
    assert.equal(result.energy, 'medium');
  });

  await test('confidence stays topSim * coverage (operator threshold semantics)', () => {
    const result = vote(
      [hit('a', 0.75), hit('b', 0.6), hit('c', 0.5)],
      tagsOf({
        a: { moods: ['warm'], energy: null },
        b: { moods: ['warm'], energy: null },
        c: { moods: ['warm'], energy: null },
      }),
      { moodVoteThreshold: 0.5, k: 5 },
    );
    assert.ok(Math.abs(result.confidence - 0.75 * (3 / 5)) < 1e-9);
    assert.equal(result.votingNeighbours, 3);
  });

  await test('untagged neighbours are skipped entirely', () => {
    const result = vote(
      [hit('a', 0.9), hit('b', 0.8)],
      tagsOf({ b: { moods: ['chill'], energy: 'low' } }),
      { moodVoteThreshold: 0.5, k: 2 },
    );
    assert.deepEqual(result.moods, ['chill']);
    assert.equal(result.votingNeighbours, 1);
    // Coverage discounts the missing neighbour: 0.8 * (1/2).
    assert.ok(Math.abs(result.confidence - 0.4) < 1e-9);
  });

  await test('no tagged neighbours → zero result', () => {
    const result = vote([hit('a', 0.9)], () => null, { moodVoteThreshold: 0.5, k: 5 });
    assert.deepEqual(result, { moods: [], energy: null, confidence: 0, votingNeighbours: 0 });
  });

  await test('all-orthogonal (weight 0) neighbours → zero result, no NaN', () => {
    const result = vote(
      [hit('a', 0), hit('b', -0.4)],
      tagsOf({
        a: { moods: ['warm'], energy: 'high' },
        b: { moods: ['warm'], energy: 'high' },
      }),
      { moodVoteThreshold: 0.5, k: 2 },
    );
    assert.deepEqual(result, { moods: [], energy: null, confidence: 0, votingNeighbours: 0 });
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall tag-propagator tests passed');
}

main();
