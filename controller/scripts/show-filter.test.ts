// Unit pins for the shared show-music filter helpers (music/show-filter.ts) —
// the multi-value semantics behind #929: OR within an attribute (any entry
// matches), never-starve fallbacks, and the coarse era envelope (eraSpan) used
// for single-window Subsonic calls. Every track here carries its own fields so
// library.get() (which needs the DB open) is never consulted.
//
// Run: npm test -- show-filter

import assert from 'node:assert/strict';
import {
  normGenre, genreMatches, preferGenre,
  hasEraBound, eraSpan, inYearRange, preferEra,
  preferEnergy, preferEnergyStrict, preferMood,
} from '../src/music/show-filter.js';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
  }
}

const t = (over: Record<string, unknown>) => ({ id: 'x', title: 't', artist: 'a', ...over });

console.log('genre (any-of, never-starve):');
await test('genreMatches matches ANY normalised target, substring both ways', () => {
  assert.equal(genreMatches(t({ genre: 'Hip Hop' }), [normGenre('Hip-Hop')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock'), normGenre('Jazz')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock')]), false);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), []), false);
});
await test('preferGenre keeps tracks matching any entry; empty list is passthrough', () => {
  const rock = t({ genre: 'Hard Rock' });
  const jazz = t({ genre: 'Jazz' });
  const metal = t({ genre: 'Metal' });
  assert.deepEqual(preferGenre([rock, jazz, metal], ['Hard Rock', 'Metal']), [rock, metal]);
  assert.deepEqual(preferGenre([rock, jazz], []), [rock, jazz]);
  assert.deepEqual(preferGenre([rock, jazz], null), [rock, jazz]);
});
await test('preferGenre never-starves: zero matches → full set', () => {
  const pool = [t({ genre: 'Jazz' }), t({ genre: 'Soul' })];
  assert.deepEqual(preferGenre(pool, ['Polka']), pool);
});

console.log('era (window union, envelope):');
await test('hasEraBound: empty / both-null windows carry no constraint', () => {
  assert.equal(hasEraBound([]), false);
  assert.equal(hasEraBound(null), false);
  assert.equal(hasEraBound([{ fromYear: null, toYear: null }]), false);
  assert.equal(hasEraBound([{ fromYear: 1990, toYear: null }]), true);
});
await test('inYearRange admits a track inside ANY window; gap years drop', () => {
  const eras = [{ fromYear: 1990, toYear: 1999 }, { fromYear: 2010, toYear: 2019 }];
  const y95 = t({ year: 1995 });
  const y05 = t({ year: 2005 });   // the gap between the two windows
  const y15 = t({ year: 2015 });
  const noYear = t({});
  assert.deepEqual(inYearRange([y95, y05, y15, noYear], eras), [y95, y15]);
});
await test('open-ended windows: toYear-only means "nothing after"', () => {
  const eras = [{ fromYear: null, toYear: 2009 }];
  assert.deepEqual(inYearRange([t({ year: 1970 }), t({ year: 2015 })], eras).length, 1);
});
await test('preferEra never-starves: nothing in range → full set', () => {
  const pool = [t({ year: 1970 })];
  assert.deepEqual(preferEra(pool, [{ fromYear: 2020, toYear: 2029 }]), pool);
});
await test('eraSpan: bounded windows → min/max envelope; any open bound opens that side', () => {
  assert.deepEqual(
    eraSpan([{ fromYear: 1990, toYear: 1999 }, { fromYear: 2010, toYear: 2019 }]),
    { fromYear: 1990, toYear: 2019 },
  );
  // A toYear-only window leaves the from side open — the envelope must never
  // exclude a track that window admits.
  assert.deepEqual(
    eraSpan([{ fromYear: null, toYear: 2009 }, { fromYear: 2020, toYear: 2029 }]),
    { fromYear: null, toYear: 2029 },
  );
  assert.deepEqual(eraSpan([]), { fromYear: null, toYear: null });
});

console.log('energy (any-of bands):');
await test('preferEnergy: unknown-energy tracks stay eligible; any band matches', () => {
  const hi = t({ energy: 'high' });
  const lo = t({ energy: 'low' });
  const unknown = t({ id: null });   // no energy field, no id → no library lookup
  assert.deepEqual(preferEnergy([hi, lo, unknown], ['high', 'medium']), [hi, unknown]);
  assert.deepEqual(preferEnergy([hi, lo], []), [hi, lo]);
});
await test('preferEnergyStrict drops unknowns; never-starves on zero matches', () => {
  const hi = t({ energy: 'high' });
  const unknown = t({ id: null });
  assert.deepEqual(preferEnergyStrict([hi, unknown], ['high', 'medium']), [hi]);
  const pool = [t({ energy: 'low' })];
  assert.deepEqual(preferEnergyStrict(pool, ['high']), pool);
});

console.log('mood (any-of tags):');
await test('preferMood matches any selected mood, case-insensitive', () => {
  const a = t({ moods: ['Energetic'], audioMoods: [] });
  const b = t({ moods: ['calm'], audioMoods: [] });
  const c = t({ moods: [], audioMoods: ['driving'] });
  assert.deepEqual(preferMood([a, b, c], ['energetic', 'driving']), [a, c]);
});
await test('preferMood never-starves: un-tagged pool → full set', () => {
  const pool = [t({ moods: [], audioMoods: [] })];
  assert.deepEqual(preferMood(pool, ['calm']), pool);
});

if (failures) {
  console.error(`\n${failures} show-filter test(s) failed.`);
  process.exit(1);
}
console.log('\nAll show-filter tests passed.');
