// The seed-vs-pick policy (#1247): the on-air track's id is a discovery SEED
// and never a valid answer, plus the classification of a pick that came back
// with an id no tool surfaced. The breaker carve-out is the difference between
// "the index doesn't cover that seed" and "this model can't drive tool calls".

import assert from 'node:assert/strict';
import { SEED_NOT_A_PICK_CLAUSE, classifyPickFailure } from '../src/util/pick-seed.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const SEED = 'qGlvGNc5jXlYcqkOR0DCMs';
const OTHER = 'zHPZijh0QjNFWqAz1QuSZF';

async function main() {
  console.log('SEED_NOT_A_PICK_CLAUSE (the shared wording):');

  await test('names the seed role AND forbids it as an answer', () => {
    // "Never pick the on-air track" alone reads as an arbitrary rule; the
    // clause has to say why.
    assert.match(SEED_NOT_A_PICK_CLAUSE, /seed/i);
    assert.match(SEED_NOT_A_PICK_CLAUSE, /never a valid answer/i);
  });

  await test('covers the empty-tool case explicitly', () => {
    // The failure only happens when a tool came back empty.
    assert.match(SEED_NOT_A_PICK_CLAUSE, /empty/i);
  });

  console.log('classifyPickFailure (why the run was discarded, and whose fault):');

  await test('zero candidates is NOT a breaker failure, even though the id was wrong', () => {
    // One discovery call into an index that does not cover the seed, then a
    // forced commit with nothing to commit.
    const f = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.equal(f.kind, 'no-candidates');
    assert.equal(f.countsAgainstBreaker, false);
    assert.match(f.message, /no candidates/i);
  });

  await test('zero candidates stays a coverage miss whatever the model answered', () => {
    // With an empty `seen` both salvage stages are unable to help, so the
    // answer is a symptom either way.
    const f = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.equal(f.kind, 'no-candidates');
    assert.equal(f.countsAgainstBreaker, false);
  });

  await test('zero candidates with ZERO discovery calls DOES count against the breaker', () => {
    // The other way `seen` ends up empty: the model never explored at all, and
    // a salvage leg fabricated an id against an empty trail. That is the
    // can't-drive-tool-calls failure the breaker watches for.
    const f = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 0 });
    assert.equal(f.kind, 'no-discovery');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, /no discovery call/i);
    const echoed = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 0 });
    assert.equal(echoed.kind, 'no-discovery');
    assert.equal(echoed.countsAgainstBreaker, true);
  });

  await test('zero candidates names the seed echo when that is what happened', () => {
    // Same verdict, different diagnosis in the booth log.
    const echoed = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 0, toolCalls: 1 });
    const other = classifyPickFailure({ pickedId: 'made-up-id', seedId: SEED, candidates: 0, toolCalls: 1 });
    assert.match(echoed.message, /on-air track's own id/i);
    assert.notEqual(echoed.message, other.message);
  });

  await test('seed echo WITH candidates IS a breaker failure', () => {
    // Real candidates and the constrained re-pick over them also missed: the
    // harness failing, which is what the breaker is for.
    const f = classifyPickFailure({ pickedId: SEED, seedId: SEED, candidates: 8, toolCalls: 1 });
    assert.equal(f.kind, 'seed-echo');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, /8 candidate/);
  });

  await test('an unrelated unknown id with candidates is a plain rejection', () => {
    const f = classifyPickFailure({ pickedId: OTHER, seedId: SEED, candidates: 5, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    assert.equal(f.countsAgainstBreaker, true);
    assert.match(f.message, new RegExp(OTHER));
  });

  await test('a null pick id with candidates is a plain rejection, not an echo', () => {
    // No usable id at all must not read as a seed echo just because seedId is
    // present.
    const f = classifyPickFailure({ pickedId: null, seedId: SEED, candidates: 5, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    assert.equal(f.countsAgainstBreaker, true);
  });

  await test('an unknown seed (boot / untracked track) never reads as an echo', () => {
    // current?.id is null on recover and on an untracked auto-playlist track;
    // null vs null must not classify every failure as a seed echo.
    const f = classifyPickFailure({ pickedId: null, seedId: null, candidates: 3, toolCalls: 1 });
    assert.equal(f.kind, 'unknown-id');
    const g = classifyPickFailure({ pickedId: OTHER, seedId: null, candidates: 3, toolCalls: 1 });
    assert.equal(g.kind, 'unknown-id');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall pick-seed tests passed');
}

main();
