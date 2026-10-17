import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directRequestUnsupported, modelFreeRequest, requestArtistMatches, requestReleaseRank, requestTitleMatches,
  resolveDirectRequest, type RequestCatalog, type RequestMatch, type RequestSong,
} from '../src/music/request-match.js';

const exact: RequestSong = { id: 'exact', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', genre: 'Rock' };
const other: RequestSong = { id: 'other', title: 'Another Song', artist: 'Queen', album: 'Other Album', genre: 'Jazz' };
const filler: RequestSong = { id: 'filler', title: 'Fatigue', artist: 'The Gathering', genre: 'Rock' };
const songRequest: RequestMatch = { title: exact.title, artist: 'Queen', search_terms: [exact.title!, 'Queen'], scope: 'song' };

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

test('literal recovery cannot reinterpret unparsed artist conditions through fuzzy resolution', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ ...songRequest, artist: 'Queen in French', literal: true }, f.deps);
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
  assert.deepEqual(f.albums, []);
  assert.equal(f.fallbackCalls(), 0);
});

test('literal recovery does not substitute for an unverified title', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ title: 'Bohemian Rhapsody in French', artist: 'Queen', literal: true }, f.deps);
  assert.equal(result.track, null);
  assert.equal(result.outcome, 'no-match');
  assert.equal(f.fallbackCalls(), 0);
});

test('an unmet artist mood preference is an explicit compromise', async () => {
  const f = fixture();
  const result = await resolveDirectRequest({ artist: 'Queen', mood: 'calm' }, f.deps);
  assert.equal(result.track?.artist, 'Queen');
  assert.equal(result.outcome, 'substituted');
  assert.deepEqual(result.unmetPreferences, ['mood']);
});

test('a named recording stays selected when its mood cannot be verified', async () => {
  const f = fixture();
  f.deps.moodSongs = async () => { throw Error('mood database unavailable'); };
  const result = await resolveDirectRequest({ ...songRequest, mood: 'calm' }, f.deps);
  assert.equal(result.track?.id, exact.id);
  assert.equal(result.outcome, 'substituted');
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

test('a fuzzy artist resolution uses the canonical library name', async () => {
  const song = { ...exact, artist: 'Sikander Kahlon' };
  const f = fixture({ resolveArtist: async () => ({ id: 'a', name: song.artist }), getAlbum: async () => [song] });
  assert.equal((await resolveDirectRequest({ artist: 'Sikandar Kahlon' }, f.deps)).track?.id, exact.id);
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

for (const [want, got, matches] of [
  ['The Beatles', 'The Gathering', false], ['Beyonce', 'Beyoncé', true],
  ['宇多田ヒカル', '宇多田ヒカル', true], ['Queen', 'Queen Latifah', false],
  ['Queen', 'Queen feat. David Bowie', true], ["Guns N’ Roses", "Guns N' Roses", true],
  ['क', 'की', false],
] as const) test(`artist identity ${want} / ${got}`, () => assert.equal(requestArtistMatches(want, { id: 't', artist: got }), matches));

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
