import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { removeTempDir } from './test-utils/temp-dir.js';

const root = await mkdtemp(join(tmpdir(), 'subwave-episode-source-'));
let albumCalls = 0;
const liveTracks = [
  { id: 'live-one', artistId: 'live', artist: 'Live', title: 'One', duration: 180 },
  { id: 'live-two', artistId: 'live', artist: 'Live', title: 'Two', duration: 180 },
  { id: 'different', artistId: 'another', artist: 'Live Junior', title: 'Other', duration: 180 },
  { id: 'live-collaboration', artistId: 'combined', artist: 'Live & Guest', title: 'Collaboration', duration: 180, albumArtists: [{ id: 'live', name: 'Live' }] },
  { id: 'guest-credit', artistId: 'another', artist: 'Another & Live', title: 'Guest', duration: 180, artists: [{ id: 'another' }, { id: 'live' }], albumArtists: [{ id: 'another' }, { id: 'live' }] },
];
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const id = url.searchParams.get('id');
  let body: Record<string, unknown> = {};
  if (url.pathname.endsWith('/getArtist')) body = { artist: { id, name: id === 'live' ? 'Live' : 'Artist', album: [{ id: 'album', songCount: id === 'live' ? 5 : id?.startsWith('guest-') ? 9 : 4 }] } };
  if (url.pathname.endsWith('/getGenres')) body = { genres: { genre: [{ value: 'Jazz' }] } };
  if (url.pathname.endsWith('/getArtists')) body = { artists: { index: [{ artist: [{ id: 'artist', name: 'Artist' }, { id: 'live', name: 'Live' }] }] } };
  if (url.pathname.endsWith('/getAlbum')) { albumCalls++; body = { album: { song: liveTracks } }; }
  if (url.pathname.endsWith('/getPlaylists')) body = { playlists: { playlist: [{ id: 'pin', name: 'Pinned' }, { id: 'exclude', name: 'Excluded' }, { id: 'guest', name: 'Guest' }] } };
  if (url.pathname.endsWith('/getPlaylist')) {
    const entry = id === 'pin' ? [{ id: 'one', title: 'One', artist: 'Artist' }, { id: 'two', title: 'Two', artist: 'Artist' }]
      : id === 'guest' ? [{ id: 'guest-konitz', title: 'Konitz', artist: 'Guest, Leader' }]
        : [{ id: 'two', title: 'Two', artist: 'Artist' }];
    body = { playlist: { entry } };
  }
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', ...body } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = `http://127.0.0.1:${address.port}`;
process.env.NAVIDROME_USER = 'test'; process.env.NAVIDROME_PASS = 'test';
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const blocklist = await import('../src/music/blocklist.js');
const settings = await import('../src/settings.js');
const { resolveArtistEpisodeSource, randomLibraryArtist } = await import('../src/music/episode-source.js');
const { buildPickerContext, pickerScope } = await import('../src/llm/internal/tools/picker/scope.js');
const { buildPickerTools } = await import('../src/llm/internal/tools/picker/index.js');
const { showNoRepeatGuard } = await import('../src/music/show-recency.js');
const { showSchema } = await import('../src/schemas/show.js');
await settings.load(); await library.load(); await blocklist.load();
after(async () => { db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeTempDir(root); });
for (const [id, title] of [['one', 'One'], ['two', 'Two'], ['duplicate', 'One'], ['short', 'Short']]) {
  db.upsertTrackMeta(id, { title, artist: 'Artist', artistId: 'artist', album: 'Album', albumId: 'album', duration: id === 'short' ? 10 : 180 });
}
db.upsertTrackMeta('outsider', { title: 'Other', artist: 'Artist Junior', artistId: 'other', duration: 180 });
function show(fields: Record<string, unknown> = {}) {
  const parsed = showSchema({ personaIds: null, moodNames: null, themeIds: null, minTrackSeconds: null })
    .parse({ id: 's_artist', name: 'Artist hour', personaId: '', minTrackLengthSeconds: 30, ...fields });
  assert.ok(parsed.id);
  return { ...parsed, id: parsed.id, persona: null, guests: [] };
}

test('the complete untagged mirror uses exact artist ids and deduplicates audible identities', async () => {
  const source = await resolveArtistEpisodeSource('artist', show(), 'episode-one');
  assert.equal(albumCalls, 0, 'a complete mirror needs no album fan-out');
  assert.deepEqual([...source.ids], ['one', 'two']);
  assert.deepEqual(db.artistIdentities(3), [{ id: 'artist', name: 'Artist' }]);
  assert.deepEqual(await randomLibraryArtist({ minDistinctTracks: 3 }), { id: 'artist', name: 'Artist' });
});

test('strict playlist and exclusions intersect the prepared catalogue; an empty safety intersection refuses it', async () => {
  const unrestricted = await resolveArtistEpisodeSource('artist', show(), 'episode-two');
  const source = await resolveArtistEpisodeSource('artist', show({ playlistIds: ['pin'], playlistStrict: true, excludedPlaylistIds: ['exclude'] }), 'episode-two');
  assert.deepEqual([...source.ids], ['one']);
  assert.notEqual(source.identity, unrestricted.identity, 'a fallback built with old catalogue membership cannot publish over the new source');
  await assert.rejects(resolveArtistEpisodeSource('artist', show({ playlistIds: ['exclude'], playlistStrict: true, excludedPlaylistIds: ['exclude'] }), 'episode-three'), /No playable/);
});

test('a clean episode drops tagged tracks before the strict locks; nothing clean left refuses it', async () => {
  // Their own artist ids: the catalogue is cached per artist for a minute.
  const seed = (artistId: string, rows: Array<[string, string | null, string[]]>) => {
    for (const [id, explicitStatus, genres] of rows) {
      db.upsertTrackMeta(id, { title: id, artist: artistId, artistId, album: 'Album', albumId: 'album', duration: 180, genres, explicitStatus });
    }
  };
  seed('mixed', [['m-tagged', 'explicit', ['Rare']], ['m-clean', 'clean', ['Soul']], ['m-none', null, ['Soul']], ['m-more', null, ['Soul']]]);
  seed('tagged-only', [['t-1', 'explicit', []], ['t-2', 'explicit', []], ['t-3', 'explicit', []], ['t-4', 'explicit', []]]);
  try {
    const open = await resolveArtistEpisodeSource('mixed', show(), 'episode-tags');
    assert.ok(open.ids.has('m-tagged'), 'off: the catalogue as before');
    const clean = await resolveArtistEpisodeSource('mixed', show({ excludeExplicit: true }), 'episode-tags');
    assert.deepEqual([...clean.ids].sort(), ['m-clean', 'm-more', 'm-none']);
    assert.notEqual(clean.identity, open.identity, 'the fallback built for the old catalogue cannot publish over this one');
    // Rare is the tagged track's alone, so the genre lock is what gives way.
    const strict = await resolveArtistEpisodeSource('mixed', show({ excludeExplicit: true, filtersStrict: true, genres: ['Rare'] }), 'episode-tags');
    assert.deepEqual([...strict.ids].sort(), ['m-clean', 'm-more', 'm-none']);
    await assert.rejects(resolveArtistEpisodeSource('tagged-only', show({ excludeExplicit: true }), 'episode-tags'), /No playable/);
  } finally {
    const remove = db.getDb()!.prepare('DELETE FROM tracks WHERE artist_id = ?');
    remove.run('mixed');
    remove.run('tagged-only');
  }
});

test('an incomplete mirror falls back to targeted albums and rejects another artist in the same album', async () => {
  const source = await resolveArtistEpisodeSource('live', show(), 'episode-live');
  assert.deepEqual([...source.ids], ['live-one', 'live-two', 'live-collaboration']);
  assert.equal(albumCalls, 1);
});

// #2333: getArtist lists only the albums the artist is an album artist on, so a
// track credited first to them on someone else's record is in the mirror alone.
// The mirror (one row) is below getArtist's song count (9), so the albums path runs.
test('the albums fallback keeps a first credit on another artist\'s album from the mirror', async () => {
  db.upsertTrackMeta('guest-konitz', { title: 'Konitz', artist: 'Guest, Leader', artistId: 'guest-lead', album: "Leader's Record", albumId: 'elsewhere', duration: 180 });
  const source = await resolveArtistEpisodeSource('guest-lead', show(), 'episode-guest');
  assert.deepEqual([...source.ids], ['guest-konitz']);
  const strict = await resolveArtistEpisodeSource('guest-lead', show({ playlistIds: ['guest'], playlistStrict: true }), 'episode-guest');
  assert.deepEqual([...strict.ids], ['guest-konitz'], 'the strict playlist holding only that record airs it');
});

test('a catalogue with none of its tracks in the strict playlist names the playlist as the cause', async () => {
  await assert.rejects(
    resolveArtistEpisodeSource('guest-lead', show({ playlistIds: ['pin'], playlistStrict: true }), 'episode-guest'),
    /None of this artist's tracks are in the show's playlists/,
  );
});

test('mirror-only rows on the albums path go through the explicit, strict-lock and length filters', async () => {
  const seed = (id: string, fields: Record<string, unknown>) => db.upsertTrackMeta(id, {
    title: id, artist: 'Guest', artistId: 'guest-filters', album: 'Other Record', albumId: 'elsewhere', duration: 180, genres: ['Jazz'], ...fields,
  });
  seed('gf-explicit', { explicitStatus: 'explicit' });
  seed('gf-clean', { explicitStatus: 'clean' });
  seed('gf-short', { duration: 10 });
  seed('gf-rock', { genres: ['Rock'] });
  const open = await resolveArtistEpisodeSource('guest-filters', show(), 'episode-gf');
  assert.deepEqual([...open.ids].sort(), ['gf-clean', 'gf-explicit', 'gf-rock'], 'the length floor drops the short row');
  const filtered = await resolveArtistEpisodeSource('guest-filters', show({ excludeExplicit: true, filtersStrict: true, genres: ['Jazz'] }), 'episode-gf');
  assert.deepEqual([...filtered.ids], ['gf-clean']);
});

test('every picker discovery result intersects the artist source before seen; artist caps yield and track recency holds', async () => {
  const source = await resolveArtistEpisodeSource('artist', show(), 'episode-picker');
  const context = buildPickerContext(pickerScope({ episodeSource: source, hardRecentIds: new Set(['one']) }));
  assert.deepEqual(context.collect([...source.tracks, { id: 'outsider', title: 'Other', artist: 'Artist Junior' }]).map(row => row.id), ['two']);
  assert.equal(context.seen.has('outsider'), false);
  const tools = buildPickerTools({ episodeSource: source });
  assert.ok(tools.tools.episodeArtistTracks);
  const guard = showNoRepeatGuard(100, 1000, { show: show(), playlistTracks: null, excludedIds: null, episodeTracks: source.tracks });
  assert.ok(guard.window < source.tracks.length, 'small artist catalogues cannot be completely withheld');
  assert.equal(buildPickerTools().tools.episodeArtistTracks, undefined, 'request and ordinary paths do not inherit an artist source');
});
