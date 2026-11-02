// Unit pins for the shared show-music filter helpers (music/show-filter.ts) —
// the multi-value semantics behind #929: OR within an attribute (any entry
// matches), never-starve fallbacks, and the coarse era envelope (eraSpan) used
// for single-window Subsonic calls. Every track here carries its own fields so
// library.get() (which needs the DB open) is never consulted.
//
// Run: npm test -- show-filter

import assert from 'node:assert/strict';
import {
  normGenre, genreMatches, trackGenres, genreResolutionWarning, preferGenre,
  hasEraBound, eraSpan, inYearRange, preferEra,
  resolveEraYear, trackEraYear,
  preferEnergy, preferEnergyStrict, preferMood,
  trackInstrumental, preferVocals, onlyVocals, onlyGenre, onlyMood, onlyEnergy, applyStrictLocks,
} from '../src/music/show-filter.js';

import test from 'node:test';

const t = (over: Record<string, unknown>) => ({ id: 'x', title: 't', artist: 'a', ...over });

test('genreMatches matches ANY normalised target', () => {
  assert.equal(genreMatches(t({ genre: 'Hip Hop' }), [normGenre('Hip-Hop')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock'), normGenre('Jazz')]), true);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), [normGenre('Rock')]), false);
  assert.equal(genreMatches(t({ genre: 'Jazz' }), []), false);
});
test('trackGenres flattens OpenSubsonic {name} genre objects', () => {
  assert.deepEqual(trackGenres(t({ genres: [{ name: 'Darkwave' }, 'Cold Wave', { name: '' }] })), ['Darkwave', 'Cold Wave']);
  assert.equal(genreMatches(t({ genres: [{ name: 'Gothic Rock' }] }), [normGenre('Gothic Rock')]), true);
  // All-empty objects fall through to the scalar tag.
  assert.deepEqual(trackGenres(t({ genres: [{ name: '' }], genre: 'Rock' })), ['Rock']);
});
test('genreMatches: a track tag may REFINE the show genre', () => {
  assert.equal(genreMatches(t({ genre: 'Punk Rock' }), [normGenre('Punk')]), true);
  assert.equal(genreMatches(t({ genre: 'Contemporary R&B' }), [normGenre('R&B')]), true);
  assert.equal(genreMatches(t({ genre: 'Post-Hardcore' }), [normGenre('Hardcore')]), true);
  assert.equal(genreMatches(t({ genre: 'Pop Punk Revival' }), [normGenre('Pop Punk')]), true);
  // multi-tag: a secondary tag refines just as well as the primary one
  assert.equal(genreMatches(t({ genres: ['Alternative', 'Emo Pop'] }), [normGenre('Emo')]), true);
});
test('genreMatches: a BROADER track tag never satisfies a stricter show genre', () => {
  assert.equal(genreMatches(t({ genre: 'Pop' }), [normGenre('Pop Punk')]), false);
  assert.equal(genreMatches(t({ genre: 'Rock' }), [normGenre('Alternative Rock')]), false);
  assert.equal(genreMatches(t({ genre: 'Emo' }), [normGenre('Emo Pop')]), false);
  assert.equal(genreMatches(t({ genre: 'Alternative' }), [normGenre('Alternative Rock')]), false);
});
test('genreMatches: containment respects word boundaries', () => {
  assert.equal(genreMatches(t({ genre: 'Trap' }), [normGenre('Rap')]), false);
  assert.equal(genreMatches(t({ genre: 'Rockabilly' }), [normGenre('Rock')]), false);
  // ...but separators are still noise, so the boundary survives normalisation
  assert.equal(genreMatches(t({ genre: 'Hip-Hop/Rap' }), [normGenre('Rap')]), true);
  assert.equal(genreMatches(t({ genre: 'Pop-Punk' }), [normGenre('Pop Punk')]), true);
});
// Regressions found by replaying the new predicate over a real 10.4k-track
// library — every one of these was a live false positive under the old
// bidirectional substring, not a hypothetical.
test('genreMatches: real-library false positives stay dead', () => {
  // "urbanolatino" contains "rb", so an R&B show swept up Urbano latino.
  assert.equal(genreMatches(t({ genre: 'Urbano latino' }), [normGenre('R&B')]), false);
  assert.equal(genreMatches(t({ genre: 'Contemporary R&B' }), [normGenre('R&B')]), true);
  // An "Indian Pop" show pulled in everything tagged merely Pop or Indian.
  assert.equal(genreMatches(t({ genre: 'Pop' }), [normGenre('Indian Pop')]), false);
  assert.equal(genreMatches(t({ genre: 'Indian' }), [normGenre('Indian Pop')]), false);
  assert.equal(genreMatches(t({ genre: 'Indian Pop' }), [normGenre('Indian Pop')]), true);
  // A broad show must NOT lose its refinements — the fix only tightens narrow shows.
  assert.equal(genreMatches(t({ genre: 'Punjabi Pop' }), [normGenre('Punjabi')]), true);
  assert.equal(genreMatches(t({ genre: 'West Coast Rap' }), [normGenre('Rap')]), true);
});
test('preferGenre keeps tracks matching any entry; empty list is passthrough', () => {
  const rock = t({ genre: 'Hard Rock' });
  const jazz = t({ genre: 'Jazz' });
  const metal = t({ genre: 'Metal' });
  assert.deepEqual(preferGenre([rock, jazz, metal], ['Hard Rock', 'Metal']), [rock, metal]);
  assert.deepEqual(preferGenre([rock, jazz], []), [rock, jazz]);
  assert.deepEqual(preferGenre([rock, jazz], null), [rock, jazz]);
});
test('preferGenre never-starves: zero matches → full set', () => {
  const pool = [t({ genre: 'Jazz' }), t({ genre: 'Soul' })];
  assert.deepEqual(preferGenre(pool, ['Polka']), pool);
});

test('genreResolutionWarning: a faithful resolution says nothing', () => {
  assert.equal(genreResolutionWarning('Hip-Hop', 'Hip-Hop'), null);
  // cosmetic-only differences are still faithful
  assert.equal(genreResolutionWarning('hip hop', 'Hip-Hop'), null);
  assert.equal(genreResolutionWarning('', null), null);
});
test('genreResolutionWarning: broadening is called out by name', () => {
  const w = genreResolutionWarning('Pop Punk', 'Pop');
  assert.ok(w && w.includes('Pop Punk') && w.includes('"Pop"'), w ?? 'no warning');
  assert.match(w!, /broader/);
});
test('genreResolutionWarning: an unresolvable genre says the filter is OFF', () => {
  const w = genreResolutionWarning('Emo', null);
  assert.match(w!, /not a tag in your library/);
  assert.match(w!, /OFF/);
});
test('genreResolutionWarning: narrowing is reported differently from broadening', () => {
  const w = genreResolutionWarning('Punk', 'Pop Punk');
  assert.match(w!, /[Nn]arrowing/);
});

test('hasEraBound: empty / both-null windows carry no constraint', () => {
  assert.equal(hasEraBound([]), false);
  assert.equal(hasEraBound(null), false);
  assert.equal(hasEraBound([{ fromYear: null, toYear: null }]), false);
  assert.equal(hasEraBound([{ fromYear: 1990, toYear: null }]), true);
});
test('inYearRange admits a track inside ANY window; gap years drop', () => {
  const eras = [{ fromYear: 1990, toYear: 1999 }, { fromYear: 2010, toYear: 2019 }];
  const y95 = t({ year: 1995 });
  const y05 = t({ year: 2005 });   // the gap between the two windows
  const y15 = t({ year: 2015 });
  const noYear = t({});
  assert.deepEqual(inYearRange([y95, y05, y15, noYear], eras), [y95, y15]);
});
test('open-ended windows: toYear-only means "nothing after"', () => {
  const eras = [{ fromYear: null, toYear: 2009 }];
  assert.deepEqual(inYearRange([t({ year: 1970 }), t({ year: 2015 })], eras).length, 1);
});
test('preferEra never-starves: nothing in range → full set', () => {
  const pool = [t({ year: 1970 })];
  assert.deepEqual(preferEra(pool, [{ fromYear: 2020, toYear: 2029 }]), pool);
});
test('eraSpan: bounded windows → min/max envelope; any open bound opens that side', () => {
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

test('resolveEraYear: originalYear wins over year; junk originalYear falls through', () => {
  assert.equal(resolveEraYear(2013, 1976, true), 1976);   // comp track, resolved
  assert.equal(resolveEraYear(2013, 1976, false), 1976);  // reissue, album-tag year
  assert.equal(resolveEraYear(1995, null, false), 1995);  // plain track
  assert.equal(resolveEraYear(1995, 0, false), 1995);     // TYER=0000-style junk original
});
test("resolveEraYear: a compilation's plain year is untrusted (unknown)", () => {
  assert.equal(resolveEraYear(2013, null, true), null);
  // Unknown compilation status (null) keeps trusting the year — only a
  // positive flag distrusts it.
  assert.equal(resolveEraYear(2013, null, null), 2013);
});
test('resolveEraYear: junk years read as unknown', () => {
  assert.equal(resolveEraYear(0, null, false), null);
  assert.equal(resolveEraYear('', null, false), null);
  assert.equal(resolveEraYear(null, null, false), null);
});
test('trackEraYear: own fields short-circuit (no library lookup when either is present)', () => {
  assert.equal(trackEraYear(t({ year: 2013, originalYear: 1976, isCompilation: true })), 1976);
  assert.equal(trackEraYear(t({ year: 2013, originalYear: null, isCompilation: true })), null);
  assert.equal(trackEraYear(t({ year: 1995, originalYear: null, isCompilation: false })), 1995);
  // Bare Subsonic child (no era fields, library not loaded here) → plain year.
  assert.equal(trackEraYear(t({ year: 1995 })), 1995);
});
test('inYearRange places a compilation track by its ORIGINAL year (#842)', () => {
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

test('preferEnergy: unknown-energy tracks stay eligible; any band matches', () => {
  const hi = t({ energy: 'high' });
  const lo = t({ energy: 'low' });
  const unknown = t({ id: null });   // no energy field, no id → no library lookup
  assert.deepEqual(preferEnergy([hi, lo, unknown], ['high', 'medium']), [hi, unknown]);
  assert.deepEqual(preferEnergy([hi, lo], []), [hi, lo]);
});
test('preferEnergyStrict drops unknowns; never-starves on zero matches', () => {
  const hi = t({ energy: 'high' });
  const unknown = t({ id: null });
  assert.deepEqual(preferEnergyStrict([hi, unknown], ['high', 'medium']), [hi]);
  const pool = [t({ energy: 'low' })];
  assert.deepEqual(preferEnergyStrict(pool, ['high']), pool);
});

test('preferMood matches any selected mood, case-insensitive', () => {
  const a = t({ moods: ['Energetic'], audioMoods: [] });
  const b = t({ moods: ['calm'], audioMoods: [] });
  const c = t({ moods: [], audioMoods: ['driving'] });
  assert.deepEqual(preferMood([a, b, c], ['energetic', 'driving']), [a, c]);
});
test('preferMood never-starves: un-tagged pool → full set', () => {
  const pool = [t({ moods: [], audioMoods: [] })];
  assert.deepEqual(preferMood(pool, ['calm']), pool);
});

test('onlyGenre drops off-genre and untagged, even to empty', () => {
  const rock = t({ genre: 'Hard Rock' });
  const jazz = t({ genre: 'Jazz' });
  const untagged = t({ id: null });
  assert.deepEqual(onlyGenre([rock, jazz, untagged], ['Rock']), [rock]);
  assert.deepEqual(onlyGenre([jazz], ['Rock']), []);           // no fallback
  assert.deepEqual(onlyGenre([rock, jazz], []), [rock, jazz]); // no constraint
});
test('onlyMood drops un-tagged, even to empty', () => {
  const a = t({ moods: ['calm'], audioMoods: [] });
  const b = t({ moods: [], audioMoods: [] });
  assert.deepEqual(onlyMood([a, b], ['calm']), [a]);
  assert.deepEqual(onlyMood([b], ['calm']), []);
  assert.deepEqual(onlyMood([a, b], []), [a, b]);
});
test('onlyEnergy drops unknowns and off-band, even to empty', () => {
  const hi = t({ energy: 'high' });
  const unknown = t({ id: null });
  assert.deepEqual(onlyEnergy([hi, unknown], ['high']), [hi]);
  assert.deepEqual(onlyEnergy([hi, unknown], ['low']), []);
  assert.deepEqual(onlyEnergy([hi, unknown], []), [hi, unknown]);
});
test('inYearRange is the hard era filter: unknown-year drops, empty allowed', () => {
  const in20s = t({ year: 2022 });
  const old = t({ year: 1999 });
  const noYear = t({ year: null });
  assert.deepEqual(inYearRange([in20s, old, noYear], [{ fromYear: 2020, toYear: 2029 }]), [in20s]);
  assert.deepEqual(inYearRange([old, noYear], [{ fromYear: 2020, toYear: 2029 }]), []);
});
test('inYearRange: null/empty-string year does NOT pass an open-lower-bound window (Number(null)===0 trap)', () => {
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

test('starve:true drops every dimension hard, even to empty (agent-tool contract)', () => {
  const jazz80sCalm = t({ id: '1', genre: 'Jazz', year: 1985, moods: ['calm'], audioMoods: [], energy: 'low' });
  const rock = t({ id: '2', genre: 'Rock', year: 1985, moods: ['calm'], audioMoods: [], energy: 'low' });
  const locks = { genres: ['Jazz'], eras: [{ fromYear: 1980, toYear: 1989 }], moods: ['calm'], energies: ['low'] };
  assert.deepEqual(applyStrictLocks([jazz80sCalm, rock], locks, { starve: true }).map(x => x.id), ['1']);
  // Un-tagged pool + a mood lock → hard-empties (the wider scope guards dead air).
  const untagged = t({ id: '3', genre: 'Jazz', year: 1985, moods: [], audioMoods: [], energy: 'low' });
  assert.deepEqual(applyStrictLocks([untagged], locks, { starve: true }), []);
});
test('starve:false never-starves PER DIMENSION: one zero-coverage class keeps the rest pure', () => {
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
test('starve:false: a dimension WITH coverage still filters hard', () => {
  const calm = t({ id: '1', genre: 'Jazz', moods: ['calm'], audioMoods: [] });
  const loud = t({ id: '2', genre: 'Jazz', moods: ['loud'], audioMoods: [] });
  const out = applyStrictLocks([calm, loud], { genres: ['Jazz'], moods: ['calm'] }, { starve: false }).map(x => x.id);
  assert.deepEqual(out, ['1']);
});
test('applyStrictLocks: empty locks are a full passthrough (no constraint)', () => {
  const pool = [t({ id: '1', genre: 'Jazz' }), t({ id: '2', genre: 'Rock' })];
  assert.deepEqual(applyStrictLocks(pool, { genres: [], eras: [], moods: [], energies: [] }, { starve: true }), pool);
  assert.deepEqual(applyStrictLocks(pool, {}, { starve: false }), pool);
});

test('applyStrictLocks NEVER returns its input array', () => {
  // THE DEFECT THIS GUARDS. The auto.m3u coast rebuilds its pool in place
  // (`pool.length = 0; pool.push(...filtered)`), so a passthrough that hands
  // the input array straight back clears the very array being spread back in
  // and writes an empty auto.m3u. Reachable today: a strict show whose only
  // genre resolves to no library tag runs ZERO lock steps and passes through.
  // Same contract as music/track-floor.applyTrackFloor.
  const pool = [t({ id: '1', genre: 'Jazz' }), t({ id: '2', genre: 'Rock' })];
  // no locks at all — every step skipped
  assert.notEqual(applyStrictLocks(pool, {}, { starve: true }), pool);
  assert.notEqual(applyStrictLocks(pool, { genres: [], eras: [] }, { starve: false }), pool);
  // never-starve reverted every step it tried
  assert.notEqual(applyStrictLocks(pool, { genres: ['Nonexistent'] }, { starve: false }), pool);
  // contents unchanged on all of them
  assert.deepEqual(applyStrictLocks(pool, {}, { starve: true }).map(x => x.id), ['1', '2']);
  assert.deepEqual(
    applyStrictLocks(pool, { genres: ['Nonexistent'] }, { starve: false }).map(x => x.id),
    ['1', '2'],
  );
  // and the coast's in-place rebuild survives it
  const coast = [t({ id: '1', genre: 'Jazz' }), t({ id: '2', genre: 'Rock' })];
  const filtered = applyStrictLocks(coast, { genres: [] }, { starve: false });
  coast.length = 0;
  coast.push(...filtered);
  assert.deepEqual(coast.map(x => x.id), ['1', '2'], 'passthrough must not empty the coast');
});

// Vocal filters (#1300 FR 13) use the heavy analyzer's Demucs ranges:
// isInstrumental classifies measured sung duration; null is never measured.
// Most libraries have no heavy analysis. Reading null as vocal would silently
// reject the entire library for an instrumental show, so unknowns stay eligible
// under soft filters and are refused only under hard filters.

// Bare shapes — no `id`, so nothing falls through to a library lookup and the
// assertions are about the ranges alone.
const inst = { vocalRanges: [] as unknown[] };
const sung = { vocalRanges: [{ startMs: 12_000, endMs: 40_000 }] };
const unknown = { vocalRanges: null };
const absent = {};

test('trackInstrumental is tri-state, not boolean', () => {
  assert.equal(trackInstrumental(inst), true);
  assert.equal(trackInstrumental(sung), false);
  // Both spellings of "nobody has looked" must read as unknown. An absent key
  // is what a raw Subsonic child carries; explicit null is what the library row
  // carries before a vocal pass.
  assert.equal(trackInstrumental(unknown), null);
  assert.equal(trackInstrumental(absent), null);
});

test('no mode set is a no-op on both paths', () => {
  const pool = [inst, sung, unknown];
  assert.deepEqual(preferVocals(pool, ''), pool);
  assert.deepEqual(onlyVocals(pool, ''), pool);
  assert.deepEqual(preferVocals(pool, null), pool);
  // Byte-identical passthrough matters: '' is what every show predating this
  // field carries, so an upgrade must not perturb a single pick.
  assert.equal(preferVocals(pool, ''), pool);
});

test('soft lean keeps un-measured tracks eligible', () => {
  const out = preferVocals([inst, sung, unknown], 'instrumental');
  assert.deepEqual(out, [inst, unknown]);
  assert.ok(!out.includes(sung));
});

test('soft lean never starves', () => {
  // Nothing instrumental and nothing unknown — the lean would empty the pool,
  // so it hands the whole thing back rather than leaving the show with nothing.
  const pool = [sung, sung];
  assert.deepEqual(preferVocals(pool, 'instrumental'), pool);
});

test('hard filter drops un-measured tracks', () => {
  // Strict means strict: a track nobody has analysed is not known-instrumental,
  // so it cannot satisfy an instrumental-only show.
  assert.deepEqual(onlyVocals([inst, sung, unknown, absent], 'instrumental'), [inst]);
  assert.deepEqual(onlyVocals([inst, sung, unknown, absent], 'vocal'), [sung]);
});

test('hard filter can empty the pool — that is the contract', () => {
  // onlyGenre/onlyEnergy behave the same way. Dead-air is guarded at a wider
  // scope (applyStrictLocks' starve:false, and the pool picker behind that),
  // never by silently readmitting off-filter tracks here.
  assert.deepEqual(onlyVocals([sung, unknown], 'instrumental'), []);
});

test('strict locks skip the vocal step rather than empty the pool', () => {
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

test('strict locks apply the vocal step when there is coverage', () => {
  const pool = [
    { id: 'a', energy: 'low', vocalRanges: [] as unknown[] },
    { id: 'b', energy: 'low', vocalRanges: [{ startMs: 1000, endMs: 6000 }] },
  ];
  const out = applyStrictLocks(pool, { energies: ['low'], vocals: 'instrumental' }, { starve: false });
  assert.deepEqual(out, [pool[0]]);
});

test('starve:true lets the vocal lock empty the pool', () => {
  // The agent-tool contract: a tool that ends up empty contributes nothing, and
  // a run with zero candidates fails into the pool picker.
  const pool = [{ id: 'a', vocalRanges: [{ startMs: 1, endMs: 5001 }] }];
  assert.deepEqual(applyStrictLocks(pool, { vocals: 'instrumental' }, { starve: true }), []);
});
