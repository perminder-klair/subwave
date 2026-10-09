// Regression tests for the show-level vocal/instrumental filter
// (music/show-filter.ts: trackInstrumental / preferVocals / onlyVocals, and its
// step inside applyStrictLocks). #1300 FR 13.
//
// The signal is Demucs vocal ranges, already load-bearing in bed-policy.ts
// (instrumental => never bed) and embeddings.formatTrackText (an `instrumental`
// minority marker). Its semantics are TRI-state and the whole feature rests on
// keeping them that way:
//
//   []    measured instrumental
//   [..]  measured vocal
//   null  NEVER MEASURED
//
// Vocal analysis is the opt-in heavy tier, so on the overwhelming majority of
// libraries every track is null. Collapsing null to "has vocals" — the obvious
// boolean simplification — would make an instrumental show reject its entire
// library while looking like it was working. That is what these tests exist to
// stop, so the null cases below are the point, not edge cases.
//
// Run: `tsx scripts/show-vocals.test.ts`.

import assert from 'node:assert/strict';
import {
  trackInstrumental,
  preferVocals,
  onlyVocals,
  applyStrictLocks,
} from '../src/music/show-filter.js';

// Bare shapes — no `id`, so nothing falls through to a library lookup and the
// assertions are about the ranges alone.
const inst = { vocalRanges: [] as unknown[] };
const sung = { vocalRanges: [{ startMs: 12_000, endMs: 40_000 }] };
const unknown = { vocalRanges: null };
const absent = {};

let failures = 0;
function scenario(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log('show vocal filter');

scenario('trackInstrumental is tri-state, not boolean', () => {
  assert.equal(trackInstrumental(inst), true);
  assert.equal(trackInstrumental(sung), false);
  // Both spellings of "nobody has looked" must read as unknown. An absent key
  // is what a raw Subsonic child carries; explicit null is what the library row
  // carries before a vocal pass.
  assert.equal(trackInstrumental(unknown), null);
  assert.equal(trackInstrumental(absent), null);
});

scenario('no mode set is a no-op on both paths', () => {
  const pool = [inst, sung, unknown];
  assert.deepEqual(preferVocals(pool, ''), pool);
  assert.deepEqual(onlyVocals(pool, ''), pool);
  assert.deepEqual(preferVocals(pool, null), pool);
  // Byte-identical passthrough matters: '' is what every show predating this
  // field carries, so an upgrade must not perturb a single pick.
  assert.equal(preferVocals(pool, ''), pool);
});

scenario('soft lean keeps un-measured tracks eligible', () => {
  const out = preferVocals([inst, sung, unknown], 'instrumental');
  assert.deepEqual(out, [inst, unknown]);
  assert.ok(!out.includes(sung));
});

scenario('soft lean never starves', () => {
  // Nothing instrumental and nothing unknown — the lean would empty the pool,
  // so it hands the whole thing back rather than leaving the show with nothing.
  const pool = [sung, sung];
  assert.deepEqual(preferVocals(pool, 'instrumental'), pool);
});

scenario('hard filter drops un-measured tracks', () => {
  // Strict means strict: a track nobody has analysed is not known-instrumental,
  // so it cannot satisfy an instrumental-only show.
  assert.deepEqual(onlyVocals([inst, sung, unknown, absent], 'instrumental'), [inst]);
  assert.deepEqual(onlyVocals([inst, sung, unknown, absent], 'vocal'), [sung]);
});

scenario('hard filter can empty the pool — that is the contract', () => {
  // onlyGenre/onlyEnergy behave the same way. Dead-air is guarded at a wider
  // scope (applyStrictLocks' starve:false, and the pool picker behind that),
  // never by silently readmitting off-filter tracks here.
  assert.deepEqual(onlyVocals([sung, unknown], 'instrumental'), []);
});

scenario('strict locks skip the vocal step rather than empty the pool', () => {
  // The realistic un-analysed library: the operator sets an instrumental show
  // on a station whose analyzer never ran Demucs. The dimension has zero
  // coverage, so it is skipped and the OTHER dimensions' work survives.
  const pool = [
    { id: 'a', energy: 'low', vocalRanges: null },
    { id: 'b', energy: 'high', vocalRanges: null },
  ];
  const out = applyStrictLocks(pool, { energies: ['low'], vocals: 'instrumental' }, { starve: false });
  assert.deepEqual(out, [pool[0]], 'energy lock should survive a starved vocal lock');
});

scenario('strict locks apply the vocal step when there is coverage', () => {
  const pool = [
    { id: 'a', energy: 'low', vocalRanges: [] as unknown[] },
    { id: 'b', energy: 'low', vocalRanges: [{ startMs: 1000, endMs: 2000 }] },
  ];
  const out = applyStrictLocks(pool, { energies: ['low'], vocals: 'instrumental' }, { starve: false });
  assert.deepEqual(out, [pool[0]]);
});

scenario('starve:true lets the vocal lock empty the pool', () => {
  // The agent-tool contract: a tool that ends up empty contributes nothing, and
  // a run with zero candidates fails into the pool picker.
  const pool = [{ id: 'a', vocalRanges: [{ startMs: 1, endMs: 2 }] }];
  assert.deepEqual(applyStrictLocks(pool, { vocals: 'instrumental' }, { starve: true }), []);
});

if (failures) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log('\nall scenarios passed');
