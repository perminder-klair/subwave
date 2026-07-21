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
  resolveEraYear, trackEraYear,
  preferEnergy, preferEnergyStrict, preferMood,
  onlyGenre, onlyMood, onlyEnergy, applyStrictLocks,
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
await test('genreMatches matches ANY normalised target', () => {
  assert.equal(genreMatches(t({ genre: 'Hip Hop' }), [normGenre('Hip-Hop')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock'), normGenre('Jazz')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock')]), false);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), []), false);
});
await test('genreMatches: a track tag may REFINE the show genre', () => {
  assert.equal(genreMatches(t({ genre: 'Punk Rock' }), [normGenre('Punk')]), true);
  assert.equal(genreMatches(t({ genre: 'Contemporary R&B' }), [normGenre('R&B')]), true);
  assert.equal(genreMatches(t({ genre: 'Post-Hardcore' }), [normGenre('Hardcore')]), true);
  assert.equal(genreMatches(t({ genre: 'Pop Punk Revival' }), [normGenre('Pop Punk')]), true);
  // multi-tag: a secondary tag refines just as well as the primary one
  assert.equal(genreMatches(t({ genres: ['Alternative', 'Emo Pop'] }), [normGenre('Emo')]), true);
});
await test('genreMatches: a BROADER track tag never satisfies a stricter show genre', () => {
  assert.equal(genreMatches(t({ genre: 'Pop' }), [normGenre('Pop Punk')]), false);
  assert.equal(genreMatches(t({ genre: 'Rock' }), [normGenre('Alternative Rock')]), false);
  assert.equal(genreMatches(t({ genre: 'Emo' }), [normGenre('Emo Pop')]), false);
  assert.equal(genreMatches(t({ genre: 'Alternative' }), [normGenre('Alternative Rock')]), false);
});
await test('genreMatches: containment respects word boundaries', () => {
  assert.equal(genreMatches(t({ genre: 'Trap' }), [normGenre('Rap')]), false);
  assert.equal(genreMatches(t({ genre: 'Rockabilly' }), [normGenre('Rock')]), false);
  // ...but separators are still noise, so the boundary survives normalisation
  assert.equal(genreMatches(t({ genre: 'Hip-Hop/Rap' }), [normGenre('Rap')]), true);
  assert.equal(genreMatches(t({ genre: 'Pop-Punk' }), [normGenre('Pop Punk')]), true);
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

console.log('era year resolution (#842 — original year, compilation distrust):');
await test('resolveEraYear: originalYear wins over year; junk originalYear falls through', () => {
  assert.equal(resolveEraYear(2013, 1976, true), 1976);   // comp track, resolved
  assert.equal(resolveEraYear(2013, 1976, false), 1976);  // reissue, album-tag year
  assert.equal(resolveEraYear(1995, null, false), 1995);  // plain track
  assert.equal(resolveEraYear(1995, 0, false), 1995);     // TYER=0000-style junk original
});
await test("resolveEraYear: a compilation's plain year is untrusted (unknown)", () => {
  assert.equal(resolveEraYear(2013, null, true), null);
  // Unknown compilation status (null) keeps trusting the year — only a
  // positive flag distrusts it.
  assert.equal(resolveEraYear(2013, null, null), 2013);
});
await test('resolveEraYear: junk years read as unknown', () => {
  assert.equal(resolveEraYear(0, null, false), null);
  assert.equal(resolveEraYear('', null, false), null);
  assert.equal(resolveEraYear(null, null, false), null);
});
await test('trackEraYear: own fields short-circuit (no library lookup when either is present)', () => {
  assert.equal(trackEraYear(t({ year: 2013, originalYear: 1976, isCompilation: true })), 1976);
  assert.equal(trackEraYear(t({ year: 2013, originalYear: null, isCompilation: true })), null);
  assert.equal(trackEraYear(t({ year: 1995, originalYear: null, isCompilation: false })), 1995);
  // Bare Subsonic child (no era fields, library not loaded here) → plain year.
  assert.equal(trackEraYear(t({ year: 1995 })), 1995);
});
await test('inYearRange places a compilation track by its ORIGINAL year (#842)', () => {
  const seventies = [{ fromYear: 1970, toYear: 1979 }];
  const tens = [{ fromYear: 2010, toYear: 2019 }];
  const compResolved = t({ year: 2013, originalYear: 1976, isCompilation: true });
  const compUnresolved = t({ year: 2013, originalYear: null, isCompilation: true });
  // Resolved: lands in the 70s window, NOT the 2010s one.
  assert.deepEqual(inYearRange([compResolved], seventies), [compResolved]);
  assert.deepEqual(inYearRange([compResolved], tens), []);
  // Unresolved: year is the compilation's own date — untrusted, drops everywhere.
  assert.deepEqual(inYearRange([compUnresolved], tens), []);
  assert.deepEqual(inYearRange([compUnresolved], seventies), []);
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

console.log('hard filters (only*, NO never-starve — agent-tool locks + final-pool strict):');
await test('onlyGenre drops off-genre and untagged, even to empty', () => {
  const rock = t({ genre: 'Hard Rock' });
  const jazz = t({ genre: 'Jazz' });
  const untagged = t({ id: null });
  assert.deepEqual(onlyGenre([rock, jazz, untagged], ['Rock']), [rock]);
  assert.deepEqual(onlyGenre([jazz], ['Rock']), []);           // no fallback
  assert.deepEqual(onlyGenre([rock, jazz], []), [rock, jazz]); // no constraint
});
await test('onlyMood drops un-tagged, even to empty', () => {
  const a = t({ moods: ['calm'], audioMoods: [] });
  const b = t({ moods: [], audioMoods: [] });
  assert.deepEqual(onlyMood([a, b], ['calm']), [a]);
  assert.deepEqual(onlyMood([b], ['calm']), []);
  assert.deepEqual(onlyMood([a, b], []), [a, b]);
});
await test('onlyEnergy drops unknowns and off-band, even to empty', () => {
  const hi = t({ energy: 'high' });
  const unknown = t({ id: null });
  assert.deepEqual(onlyEnergy([hi, unknown], ['high']), [hi]);
  assert.deepEqual(onlyEnergy([hi, unknown], ['low']), []);
  assert.deepEqual(onlyEnergy([hi, unknown], []), [hi, unknown]);
});
await test('inYearRange is the hard era filter: unknown-year drops, empty allowed', () => {
  const in20s = t({ year: 2022 });
  const old = t({ year: 1999 });
  const noYear = t({ year: null });
  assert.deepEqual(inYearRange([in20s, old, noYear], [{ fromYear: 2020, toYear: 2029 }]), [in20s]);
  assert.deepEqual(inYearRange([old, noYear], [{ fromYear: 2020, toYear: 2029 }]), []);
});
await test('inYearRange: null/empty-string year does NOT pass an open-lower-bound window (Number(null)===0 trap)', () => {
  const in80s = t({ year: 1985 });
  const nullYear = t({ year: null });
  const emptyYear = t({ year: '' });
  const zeroYear = t({ year: 0 });
  // "1989 and earlier" — the old Number()-coercion let year:null/'' (→ 0) and a
  // genuine year:0 sail through 0 <= 1989. Only the real 1985 track may pass.
  assert.deepEqual(
    inYearRange([in80s, nullYear, emptyYear, zeroYear], [{ fromYear: null, toYear: 1989 }]),
    [in80s],
  );
});

console.log('applyStrictLocks (per-dimension cascade — the shared strict enforcer):');
await test('starve:true drops every dimension hard, even to empty (agent-tool contract)', () => {
  const jazz80sCalm = t({ id: '1', genre: 'Jazz', year: 1985, moods: ['calm'], audioMoods: [], energy: 'low' });
  const rock = t({ id: '2', genre: 'Rock', year: 1985, moods: ['calm'], audioMoods: [], energy: 'low' });
  const locks = { genres: ['Jazz'], eras: [{ fromYear: 1980, toYear: 1989 }], moods: ['calm'], energies: ['low'] };
  assert.deepEqual(applyStrictLocks([jazz80sCalm, rock], locks, { starve: true }).map(x => x.id), ['1']);
  // Un-tagged pool + a mood lock → hard-empties (the wider scope guards dead air).
  const untagged = t({ id: '3', genre: 'Jazz', year: 1985, moods: [], audioMoods: [], energy: 'low' });
  assert.deepEqual(applyStrictLocks([untagged], locks, { starve: true }), []);
});
await test('starve:false never-starves PER DIMENSION: one zero-coverage class keeps the rest pure', () => {
  // Genre + era have matches; NO track carries a mood (un-tagged library). The
  // old all-or-nothing joint revert dumped the whole (off-genre) pool back in;
  // the cascade must keep the genre/era-pure subset and skip only the mood step.
  const jazz80s = t({ id: '1', genre: 'Jazz', year: 1985, moods: [], audioMoods: [] });
  const rock80s = t({ id: '2', genre: 'Rock', year: 1985, moods: [], audioMoods: [] });
  const jazz90s = t({ id: '3', genre: 'Jazz', year: 1995, moods: [], audioMoods: [] });
  const locks = { genres: ['Jazz'], eras: [{ fromYear: 1980, toYear: 1989 }], moods: ['calm'], energies: [] };
  const out = applyStrictLocks([jazz80s, rock80s, jazz90s], locks, { starve: false }).map(x => x.id);
  assert.deepEqual(out, ['1']); // Jazz + 80s kept; mood step skipped (would empty), NOT reverted to full pool
});
await test('starve:false: a dimension WITH coverage still filters hard', () => {
  const calm = t({ id: '1', genre: 'Jazz', moods: ['calm'], audioMoods: [] });
  const loud = t({ id: '2', genre: 'Jazz', moods: ['loud'], audioMoods: [] });
  const out = applyStrictLocks([calm, loud], { genres: ['Jazz'], moods: ['calm'] }, { starve: false }).map(x => x.id);
  assert.deepEqual(out, ['1']);
});
await test('applyStrictLocks: empty locks are a full passthrough (no constraint)', () => {
  const pool = [t({ id: '1', genre: 'Jazz' }), t({ id: '2', genre: 'Rock' })];
  assert.deepEqual(applyStrictLocks(pool, { genres: [], eras: [], moods: [], energies: [] }, { starve: true }), pool);
  assert.deepEqual(applyStrictLocks(pool, {}, { starve: false }), pool);
});

if (failures) {
  console.error(`\n${failures} show-filter test(s) failed.`);
  process.exit(1);
}
console.log('\nAll show-filter tests passed.');
