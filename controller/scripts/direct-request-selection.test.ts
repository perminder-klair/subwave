import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directRequestUnsupported, explicitRequestAttribute, modelFreeRequest, requestedTitle, repairRequestMatch, requestArtistMatches, requestReleaseRank, requestTitleMatches,
  resolveDirectRequest, type RequestCatalog, type RequestMatch, type RequestSong,
} from '../src/music/request-match.js';

const exact: RequestSong = { id: 'exact', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock' };
const other: RequestSong = { id: 'other', title: 'Another Song', artist: 'Queen', album: 'Other Album', genre: 'Jazz' };
const filler: RequestSong = { id: 'filler', title: 'Fatigue', artist: 'The Gathering', genre: 'Rock' };
const songRequest: RequestMatch = { title: exact.title, artist: 'Queen', search_terms: [exact.title!, 'Queen'], scope: 'song' };

for (const [language, term] of [['French', 'français'], ['French', 'francés'], ['Spanish', 'español'], ['German', 'Deutsch'], ['Punjabi', 'ਪੰਜਾਬੀ']]) {
  test(`a translated ${language} requirement is recognised outside names: ${term}`, () => {
    const match = { ...songRequest, language };
    assert.ok(explicitRequestAttribute(`Play Bohemian Rhapsody by Queen in ${term}`, match, language));
    assert.equal(explicitRequestAttribute(`Play ${term} by Queen`, { ...match, title: term }, language), false);
  });
}

test('attribute evidence tolerates spacing but never substrings or language-code prepositions', () => {
  assert.ok(explicitRequestAttribute('Play hiphop', { genre: 'Hip Hop' }, 'Hip Hop'));
  assert.ok(explicitRequestAttribute('Play hip hop', { genre: 'HipHop' }, 'HipHop'));
  assert.equal(explicitRequestAttribute('Play trap', { genre: 'Rap' }, 'Rap'), false);
  assert.equal(explicitRequestAttribute('Joue un morceau en français', { language: 'English' }, 'English'), false);
  assert.equal(explicitRequestAttribute('Joue un morceau de Queen', { language: 'German' }, 'German'), false);
});

test('a translated word in a title does not harden an inferred language', async () => {
  const named = { ...exact, title: 'Français', language: 'English' };
  const f = fixture({ searchPage: async () => ({ songs: [named], rawCount: 1 }) });
  const r = await resolveDirectRequest({ title: named.title, artist: 'Queen', language: 'French' },
    { ...f.deps, text: 'Play Français by Queen' });
  assert.equal(r.track?.id, named.id);
  assert.equal(r.outcome, 'matched');
});

test('a fuzzy artist resolution cannot prove a name hiding an exclusion', async () => {
  const f = fixture();
  const r = await resolveDirectRequest({ artist: 'anything except Queen' },
    { ...f.deps, text: 'Play anything except Queen' });
  assert.equal(r.outcome, 'unsupported');
  assert.equal(r.track, null);
  assert.deepEqual(f.albums, []);
  assert.equal(f.fallbackCalls(), 0);
});

test('catalogue proof of a condition-like title still preserves its cooldown refusal', async () => {
  const named = { ...exact, title: 'Anything But Love' };
  const f = fixture({ searchPage: async () => ({ songs: [named], rawCount: 1 }) });
  f.deps.recentIds.add(named.id);
  const r = await resolveDirectRequest({ title: named.title, artist: 'Queen' },
    { ...f.deps, text: 'Play Anything But Love by Queen' });
  assert.equal(r.outcome, 'cooldown');
  assert.equal(r.track?.id, named.id);
});

test('unsupported plans stop before any catalogue or preference lookup', async () => {
  const f = fixture({ searchPage: async () => { throw Error('must not search'); } });
  f.deps.moodSongs = async () => { throw Error('must not load moods'); };
  const r = await resolveDirectRequest({ ...songRequest, mood: 'calm', unsupported: ['exclusions'] }, f.deps);
  assert.equal(r.outcome, 'unsupported');
  assert.equal(r.track, null);
  assert.deepEqual(r.errors, []);
  assert.equal(f.fallbackCalls(), 0);
});

test('common exclusion and era wording survives a model omission', () => {
  for (const text of ['play anything except Queen', 'play something by Queen but not live', 'music other than Queen', 'play instrumental music from the 1990s']) {
    assert.ok(directRequestUnsupported(text).length, text);
  }
  assert.deepEqual(directRequestUnsupported('play something by Queen', { unsupported: ['previous conversation'] }), ['previous conversation']);
});

test('names and quoted titles are not mistaken for unsupported conditions', () => {
  for (const text of ['play something by No Doubt', 'play Don’t Stop Me Now by Queen', 'play Only You by Yazoo', 'play "Anything Except Queen"', 'play “Live Music” by Example', 'play something by Everything but the Girl', 'play "1990s" by Example']) {
    assert.deepEqual(directRequestUnsupported(text), [], text);
  }
});

test('explicit negative instructions survive an omitted model condition', () => {
  for (const text of [
    'Play some soul, avoid stadium rock', 'Avoid stadium rock',
    'Play Queen but steer clear of live versions', 'Play some soul; please exclude metal',
    'Play some soul and don’t include metal', 'Please do not include Queen',
    'Play soul with no metal', 'Play soul with no metal by Queen',
    'Play anything except live recordings by Queen',
    'Play something but not live by Queen',
    'Play “Anything But Love”, but avoid live versions',
    'Play Anything But Love by Example, but don’t include live versions',
  ]) assert.ok(directRequestUnsupported(text).includes('exclusions'), text);
});

test('a name left in search terms, or spelled with "The", is masked before condition checks', () => {
  // #1961's reply shape: the title only in search_terms beside a guessed mood.
  assert.deepEqual(directRequestUnsupported('A Horse with No Name by America',
    { title: null, artist: 'America', mood: 'reflective', search_terms: ['A Horse with No Name'] }), []);
  assert.equal(explicitRequestAttribute('Hey You by Rock Steady Crew',
    { title: 'Hey You', artist: 'The Rock Steady Crew' }, 'rock'), false);
  // A term carrying the reading's own genre word is not a name.
  assert.equal(explicitRequestAttribute('play some rock songs', { genre: 'rock', search_terms: ['rock songs'] }, 'rock'), true);
  assert.deepEqual(directRequestUnsupported('play soul with no metal by Queen', { artist: 'Queen', genre: 'soul', search_terms: ['Queen'] }), ['exclusions']);
});

test('negative-looking names and idioms remain requestable', () => {
  for (const text of [
    'Play Anything But Love by Example', 'Play Other Than This by Example',
    'Play something by No Doubt', 'Play Not Waving', 'Play Skip James',
    'Play Never Shout Never', 'Play no wave', 'Play No More Drama by Mary J. Blige',
    'Play soul, not least Motown', 'Play Noël', 'Play Ōno',
    'Play Shingeki no Kyojin', 'Play “Avoid Metal”',
    'Play With No Regrets by Example',
  ]) assert.deepEqual(directRequestUnsupported(text, / by /i.test(text) ? modelFreeRequest(text) : {}), [], text);
  assert.deepEqual(directRequestUnsupported('Play Anything But Love by Example', { unsupported: ['exclusions'] }), ['exclusions']);
});

test('a named title selects only the recording satisfying its language requirement', async () => {
  const french = { ...exact, id: 'french', language: 'French' };
  const f = fixture({ searchPage: async () => ({ songs: [{ ...exact, language: 'English' }, french], rawCount: 2 }) });
  const result = await resolveDirectRequest({ ...songRequest, language: 'French' }, f.deps);
  assert.equal(result.track?.id, french.id);
  assert.equal(result.outcome, 'matched');
});

for (const requirement of [{ language: 'French' }, { genre: 'Classical' }]) {
  test(`unsatisfied named-song requirements also exclude incompatible alternatives: ${JSON.stringify(requirement)}`, async () => {
    const f = fixture();
    const result = await resolveDirectRequest({ ...songRequest, ...requirement }, f.deps);
    assert.equal(result.track, null);
    assert.equal(result.outcome, 'no-match');
  });
}

test('unknown language metadata cannot satisfy an explicit language requirement', async () => {
  const f = fixture();
  assert.equal((await resolveDirectRequest({ ...songRequest, language: 'English' }, f.deps)).track, null);
});

test('a language-compatible alternative is still identified as a substitution', async () => {
  const french = { ...other, language: 'French' };
  const f = fixture({ getAlbum: async () => [french] });
  const result = await resolveDirectRequest({ ...songRequest, language: 'French' }, f.deps);
  assert.equal(result.track?.id, other.id);
  assert.equal(result.outcome, 'substituted');
});

test('literal fallback cannot claim a fuzzy artist as an exact match', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ ...songRequest, artist: 'Queen in French', literal: true }, f.deps);
  assert.ok(result.track);
  assert.equal(result.outcome, 'substituted');
  assert.deepEqual(f.albums, []);
});

test('literal recovery can offer an honestly labelled alternative', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ title: 'Bohemian Rhapsody in French', artist: 'Queen', literal: true }, f.deps);
  assert.ok(result.track);
  assert.equal(result.outcome, 'substituted');
});

test('an unmet artist mood preference is diagnostic', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ artist: 'Queen', mood: 'calm' }, f.deps);
  assert.equal(result.track?.artist, 'Queen');
  assert.equal(result.outcome, 'matched');
  assert.deepEqual(result.unmetPreferences, ['mood']);
});

test('a named recording stays selected when its mood cannot be verified', async () => {
  const f = fixture();
  f.deps.moodSongs = async () => { throw Error('mood database unavailable'); };
  const result = await resolveDirectRequest({ ...songRequest, mood: 'calm' }, f.deps);
  assert.equal(result.track?.id, exact.id);
  assert.equal(result.outcome, 'matched');
  assert.deepEqual(result.unmetPreferences, ['mood']);
  assert.equal(result.errors.length, 1);
});

test('a verified mood remains a successful match for a named recording', async () => {
  const f = fixture();
  f.deps.moodSongs = async () => [exact];
  assert.equal((await resolveDirectRequest({ ...songRequest, mood: 'calm' }, f.deps)).outcome, 'matched');
});

function fixture(overrides: Partial<RequestCatalog> = {}) {
  const searches: Array<{ query: string; songOffset: number }> = [];
  const albums: string[] = [];
  let fallbackCalls = 0;
  const catalog: RequestCatalog = {
    searchPage: async (query, { songOffset }) => { searches.push({ query, songOffset }); return { songs: [exact, other], rawCount: 2 }; },
    resolveArtist: async () => ({ id: 'queen', name: 'Queen' }),
    getArtist: async () => ({ album: [{ id: 'old', name: exact.album, year: 1975 }, { id: 'new', name: other.album, year: 2020 }] }),
    getAlbum: async id => { albums.push(id); return id === 'old' ? [exact] : [other]; },
    getTopSongs: async () => [other],
    resolveGenreName: async name => name,
    getSongsByGenreSampled: async () => [filler],
    ...overrides,
  };
  const deps = { catalog, recentIds: new Set<string>(), queuedIds: new Set<string>(), currentId: null as string | null,
    moodSongs: async (_mood: string) => [filler], fallbackSongs: async () => { fallbackCalls++; return [filler]; }, random: () => 0 };
  return { deps, searches, albums, fallbackCalls: () => fallbackCalls };
}

for (const attributes of [{ genre: 'rock' }, { sort: 'latest' }]) {
  test(`a named recording retains its identity with ${JSON.stringify(attributes)}`, async () => {
    const f = fixture();
    const r = await resolveDirectRequest({ ...songRequest, ...attributes }, f.deps);
    assert.equal(r.track?.id, exact.id);
    assert.equal(r.outcome, 'matched');
    assert.deepEqual(f.searches, [{ query: exact.title, songOffset: 0 }]);
    assert.equal(f.fallbackCalls(), 0);
  });
}

test('a legacy title+artist search reply never becomes an artist-results lottery', async () => {
  const f = fixture();
  f.deps.random = () => 0.99;
  const r = await resolveDirectRequest({ artist: 'Queen', search_terms: [exact.title!, 'Queen'] }, f.deps);
  assert.equal(r.track?.id, exact.id);
  assert.ok(f.searches.every(q => q.query === exact.title));
});

test('an ambiguous album scope cannot override a legacy named song term', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ artist: 'Queen', search_terms: [exact.title!, 'Queen'], scope: 'album' }, f.deps);
  assert.equal(result.track?.id, exact.id);
});

test('deterministic pagination reaches an exact hit after a full first page', async () => {
  const offsets: number[] = [];
  const f = fixture({ searchPage: async (_query, { songOffset }) => {
    offsets.push(songOffset);
    return songOffset === 0 ? { songs: Array.from({ length: 25 }, (_, i) => ({ ...other, id: `other-${i}` })), rawCount: 25 }
      : { songs: [exact], rawCount: 1 };
  } });
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).track?.id, exact.id);
  assert.deepEqual(offsets, [0, 25]);
});

test('pagination uses raw page size even when blocked rows leave an empty page', async () => {
  const f = fixture({ searchPage: async (_query, { songOffset }) => songOffset === 0
    ? { songs: [], rawCount: 25 } : { songs: [exact], rawCount: 1 } });
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).track?.id, exact.id);
});

test('bounded pagination does not search a whole huge library', async () => {
  let pages = 0;
  const f = fixture({ resolveArtist: async () => null, searchPage: async () => { pages++; return { songs: [other], rawCount: 25 }; } });
  const r = await resolveDirectRequest(songRequest, f.deps);
  assert.equal(pages, 4);
  assert.equal(r.outcome, 'substituted');
});

test('a search failure can recover the exact recording from the artist catalogue', async () => {
  const f = fixture({ searchPage: async () => { throw Error('offline search'); } });
  const r = await resolveDirectRequest(songRequest, f.deps);
  assert.equal(r.track?.id, exact.id);
  assert.equal(r.outcome, 'matched');
  assert.ok(r.errors.some(e => e.includes('offline search')));
});

test('a missing title is an explicit substitution even by the same artist', async () => {
  const f = fixture({ searchPage: async () => ({ songs: [other], rawCount: 1 }), getAlbum: async () => [other] });
  const r = await resolveDirectRequest(songRequest, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.equal(r.outcome, 'substituted');
});

test('a missing title prefers a fresh track by the requested artist before unrelated filler', async () => {
  const f = fixture({ searchPage: async () => ({ songs: [], rawCount: 0 }), getAlbum: async () => [other] });
  const r = await resolveDirectRequest(songRequest, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.equal(r.outcome, 'substituted');
  assert.equal(f.fallbackCalls(), 0);
});

test('an exact title by a cover artist never counts as the requested performer', async () => {
  const cover = { ...exact, id: 'cover', artist: 'Someone Else' };
  const f = fixture({ searchPage: async () => ({ songs: [cover, exact], rawCount: 2 }) });
  f.deps.random = () => 0.99;
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).track?.id, exact.id);
});

test('album scope resolves the named album rather than the first artist album', async () => {
  const f = fixture();
  const r = await resolveDirectRequest({ artist: 'Queen', album: other.album, scope: 'album', search_terms: [other.album!, 'Queen'] }, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.deepEqual(f.albums, ['new']);
});

test('a named album without an artist uses album-filtered catalogue search', async () => {
  const f = fixture();
  assert.equal((await resolveDirectRequest({ album: other.album, scope: 'album' }, f.deps)).track?.id, other.id);
});

test('a bare artist walks past a recent first album to fresh tracks', async () => {
  const f = fixture();
  f.deps.recentIds.add(exact.id);
  const r = await resolveDirectRequest({ artist: 'Queen', search_terms: ['Queen'] }, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.deepEqual(f.albums, ['old', 'new']);
});

test('a failed first album does not discard the next valid album', async () => {
  const f = fixture({ getAlbum: async id => { if (id === 'old') throw Error('bad album'); return [other]; } });
  const r = await resolveDirectRequest({ artist: 'Queen' }, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.equal(r.errors.length, 1);
});

for (const refused of ['cooldown', 'already-queued'] as const) {
  test(`a named recording preserves its identity on ${refused}`, async () => {
    const f = fixture();
    (refused === 'cooldown' ? f.deps.recentIds : f.deps.queuedIds).add(exact.id);
    const r = await resolveDirectRequest(songRequest, f.deps);
    assert.equal(r.track?.id, exact.id);
    assert.equal(r.outcome, refused);
    assert.equal(f.fallbackCalls(), 0);
  });
}

test('a playing recording is refused even with the repeat cooldown disabled', async () => {
  const f = fixture();
  f.deps.currentId = exact.id;
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).outcome, 'already-queued');
});

test('cooldown off does not invent a two-hour exclusion', async () => {
  const f = fixture();
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).outcome, 'matched');
});

test('a four-hour eligibility set skips recent artist tracks before choosing', async () => {
  const f = fixture();
  f.deps.recentIds.add(exact.id);
  assert.equal((await resolveDirectRequest({ artist: 'Queen' }, f.deps)).track?.id, other.id);
});

test('compilation song artists are resolved without an artist-album index', async () => {
  const f = fixture({ resolveArtist: async () => null });
  assert.equal((await resolveDirectRequest({ artist: 'Queen' }, f.deps)).outcome, 'matched');
});

test('a non-Latin artist resolves through catalogue search when artist lookup finds nothing', async () => {
  // Shared artist resolution folds to ASCII, so it misses "Кино"; the
  // request's own identity check keeps every script.
  const song = { id: 'kino', title: 'Группа крови', artist: 'Кино' };
  const f = fixture({ resolveArtist: async () => null, searchPage: async () => ({ songs: [filler, song], rawCount: 2 }) });
  const r = await resolveDirectRequest({ artist: 'Кино' }, f.deps);
  assert.equal(r.track?.id, song.id);
  assert.equal(r.outcome, 'matched');
});

test('a fuzzy artist resolution uses the canonical library name', async () => {
  const song = { ...exact, artist: 'Sikander Kahlon' };
  const f = fixture({ resolveArtist: async () => ({ id: 'a', name: song.artist }), getAlbum: async () => [song] });
  assert.equal((await resolveDirectRequest({ artist: 'Sikandar Kahlon' }, f.deps)).track?.id, exact.id);
});

test('a search hit is rechecked against the resolved artist before the album walk', async () => {
  // The model's "Guns and Roses" misses the library's credit, so the title
  // search's own hit only proves itself once the artist resolves.
  const song = { id: 'scom', title: "Sweet Child o' Mine", artist: "Guns N' Roses", album: 'Appetite for Destruction' };
  const albums = Array.from({ length: 25 }, (_, i) => ({ id: `album-${i}`, name: `Album ${i}` }));
  const f = fixture({
    searchPage: async () => ({ songs: [song], rawCount: 1 }),
    resolveArtist: async () => ({ id: 'gnr', name: "Guns N' Roses" }),
    getArtist: async () => ({ album: albums }),
    getAlbum: async id => [{ id: `t-${id}`, title: `Track on ${id}`, artist: "Guns N' Roses" }],
  });
  const r = await resolveDirectRequest({ title: song.title, artist: 'Guns and Roses', search_terms: [song.title] }, f.deps);
  assert.equal(r.track?.id, song.id);
  assert.equal(r.outcome, 'matched');
  assert.deepEqual(f.albums, []);
});

test('artist, genre and language requirements are combined before a broad pick', async () => {
  const wanted = { ...other, id: 'wanted', language: 'French', moods: ['calm'] };
  const f = fixture({ getAlbum: async () => [exact, other, wanted] });
  const r = await resolveDirectRequest({ artist: 'Queen', genre: 'Jazz', language: 'French', mood: 'calm' }, f.deps);
  assert.equal(r.track?.id, 'wanted');
  assert.equal(r.outcome, 'matched');
});

test('unverified language text matches do not masquerade as a language match', async () => {
  const f = fixture({ resolveGenreName: async () => null });
  const r = await resolveDirectRequest({ language: 'French', search_terms: [] }, f.deps);
  assert.equal(r.outcome, 'no-match');
  assert.equal(r.track, null);
});

test('mood preference ranks matching artist tracks without dropping the artist', async () => {
  const calm = { ...other, moods: ['calm'] };
  const f = fixture({ getAlbum: async () => [exact, calm] });
  assert.equal((await resolveDirectRequest({ artist: 'Queen', mood: 'calm' }, f.deps)).track?.id, other.id);
});

test('artist mood preferences reach later albums and local mood metadata', async () => {
  const f = fixture();
  f.deps.moodSongs = async () => [other];
  const result = await resolveDirectRequest({ artist: 'Queen', mood: 'calm' }, f.deps);
  assert.equal(result.track?.id, other.id);
  assert.deepEqual(f.albums, ['old', 'new']);
});

test('popular uses evidence from top songs rather than arbitrary album order', async () => {
  const f = fixture();
  const r = await resolveDirectRequest({ artist: 'Queen', sort: 'popular' }, f.deps);
  assert.equal(r.track?.id, other.id);
  assert.equal(r.source, 'artist-popular');
});

test('a guessed popular sort does not relabel a named song found on an album', async () => {
  const f = fixture({ searchPage: async () => ({ songs: [], rawCount: 0 }) });
  const r = await resolveDirectRequest({ ...songRequest, sort: 'popular' }, f.deps);
  assert.equal(r.track?.id, exact.id);
  assert.equal(r.outcome, 'matched');
});

test('latest release uses precise dates on a chronological scale', async () => {
  assert.ok(requestReleaseRank({ originalReleaseDate: { year: 2020 } }) > requestReleaseRank({ releaseDate: '2019-12-31' }));
  assert.ok(requestReleaseRank({ releaseDate: '2020-02-01' }) > requestReleaseRank({ year: 2020 }));
  const f = fixture();
  assert.equal((await resolveDirectRequest({ artist: 'Queen', sort: 'latest' }, f.deps)).track?.id, other.id);
});

test('latest song ranks recordings rather than the import/reissue album order', async () => {
  const f = fixture({ getAlbum: async id => id === 'new' ? [{ ...other, year: 1960 }] : [{ ...exact, year: 1975 }] });
  assert.equal((await resolveDirectRequest({ artist: 'Queen', sort: 'latest', scope: 'song' }, f.deps)).track?.id, exact.id);
});

test('undated releases do not precede known years in an oldest request', async () => {
  const f = fixture({ getArtist: async () => ({ album: [{ id: 'undated' }, { id: 'old', year: 1975 }] }),
    getAlbum: async id => id === 'old' ? [exact] : [other] });
  assert.equal((await resolveDirectRequest({ artist: 'Queen', sort: 'oldest', scope: 'album' }, f.deps)).track?.id, exact.id);
});

test('fallback sources cannot enqueue a queued, playing or recent filler', async () => {
  const f = fixture({ searchPage: async () => ({ songs: [], rawCount: 0 }), resolveArtist: async () => null });
  f.deps.queuedIds.add(filler.id);
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).track, null);
});

test('an unavailable mood database does not affect an exact catalogue match', async () => {
  const f = fixture();
  f.deps.moodSongs = async () => { throw Error('database unavailable'); };
  assert.equal((await resolveDirectRequest(songRequest, f.deps)).track?.id, exact.id);
});

test('source failures produce a diagnosable no-match instead of throwing', async () => {
  const f = fixture({ searchPage: async () => { throw Error('search failed'); }, resolveArtist: async () => { throw Error('artist failed'); } });
  f.deps.fallbackSongs = async () => { throw Error('fallback failed'); };
  const r = await resolveDirectRequest(songRequest, f.deps);
  assert.equal(r.track, null);
  assert.equal(r.source, 'lookup-error');
  assert.equal(r.errors.length, 3);
});

test('a mastering suffix is accepted but different performances are distinct', () => {
  assert.ok(requestTitleMatches('Bohemian Rhapsody', 'Bohemian Rhapsody - Remastered 2011'));
  assert.ok(requestTitleMatches('Bohemian Rhapsody', 'Bohemian Rhapsody (2011 Remaster)'));
  assert.ok(!requestTitleMatches('Bohemian Rhapsody', 'Bohemian Rhapsody (Live)'));
  assert.ok(!requestTitleMatches('Bohemian Rhapsody', 'Bohemian Rhapsody (Remix)'));
  assert.ok(!requestTitleMatches('Bohemian Rhapsody (2011 Remaster)', 'Bohemian Rhapsody (2020 Remaster)'));
  assert.ok(!requestTitleMatches('Bohemian Rhapsody (2011 Remaster)', 'Bohemian Rhapsody'));
});

test('featured credits and edition labels fold, but a requested edition stays strict', () => {
  assert.ok(requestTitleMatches('Bohemian Rhapsody', 'Bohemian Rhapsody (Remastered Version)'));
  assert.ok(requestTitleMatches('Song', 'Song (Explicit Version)'));
  assert.ok(requestTitleMatches('Empire State of Mind', 'Empire State of Mind feat. Alicia Keys'));
  assert.ok(requestTitleMatches('Empire State of Mind (feat. Alicia Keys)', 'Empire State of Mind'));
  assert.ok(requestTitleMatches('Empire State of Mind (feat. Alicia Keys)', 'Empire State of Mind - Radio Edit'));
  assert.ok(!requestTitleMatches('Song (Radio Edit)', 'Song'));
  assert.ok(!requestTitleMatches('Song (Radio Edit) (feat. X)', 'Song (Album Version)'));
  assert.ok(!requestTitleMatches('The', 'The Feat of Clay'));
});

test('a literal "Title - Artist" is read the other way round only on catalogue proof', async () => {
  const song = { id: 'och', title: 'One Crowded Hour', artist: 'Augie March', album: 'Moo, You Bloody Choir' };
  const literal = { ...modelFreeRequest('One Crowded Hour - Augie March'), literal: true };
  assert.equal(literal.reversible, true);
  const f = fixture({
    searchPage: async query => ({ songs: /crowded/i.test(query) ? [song] : [filler], rawCount: 1 }),
    resolveArtist: async () => null,
  });
  const r = await resolveDirectRequest(literal, f.deps);
  assert.equal(r.track?.id, song.id);
  assert.equal(r.outcome, 'matched');
  // A "by" form says which side is which, so it is never swapped.
  assert.equal(modelFreeRequest('Augie March by One Crowded Hour').reversible, false);
});

for (const [want, got, matches] of [
  ['The Beatles', 'The Gathering', false], ['Beyonce', 'Beyoncé', true],
  ['宇多田ヒカル', '宇多田ヒカル', true], ['Queen', 'Queen Latifah', false],
  ['Queen', 'Queen feat. David Bowie', true], ["Guns N’ Roses", "Guns N' Roses", true],
  ['क', 'की', false], ['Beatles', 'The Beatles', true], ['Queen', 'Queen (feat. David Bowie)', true],
  ['Fire', 'Earth, Wind & Fire', false], ['Sons', 'Mumford & Sons', false], ['Machine', 'Florence + the Machine', false],
  ['David Bowie', 'Queen & David Bowie', false],
] as const) test(`artist identity ${want} / ${got}`, () => assert.equal(requestArtistMatches(want, { id: 't', artist: got }), matches));

test('a collaboration names each act through the per-artist credits, never by splitting on "&"', () => {
  const song = { id: 't', artist: 'Queen & David Bowie', artists: [{ name: 'Queen' }, { name: 'David Bowie' }] };
  assert.ok(requestArtistMatches('David Bowie', song));
  assert.ok(requestArtistMatches('Queen', song));
  assert.ok(requestArtistMatches('Queen & David Bowie', song));
});

for (const text of ['Queen, Bohemian Rhapsody', 'Please play Bohemian Rhapsody by Queen', 'Could you play Bohemian Rhapsody by Queen?']) {
  test(`model-free recovery: ${text}`, () => {
    const r = modelFreeRequest(text);
    assert.equal(r.artist, 'Queen');
    assert.equal(r.title, exact.title);
  });
}
test('model-free artist requests do not invent a song title', () => {
  assert.equal(modelFreeRequest('play some Queen').artist, 'Queen');
  assert.equal(modelFreeRequest('play anything by Queen').title, null);
});


test('quoted spans cannot prove an unrelated title and search-term order cannot hide a real one', () => {
  const plan = { title: null, artist: 'Queen', genre: 'rock', search_terms: ['Killer Queen'] };
  assert.equal(requestedTitle(plan, 'Play "Bohemian Rhapsody"'), null);
  assert.equal(requestedTitle({ ...plan, search_terms: ['Rhapsody'] }, 'Play "Bohemian Rhapsody"'), null);
  assert.equal(requestedTitle({ ...plan, search_terms: ['Play'] }, 'Play "Bohemian Rhapsody"'), null);
  assert.equal(requestedTitle({ ...plan, search_terms: ['Killer Queen', 'Bohemian Rhapsody'] },
    'Play Bohemian Rhapsody'), 'Bohemian Rhapsody');
});

test('a quoted title is the quoted span alone, never the words after it', () => {
  const plan = { title: null, artist: 'Queen', search_terms: ['Killer Queen'] };
  for (const text of ['Play "Bohemian Rhapsody" next', 'Play “Bohemian Rhapsody” for my mum', 'could you play ‘Bohemian Rhapsody’ again',
    'play "Bohemian Rhapsody" from Queen', '"Bohemian Rhapsody" please DJ', 'please "Bohemian Rhapsody" now',
    'can you please "Bohemian Rhapsody"']) {
    assert.equal(repairRequestMatch(plan, text).title, 'Bohemian Rhapsody', text);
  }
  assert.equal(repairRequestMatch(plan, 'Play ""').title, null);
});

test('a recovered literal title drops what follows the name, never a recording\'s own words', () => {
  const plan = { title: null, artist: 'Queen', search_terms: ['Bohemian Rhapsody', 'Queen'] };
  for (const text of ['Queen, Bohemian Rhapsody for my mum', 'Bohemian Rhapsody for my mum - Queen',
    'Queen - Bohemian Rhapsody please DJ', 'Queen, Bohemian Rhapsody, it is my birthday']) {
    assert.equal(repairRequestMatch(plan, text).title, 'Bohemian Rhapsody', text);
  }
  for (const title of ['Bohemian Rhapsody (Live)', 'Bohemian Rhapsody - Live at Wembley', 'Bohemian Rhapsody Part 2']) {
    assert.equal(repairRequestMatch(plan, `Queen - ${title}`).title, title);
  }
});

test('quoted artist names, lyrics and self-introductions are not repaired into song titles', () => {
  const plan = { title: null, artist: 'Queen', genre: 'rock', search_terms: ['Queen'] };
  for (const text of ['Play "Queen"', 'Play the song with the lyrics "a fictional line"', 'I am "Mara Vale", play Queen']) {
    assert.equal(repairRequestMatch(plan, text).title, null, text);
  }
});


test('with no artist in the reading, another named term must be the artist of a term searched as a title', async () => {
  const otherQueen = { id: 'other-queen', title: 'Queen', artist: 'Perfume Genius', genre: 'Rock' };
  const f = fixture({ searchPage: async query => ({ songs: query === 'Queen' ? [otherQueen] : [], rawCount: 1 }) });
  const r = await resolveDirectRequest({ title: null, artist: null, genre: 'rock', mood: 'celebratory', search_terms: ['Bohemian Rhapsody', 'Queen'] },
    { ...f.deps, text: 'Queen, Bohemian Rhapsody' });
  assert.notEqual(r.track?.id, otherQueen.id);
  assert.equal(r.outcome, 'substituted');
});

test('an artist spelt without its "The" is not a song title beside a guessed mood', async () => {
  const beatles = { id: 'beatles-song', title: 'Here Comes the Sun', artist: 'The Beatles' };
  const f = fixture({ resolveArtist: async () => ({ id: 'beatles', name: 'The Beatles' }), getArtist: async () => ({ album: [{ id: 'abbey-road' }] }),
    getAlbum: async () => [beatles] });
  const r = await resolveDirectRequest({ title: null, artist: 'The Beatles', mood: 'celebratory', search_terms: ['Beatles'] },
    { ...f.deps, text: 'play some Beatles for my birthday' });
  assert.equal(r.track?.id, beatles.id);
  assert.equal(r.outcome, 'matched');
});

test('punctuation-only identities stay distinct and survive literal parsing', () => {
  assert.equal(requestArtistMatches('!!!', { id: 'other', artist: 'Queen' }), false);
  assert.ok(requestArtistMatches('!!!', { id: 'wanted', artist: '!!!' }));
  assert.equal(requestTitleMatches('?', '!!!'), false);
  assert.ok(requestTitleMatches('?', '?'));
  assert.equal(repairRequestMatch({ title: null, artist: 'OutKast' }, 'Play "?"').title, '?');
  assert.equal(modelFreeRequest('The Roots, !!!!!!!').title, '!!!!!!!');
  assert.equal(modelFreeRequest('Normal People - !!!').title, '!!!');
  assert.equal(modelFreeRequest('Normal People by !!!').artist, '!!!');
});
