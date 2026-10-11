import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

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
  if (url.pathname.endsWith('/getArtist')) body = { artist: { id, name: id === 'live' ? 'Live' : 'Artist', album: [{ id: 'album', songCount: id === 'live' ? 5 : 4 }] } };
  if (url.pathname.endsWith('/getArtists')) body = { artists: { index: [{ artist: [{ id: 'artist', name: 'Artist' }, { id: 'live', name: 'Live' }] }] } };
  if (url.pathname.endsWith('/getAlbum')) { albumCalls++; body = { album: { song: liveTracks } }; }
  if (url.pathname.endsWith('/getPlaylists')) body = { playlists: { playlist: [{ id: 'pin', name: 'Pinned' }, { id: 'exclude', name: 'Excluded' }] } };
  if (url.pathname.endsWith('/getPlaylist')) body = { playlist: { entry: id === 'pin' ? [{ id: 'one', title: 'One', artist: 'Artist' }, { id: 'two', title: 'Two', artist: 'Artist' }] : [{ id: 'two', title: 'Two', artist: 'Artist' }] } };
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
after(async () => { db.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
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

test('an incomplete mirror falls back to targeted albums and rejects another artist in the same album', async () => {
  const source = await resolveArtistEpisodeSource('live', show(), 'episode-live');
  assert.deepEqual([...source.ids], ['live-one', 'live-two', 'live-collaboration']);
  assert.equal(albumCalls, 1);
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
