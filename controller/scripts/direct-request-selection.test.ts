import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyListenerRequest, directRequestUnsupported, explicitRequestAttribute, isFramedTitleOnlyRequest, isGenericRequestPhrase, isGreetingLikeRequest, isLyricOrFilmDescription, looksLikeLyricRequest, modelFreeRequest, requestedTitle, rankRequestCandidates, repairRequestMatch, requestArtistMatches, requestCandidateArtistMatches, requestReleaseRank, requestTitleMatches,
  resolveDirectRequest, type RequestCatalog, type RequestMatch, type RequestSong,
} from '../src/music/request-match.js';

test('listener requests are classified into deterministic resolver lanes', () => {
  assert.equal(classifyListenerRequest('Bohemian Rhapsody by Queen'), 'named-song-or-artist');
  assert.equal(classifyListenerRequest('the song from the new Dune movie'), 'lyrics-or-description');
  assert.equal(classifyListenerRequest('play some music in Punjabi'), 'attributes');
  assert.equal(classifyListenerRequest('play energetic Punjabi rock'), 'attributes');
  assert.equal(classifyListenerRequest('surprise me'), 'ambiguous-music');
  assert.equal(classifyListenerRequest('how are you today?'), 'non-music-chat');
});

test('language-plus-genre requests keep both deterministic constraints', () => {
  const match = modelFreeRequest('play some rock music in Punjabi');
  assert.equal(match.genre, 'rock');
  assert.equal(match.language, 'Punjabi');
  assert.equal(match.artist, null);
  assert.equal(match.title, null);
});

test('film evidence keeps the in form without capturing language requests', () => {
  assert.equal(isLyricOrFilmDescription('play song in Dune'), true);
  assert.equal(isLyricOrFilmDescription('play some music in Punjabi'), false);
});

test('greeting matching handles normalized apostrophes', () => {
  assert.equal(isGreetingLikeRequest("what's up"), true);
});

test('generic request phrases are centralized with greeting matching', () => {
  assert.equal(isGenericRequestPhrase('surprise me'), true);
  assert.equal(isGenericRequestPhrase('play something for the evening'), false);
});

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

test('title words such as with no do not become an exclusion', async () => {
  const wanted = { id: 'horse', title: 'A Horse with No Name', artist: 'America' };
  const parsed = modelFreeRequest('play A Horse with No Name by America');
  const f = fixture({
    searchPage: async query => query === wanted.title ? { songs: [wanted], rawCount: 1 } : { songs: [], rawCount: 0 },
  });
  const result = await resolveDirectRequest(parsed, {
    ...f.deps,
    text: 'play A Horse with No Name by America',
    exactOnly: true,
  });
  assert.equal(result.track?.id, wanted.id);
  assert.equal(result.outcome, 'matched');
});

test('an explicit missing artist does not fall through to unrelated music', async () => {
  const f = fixture({
    searchPage: async () => ({ songs: [], rawCount: 0 }),
    resolveArtist: async () => null,
  });
  const result = await resolveDirectRequest(
    { artist: 'Missing Artist', scope: 'song' },
    { ...f.deps, text: 'play a song by Missing Artist', exactOnly: true },
  );
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
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

test('a generic language request uses the local language pool instead of the genre index', async () => {
  const punjabi = { ...filler, id: 'punjabi', title: 'Punjabi Track', language: 'pan', languages: ['pan'] };
  const f = fixture({ getSongsByGenreSampled: async () => [] });
  const result = await resolveDirectRequest({ language: 'Punjabi', scope: 'song' }, {
    ...f.deps,
    languageSongs: async language => language === 'pan' ? [punjabi] : [],
  });
  assert.equal(result.track?.id, punjabi.id);
  assert.equal(result.source, 'language-library');
  assert.equal(result.outcome, 'matched');
});

test('spoken number variants match the named recording without widening the artist', async () => {
  const patient = { ...exact, id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift' };
  const f = fixture({
    searchPage: async query => ({
      songs: query === 'patient 0' ? [patient] : [],
      rawCount: query === 'patient 0' ? 1 : 0,
    }),
  });
  const result = await resolveDirectRequest(
    { title: 'patient 0', artist: 'Taylor Swift', literal: true },
    { ...f.deps, text: 'patient 0 by Taylor swift', exactOnly: true },
  );
  assert.equal(result.track?.id, patient.id);
  assert.equal(result.outcome, 'matched');
  assert.equal(f.fallbackCalls(), 0);
});

test('spoken number variants are searched in both directions', async () => {
  const patient = { ...exact, id: 'patient-zero', title: 'Patient Zero', artist: 'Taylor Swift' };
  const queries: string[] = [];
  const f = fixture({
    searchPage: async query => {
      queries.push(query);
      return query === 'patient zero' ? { songs: [patient], rawCount: 1 } : { songs: [], rawCount: 0 };
    },
  });
  const result = await resolveDirectRequest(
    { title: 'patient 0', artist: 'Taylor Swift', literal: true },
    { ...f.deps, text: 'patient 0 by Taylor swift', exactOnly: true },
  );
  assert.equal(result.track?.id, patient.id);
  assert.ok(queries.includes('patient zero'));
});

test('exact-only named requests never fall back to another track', async () => {
  const f = fixture({ searchPage: async () => ({ songs: [], rawCount: 0 }) });
  const result = await resolveDirectRequest(
    { title: 'Missing Song', artist: 'Queen', literal: true },
    { ...f.deps, text: 'Missing Song by Queen', exactOnly: true },
  );
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
  assert.equal(f.fallbackCalls(), 0);
  assert.deepEqual(f.albums, ['old', 'new']);
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

test('a Punjabi genre tag can satisfy the overlapping Punjabi language request', async () => {
  const punjabi = { ...filler, id: 'punjabi-pop', genre: 'Punjabi Pop', language: 'pa' };
  const f = fixture({
    getGenres: async () => [{ value: 'Punjabi Pop', songCount: 1 }],
    getSongsByGenreSampled: async () => [punjabi],
  });
  const r = await resolveDirectRequest(
    { genre: 'Punjabi', language: 'Punjabi' },
    { ...f.deps, text: 'play some Punjabi music' },
  );
  assert.equal(r.track?.id, punjabi.id);
  assert.equal(r.outcome, 'matched');
});

test('language metadata satisfies an overlapping language-style genre without a genre tag', async () => {
  const punjabi = { ...filler, id: 'punjabi-language', genre: undefined, language: 'pan', languages: ['pan'] };
  const f = fixture({
    getGenres: async () => [],
    getSongsByGenreSampled: async () => [],
  });
  const r = await resolveDirectRequest(
    { genre: 'Punjabi', language: 'Punjabi' },
    { ...f.deps, text: 'play some Punjabi music', languageSongs: async () => [punjabi] },
  );
  assert.equal(r.track?.id, punjabi.id);
  assert.equal(r.outcome, 'matched');
});

test('an untagged genre can use explicit title or album evidence from local search', async () => {
  const punjabi = { ...filler, id: 'punjabi-title', title: 'Punjabi Wedding Song', album: 'Hasee Toh Phasee' };
  const f = fixture({
    getGenres: async () => [],
    getSongsByGenreSampled: async () => [],
    searchPage: async query => /punjabi/i.test(query) ? { songs: [punjabi], rawCount: 1 } : { songs: [], rawCount: 0 },
  });
  const r = await resolveDirectRequest(
    { genre: 'Punjabi', language: 'Punjabi', scope: 'song' },
    { ...f.deps, text: 'play some Punjabi music' },
  );
  assert.equal(r.track, null);
  assert.equal(r.outcome, 'no-match');
});

test('a named Punjabi recording can use Punjabi genre metadata when language metadata is an ISO code', async () => {
  const punjabi = { ...exact, id: 'punjabi-named', title: 'Punjabi Song', artist: 'Punjabi Artist', genre: 'Punjabi Pop', language: 'pa' };
  const f = fixture({
    searchPage: async () => ({ songs: [punjabi], rawCount: 1 }),
    resolveArtist: async () => ({ id: 'punjabi-artist', name: punjabi.artist }),
    getGenres: async () => [{ value: 'Punjabi Pop', songCount: 1 }],
    getSongsByGenreSampled: async () => [punjabi],
  });
  const r = await resolveDirectRequest(
    { title: punjabi.title, artist: punjabi.artist, language: 'Punjabi', search_terms: [punjabi.title] },
    { ...f.deps, text: `play ${punjabi.title} by ${punjabi.artist} in Punjabi` },
  );
  assert.equal(r.track?.id, punjabi.id);
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

test('harmless film and single labels fold in the generic candidate verifier', () => {
  assert.ok(requestTitleMatches('Preet Re', 'Preet Re (From "Dhadak 2")'));
  assert.ok(requestTitleMatches('Preet Re', 'Preet Re - Single'));
  assert.ok(!requestTitleMatches('Preet Re', 'Preet Re (Live)'));
});

test('generic candidate artist verification matches a primary act inside composite credits', () => {
  const song = {
    id: 'preet-good',
    title: 'Preet Re (From "Dhadak 2")',
    artist: 'Darshan Raval / Rochak Kohli / Jonita Gandhi / Gurpreet Saini',
    artists: [
      { name: 'Darshan Raval' }, { name: 'Rochak Kohli' },
      { name: 'Jonita Gandhi' }, { name: 'Gurpreet Saini' },
    ],
  };
  assert.ok(requestCandidateArtistMatches('Rochak Kohli', song));
  assert.ok(requestCandidateArtistMatches('Jonita Gandhi', { ...song, artist: 'Darshan Raval & Jonita Gandhi', artists: [{ name: 'Darshan Raval' }, { name: 'Jonita Gandhi' }] }));
  assert.ok(requestCandidateArtistMatches('Rochak Kohli', { ...song, artist: 'Darshan Raval, feat. Rochak Kohli', artists: [{ name: 'Darshan Raval' }, { name: 'Rochak Kohli' }] }));
  assert.ok(requestCandidateArtistMatches('Rochak Kohli', { ...song, artists: undefined }));
  assert.equal(requestCandidateArtistMatches('Other Artist', song), false);
});

test('candidate ranking can use lyric overlap when the local title is an alias', () => {
  const ranked = rankRequestCandidates('Chitte Suit Te', 'Geeta Zaildar', [{
    id: 'white-suit', title: 'White Suit', artist: 'Geeta Zaildar',
    lyricExcerpt: 'chitte suit te daag pai gaye gali teri vich gara',
  }], { lyricText: 'chitte suit te daag pai gaye gali teri vich gara' });
  assert.equal(ranked[0]?.song.id, 'white-suit');
  assert.ok((ranked[0]?.lyricOverlap || 0) >= 0.8);
});

test('web evidence never proves a different local title by the same artist', () => {
  const one = { id: 'u2-one', title: 'One', artist: 'U2' };
  assert.deepEqual(rankRequestCandidates('Someone Like Me', 'U2', [one], { webText: 'U2 - Someone Like Me Lyrics' }), []);
  const yellow = { id: 'yellow', title: 'Yellow', artist: 'Coldplay' };
  const viva = { id: 'viva', title: 'Viva la Vida', artist: 'Coldplay' };
  const webText = 'Coldplay - Viva la Vida Lyrics. Other Coldplay songs: Yellow, Fix You.';
  assert.deepEqual(rankRequestCandidates('Viva la Vida', 'Coldplay', [yellow], { webText }), []);
  assert.deepEqual(rankRequestCandidates('Viva la Vida', 'Coldplay', [yellow, viva], { webText }).map(row => row.song.id), ['viva']);
});

test('direct requests select decorated Preet Re from a composite credit over a title collision', async () => {
  const good = {
    id: 'preet-good',
    title: 'Preet Re (From "Dhadak 2")',
    artist: 'Darshan Raval / Rochak Kohli / Jonita Gandhi / Gurpreet Saini',
    artists: [
      { name: 'Darshan Raval' }, { name: 'Rochak Kohli' },
      { name: 'Jonita Gandhi' }, { name: 'Gurpreet Saini' },
    ],
  };
  const collision = { id: 'preet-wrong', title: 'Preet Re', artist: 'Other Artist' };
  const f = fixture({
    searchPage: async () => ({ songs: [collision, good], rawCount: 2 }),
    resolveArtist: async () => ({ id: 'rochak', name: 'Rochak Kohli' }),
  });
  const result = await resolveDirectRequest({ title: 'Preet Re', artist: 'Rochak Kohli', search_terms: ['Preet Re', 'Rochak Kohli'], scope: 'song' }, f.deps);
  assert.equal(result.track?.id, good.id);
  assert.equal(result.outcome, 'matched');
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
  assert.equal(modelFreeRequest('play the song by Taylor Swift').title, null);
  assert.equal(modelFreeRequest('play the song by Taylor Swift').artist, 'Taylor Swift');
});

test('model-free requests recognise multilingual language, genre, and mood forms', () => {
  assert.equal(modelFreeRequest('play some Punjabi music').genre, null);
  assert.equal(modelFreeRequest('play some Punjabi music').language, 'Punjabi');
  assert.equal(modelFreeRequest('play some rock music').genre, 'rock');
  assert.equal(modelFreeRequest('play something chill').mood, 'calm');
  assert.equal(modelFreeRequest('कुछ शांत संगीत बजाओ').mood, 'calm');
  assert.equal(modelFreeRequest('ਪੰਜਾਬੀ ਸੰਗੀਤ ਚਲਾਓ').language, 'Punjabi');
});

test('model-free language and genre attributes are order-independent and owned once', () => {
  for (const text of ['play Punjabi pop music', 'play pop Punjabi music', 'play pop music in Punjabi']) {
    const match = modelFreeRequest(text);
    assert.equal(match.language, 'Punjabi', text);
    assert.equal(match.genre, 'pop', text);
    assert.deepEqual(match.search_terms, [], text);
    assert.equal(looksLikeLyricRequest(text), false, text);
    assert.equal(isLyricOrFilmDescription(text), false, text);
  }
  const languageOnly = modelFreeRequest('play Punjabi song');
  assert.equal(languageOnly.language, 'Punjabi');
  assert.equal(languageOnly.genre, null);

  const localized = modelFreeRequest('play música en español');
  assert.equal(localized.language, 'Spanish');
  assert.equal(localized.title, null);

  const unresolved = modelFreeRequest('play music in Pungabix');
  assert.equal(unresolved.language, null);
  assert.equal(unresolved.unresolvedLanguage, 'Pungabix');
});

test('language aliases, endonyms, and bounded typos resolve without genre evidence', () => {
  for (const text of ['play Panjabi music', 'play ਪੰਜਾਬੀ music', 'play Hindii music']) {
    const match = modelFreeRequest(text);
    assert.ok(match.language, text);
    assert.equal(match.genre, null, text);
  }
  const title = modelFreeRequest('play Spanish Eyes');
  assert.equal(title.language, null);
  assert.equal(title.title, 'Spanish Eyes');
});

test('era remains a soft preference alongside language', () => {
  const match = modelFreeRequest('play music from the 1990s in Hindi');
  assert.equal(match.language, 'Hindi');
  assert.deepEqual(match.era, { from: 1990, to: 1999, label: '1990s' });
  assert.equal(isLyricOrFilmDescription('play music from the 1990s in Hindi'), false);
  assert.equal(isLyricOrFilmDescription('play Punjabi music from the 2000s'), false);
});

test('from remains part of a title unless a generic artist frame owns it', () => {
  const named = modelFreeRequest('Letter from America by The Proclaimers');
  assert.equal(named.title, 'Letter from America');
  assert.equal(named.artist, 'The Proclaimers');
  const titleOnly = modelFreeRequest('play Postcards from Italy');
  assert.equal(titleOnly.title, 'Postcards from Italy');
  assert.equal(titleOnly.artist, null);
  assert.equal(modelFreeRequest('play a song from The Proclaimers').artist, 'The Proclaimers');
});

test('a two-letter ISO code is a title word, not language evidence', () => {
  for (const text of ['play Rock It', 'play Folk It', 'Play It']) {
    const match = modelFreeRequest(text);
    assert.equal(match.title, text.replace(/^play\s+/iu, ''), text);
    assert.equal(match.genre, null, text);
    assert.equal(match.language, null, text);
  }
  assert.equal(modelFreeRequest('play rock in Italian').language, 'Italian');
});

test('free-form title words do not become a genre or mood plan', () => {
  const match = modelFreeRequest('I wanna dance with somebody who loves me');
  assert.equal(match.title, 'I wanna dance with somebody who loves me');
  assert.equal(match.genre, null);
  assert.equal(match.mood, null);
});

test('model-free requests retain combined genre and language constraints', () => {
  const rockPunjabi = modelFreeRequest('play some rock in Punjabi');
  assert.equal(rockPunjabi.genre, 'rock');
  assert.equal(rockPunjabi.language, 'Punjabi');
});

test('model-free requests recognise album framing', () => {
  const match = modelFreeRequest('play the album Fearless');
  assert.equal(match.album, 'Fearless');
  assert.equal(match.scope, 'album');
  assert.deepEqual(match.search_terms, ['Fearless']);
});

test('short transliterated lyric prose is routed to evidence resolution', () => {
  assert.equal(looksLikeLyricRequest('chite suit te daag pai gaye gali teri vich gara'), true);
  assert.equal(looksLikeLyricRequest('gali teri vich gara'), true);
  assert.equal(looksLikeLyricRequest('mujhe chhod ke mat jaana'), true);
  assert.equal(looksLikeLyricRequest('The Ballad of the Lonesome Cowboy, Ennio Morricone'), false);
  assert.equal(looksLikeLyricRequest('play something energetic in Punjabi'), false);
  assert.equal(looksLikeLyricRequest('君の名前を呼んでいる'), true);
  assert.equal(isFramedTitleOnlyRequest('play 君の名前を呼んでいる', modelFreeRequest('play 君の名前を呼んでいる')), false);
});

test('model interpretation cannot erase combined deterministic conditions', () => {
  const repaired = repairRequestMatch(
    { kind: 'track', genre: 'rock', title: null, artist: null },
    'play something rock in Punjabi',
  );
  assert.equal(repaired.genre, 'rock');
  assert.equal(repaired.language, 'Punjabi');
});

test('a high-confidence title typo can resolve through a bounded fuzzy search', async () => {
  const wanted = { id: 'soni', title: 'Soni De Nakhre', artist: 'Pritam', genre: 'Punjabi' };
  const f = fixture({
    searchPage: async query => ({ songs: /soni|nakhre|nakhree|pritam/i.test(query) ? [wanted] : [], rawCount: 1 }),
  });
  const result = await resolveDirectRequest(
    { title: 'Soni De Nakhree', artist: 'Pritam', search_terms: ['Soni De Nakhree', 'Pritam'], scope: 'song' },
    { ...f.deps, exactOnly: true },
  );
  assert.equal(result.track?.id, wanted.id);
  assert.equal(result.outcome, 'matched');
  assert.ok((result.confidence || 0) >= 0.92);
});

test('ambiguous fuzzy title matching returns alternatives instead of guessing', async () => {
  const first = { id: 'one', title: 'Hello', artist: 'Adele' };
  const second = { id: 'two', title: 'Hello', artist: 'Lionel Richie' };
  const f = fixture({ searchPage: async () => ({ songs: [first, second], rawCount: 2 }) });
  const result = await resolveDirectRequest(
    { title: 'Helo', artist: null, search_terms: ['Helo'], scope: 'song' },
    { ...f.deps, exactOnly: true },
  );
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
  assert.equal(result.alternatives?.length, 2);
});

for (const typo of ['choor bazari', 'chhor bazari']) {
  test(`a multi-word title typo uses local fuzzy candidates without fallback: ${typo}`, async () => {
    const wanted = { id: 'chor-bazaari', title: 'Chor Bazaari', artist: 'Sunidhi Chauhan & Neeraj Shridhar' };
    const f = fixture({
      searchPage: async () => ({ songs: [], rawCount: 0 }),
      fuzzySearch: async () => [wanted],
    });
    const result = await resolveDirectRequest(
      { title: typo, artist: null, search_terms: [typo], scope: 'song' },
      { ...f.deps, exactOnly: true },
    );
    assert.equal(result.track?.id, wanted.id);
    assert.equal(result.outcome, 'matched');
    assert.equal(f.fallbackCalls(), 0);
  });
}

test('a fuzzy title preserves an already-queued verified candidate', async () => {
  const wanted = { id: 'chor-bazaari', title: 'Chor Bazaari', artist: 'Sunidhi Chauhan & Neeraj Shridhar' };
  const f = fixture({
    searchPage: async () => ({ songs: [], rawCount: 0 }),
    fuzzySearch: async () => [wanted],
  });
  f.deps.queuedIds.add(wanted.id);
  const result = await resolveDirectRequest(
    { title: 'choor bazari', artist: null, search_terms: ['choor bazari'], scope: 'song' },
    { ...f.deps, exactOnly: true },
  );
  assert.equal(result.track?.id, wanted.id);
  assert.equal(result.outcome, 'already-queued');
  assert.equal(f.fallbackCalls(), 0);
});

test('same-title local fuzzy collisions remain no-match instead of guessing', async () => {
  const first = { id: 'chor-a', title: 'Chor Bazaari', artist: 'Sunidhi Chauhan & Neeraj Shridhar' };
  const second = { id: 'chor-b', title: 'Chor Bazaari', artist: 'Other Artist' };
  const f = fixture({
    searchPage: async () => ({ songs: [], rawCount: 0 }),
    fuzzySearch: async () => [first, second],
  });
  const result = await resolveDirectRequest(
    { title: 'choor bazari', artist: null, search_terms: ['choor bazari'], scope: 'song' },
    { ...f.deps, exactOnly: true },
  );
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
  assert.equal(result.alternatives?.length, 2);
  assert.equal(f.fallbackCalls(), 0);
});

test('a long lyric beginning with a discourse comma is not an explicit artist-title pair', () => {
  const text = "No, it’s not a bad time at all I heard somebody saying there's trouble in paradise And my lips are sealed tight now";
  const parsed = modelFreeRequest(text);
  assert.equal(parsed.artist, null);
  assert.equal(parsed.title, text);
});

test('explicit by/from titles retain dedication-like words as part of the title', () => {
  for (const [text, title] of [
    ['Looking for the Summer by Chris Rea', 'Looking for the Summer'],
    ['For the First Time by The Script', 'For the First Time'],
    ['Do It for My Baby by Example', 'Do It for My Baby'],
  ]) assert.equal(modelFreeRequest(text).title, title, text);
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

test('from context tries the complete title first and then verifies soundtrack context', async () => {
  const soundtrack = { id: 'tum-hi-ho', title: 'Tum Hi Ho', artist: 'Arijit Singh', album: 'Aashiqui 2' };
  const parsed = modelFreeRequest('play Tum Hi Ho from Aashiqui 2');
  assert.equal(parsed.title, 'Tum Hi Ho from Aashiqui 2');
  assert.deepEqual(parsed.releaseContext, {
    name: 'Aashiqui 2', kind: 'unknown', title: 'Tum Hi Ho', wholeTitle: 'Tum Hi Ho from Aashiqui 2',
  });
  const f = fixture({ searchPage: async query => query === soundtrack.title
    ? { songs: [soundtrack], rawCount: 1 } : { songs: [], rawCount: 0 } });
  const result = await resolveDirectRequest(parsed, { ...f.deps, text: 'play Tum Hi Ho from Aashiqui 2', exactOnly: true });
  assert.equal(result.track?.id, soundtrack.id);
  assert.equal(result.outcome, 'matched');
});

test('a small typo in a unique movie or album context can still be verified locally', async () => {
  const soundtrack = { id: 'sadi-gali', title: 'Sadi Gali', artist: 'Lehmber Hussainpuri', album: 'Tanu Weds Manu' };
  const parsed = modelFreeRequest('play Sadi Gali from Tenu Weds Manu');
  const f = fixture({ searchPage: async query => query === soundtrack.title
    ? { songs: [soundtrack], rawCount: 1 } : { songs: [], rawCount: 0 } });
  const result = await resolveDirectRequest(parsed, {
    ...f.deps,
    text: 'play Sadi Gali from Tenu Weds Manu',
    exactOnly: true,
  });
  assert.equal(result.track?.id, soundtrack.id);
  assert.equal(result.source, 'release-context-fuzzy');
  assert.equal(result.outcome, 'matched');
});

test('fuzzy release context refuses an ambiguous local match', async () => {
  const candidates = [
    { id: 'first', title: 'Sadi Gali', artist: 'Artist One', album: 'Tanu Weds Manu' },
    { id: 'second', title: 'Sadi Gali', artist: 'Artist Two', album: 'Teno Weds Manu' },
  ];
  const parsed = modelFreeRequest('play Sadi Gali from Tenu Weds Manu');
  const f = fixture({ searchPage: async query => query === 'Sadi Gali'
    ? { songs: candidates, rawCount: candidates.length } : { songs: [], rawCount: 0 } });
  const result = await resolveDirectRequest(parsed, {
    ...f.deps,
    text: 'play Sadi Gali from Tenu Weds Manu',
    exactOnly: true,
  });
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
});

test('generic from phrasing can prove an artist without weakening release context', async () => {
  const song = { id: 'bohemian', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' };
  const parsed = modelFreeRequest('play Bohemian Rhapsody from Queen');
  assert.equal(parsed.releaseContext?.kind, 'unknown');
  const f = fixture({
    searchPage: async query => query === 'Bohemian Rhapsody'
      ? { songs: [song], rawCount: 1 }
      : { songs: [], rawCount: 0 },
  });
  const result = await resolveDirectRequest(parsed, { ...f.deps, text: 'play Bohemian Rhapsody from Queen', exactOnly: true });
  assert.equal(result.track?.id, song.id);
  assert.equal(result.source, 'from-artist');
  assert.equal(result.outcome, 'matched');
});

test('a shorter release-context name cannot prove a sequel soundtrack', async () => {
  const sequel = { id: 'aashiqui-2', title: 'Tum Hi Ho', artist: 'Arijit Singh', album: 'Aashiqui 2' };
  const parsed = modelFreeRequest('play Tum Hi Ho from Aashiqui');
  const f = fixture({
    searchPage: async query => query === 'Tum Hi Ho'
      ? { songs: [sequel], rawCount: 1 }
      : { songs: [], rawCount: 0 },
  });
  const result = await resolveDirectRequest(parsed, { ...f.deps, text: 'play Tum Hi Ho from Aashiqui', exactOnly: true });
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
});

test('quoted soundtrack requests cannot substitute an unrelated title', async () => {
  const parsed = modelFreeRequest('play "Agar Tum Saath Ho" from Tamasha');
  const unrelated = { ...other, title: 'Saathiyaa', artist: 'Various', album: 'Tamasha' };
  const f = fixture({ searchPage: async query => query.includes('Agar Tum')
    ? { songs: [unrelated], rawCount: 1 } : { songs: [unrelated], rawCount: 1 } });
  const result = await resolveDirectRequest(parsed, { ...f.deps, text: 'play "Agar Tum Saath Ho" from Tamasha', exactOnly: true });
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
});

test('named similarity verifies its seed and ranks neighbours with audio and tags', async () => {
  const seed = { id: 'seed', title: 'Tum Hi Ho', artist: 'Arijit Singh', genre: 'Bollywood', moods: ['romantic'], energy: 'medium', bpm: 80, musicalKey: '8A' };
  const close = { id: 'close', title: 'Close Song', artist: 'Other Artist', genre: 'Bollywood', moods: ['romantic'], energy: 'medium', bpm: 82, musicalKey: '8A', _similarity: 0.88 };
  const far = { id: 'far', title: 'Far Song', artist: 'Other Artist', genre: 'Jazz', moods: ['calm'], energy: 'low', bpm: 140, musicalKey: '1B', _similarity: 0.30 };
  const parsed = modelFreeRequest('play something like Tum Hi Ho');
  const f = fixture({ searchPage: async query => query === seed.title ? { songs: [seed], rawCount: 1 } : { songs: [], rawCount: 0 } });
  const result = await resolveDirectRequest(parsed, { ...f.deps, exactOnly: true, similarSeedSongs: async () => [far, close] });
  assert.equal(result.track?.id, close.id);
  assert.equal(result.outcome, 'matched');
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
