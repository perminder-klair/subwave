// Unit tests for the pure decision logic behind Last.fm tag enrichment — the
// two regression-critical branches fixed in #531/#532. Run:
// `tsx scripts/lastfm-enrich.test.ts` (folded into `npm run test`).
//
// Both functions are side-effect-free and unit-pinned here so a wiring slip
// (the enrich-scope narrowed back to untagged-only, the tri-state gate
// tightened back to strict `=== true`) fails an assert before it can ship.
// node:assert-via-tsx style, matching scripts/llm-pure.test.ts.

import assert from 'node:assert/strict';
import { lastfmEnrichEnabled } from '../src/music/lastfm.js';
import { selectEnrichIds } from '../src/music/enrich-scope.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  // ---- lastfmEnrichEnabled: the tri-state gate (#532 / #533) ----
  // The whole point of #532 was that this gate differed between the bulk tagger
  // (tri-state) and the retag route (strict === true). Pin every cell.
  console.log('lastfmEnrichEnabled (tri-state, shared by both call sites):');

  await test('explicit true enriches even WITHOUT a key', () => {
    assert.equal(lastfmEnrichEnabled(true, false), true);
    assert.equal(lastfmEnrichEnabled(true, true), true);
  });
  await test('explicit false NEVER enriches, even WITH a key', () => {
    assert.equal(lastfmEnrichEnabled(false, true), false);
    assert.equal(lastfmEnrichEnabled(false, false), false);
  });
  await test('default (unset) enriches ONLY when a key is present — the #532 fix', () => {
    // This is the exact cell the old strict `=== true` got wrong on the retag route.
    assert.equal(lastfmEnrichEnabled(undefined, true), true);
    assert.equal(lastfmEnrichEnabled(null, true), true);
    assert.equal(lastfmEnrichEnabled(undefined, false), false);
    assert.equal(lastfmEnrichEnabled(null, false), false);
  });

  // ---- selectEnrichIds: phase-0 scope (#531) ----
  console.log('selectEnrichIds (enrich scope — re-enrich must widen past untagged):');
  const live = ['a', 'b', 'c', 'd'];

  await test('normal run enriches exactly the in-scope untagged set', () => {
    const ids = selectEnrichIds({ reEnrich: false, limit: Infinity, liveIds: live, targetUntagged: ['b'] });
    assert.deepEqual(ids, ['b']);
  });
  await test('normal run on a fully-tagged library enriches nothing (unchanged)', () => {
    const ids = selectEnrichIds({ reEnrich: false, limit: Infinity, liveIds: live, targetUntagged: [] });
    assert.deepEqual(ids, []);
  });
  await test('re-enrich on a FULLY-TAGGED library still covers the whole catalogue — the #531 fix', () => {
    // The original bug: re-enrich passed the (empty) untagged set, so phase 0
    // was a silent no-op. It must now span every live track.
    const ids = selectEnrichIds({ reEnrich: true, limit: Infinity, liveIds: live, targetUntagged: [] });
    assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  });
  await test('re-enrich honours --limit by capping the catalogue', () => {
    const ids = selectEnrichIds({ reEnrich: true, limit: 2, liveIds: live, targetUntagged: [] });
    assert.deepEqual(ids, ['a', 'b']);
  });
  await test('re-enrich accepts a Set for liveIds (matches the caller)', () => {
    const ids = selectEnrichIds({ reEnrich: true, limit: Infinity, liveIds: new Set(live), targetUntagged: [] });
    assert.deepEqual(ids, ['a', 'b', 'c', 'd']);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall lastfm-enrich tests passed');
}

main();
