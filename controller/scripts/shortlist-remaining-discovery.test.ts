import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-remaining-discovery-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://remaining-library.invalid';
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { buildPickerTools, pickerScope, clearPickerSourceCache } = await import('../src/llm/tools.js');
const { planShortlistSources } = await import('../src/music/shortlist.js');
await library.load();
const songs = Array.from({ length: 12 }, (_, album) => Array.from({ length: 8 }, (_, track) => ({
  id: `album-${album}-track-${track}`, title: `Track ${track}`, artist: `Artist ${album}`,
  album: `Album ${album}`, genres: [{ name: 'Jazz' }], duration: 240,
}))).flat();
for (const song of songs) {
  db.upsertTrackMeta(song.id, { ...song, genres: ['Jazz'] });
  db.upsertTrackTags(song.id, { moods: [song.id.includes('album-0-') ? 'calm' : 'driving'], energy: 'high', source: 'manual' });
}
const realFetch = globalThis.fetch;
const requests: URL[] = [];
globalThis.fetch = async input => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'remaining-library.invalid');
  requests.push(url);
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getAlbumList2'
    ? { albumList2: { album: Number(url.searchParams.get('offset')) > 0 ? [] : Array.from({ length: 12 }, (_, i) => ({ id: String(i) })) } }
    : endpoint === 'getAlbum' ? { album: { song: songs.filter(s => s.album === `Album ${url.searchParams.get('id')}`) } }
      : endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'calm', name: 'Calm evening' }, { id: 'other', name: 'Rock hour' }] } }
        : endpoint === 'getPlaylist' ? { playlist: { entry: songs } }
          : endpoint === 'search3' ? { searchResult3: { artist: [{ id: 'seed-artist', name: 'Anchor' }] } }
            : endpoint === 'getArtistInfo2' ? { artistInfo2: { similarArtist: [{ name: 'Neighbour One' }, { name: 'Neighbour Two' }] } }
              : endpoint === 'getTopSongs' ? { topSongs: { song: songs } } : {};
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
};
after(() => { globalThis.fetch = realFetch; library.shutdown(); rmSync(root, { recursive: true, force: true }); });
async function run(tools: ReturnType<typeof buildPickerTools>['tools'], name: string, args = {}): Promise<any[]> {
  assert.ok(tools[name]?.execute, `${name} registered`);
  const result = await tools[name].execute!(args, { toolCallId: name, messages: [], context: undefined });
  assert.ok(Array.isArray(result), JSON.stringify(result));
  return result;
}

test('recent albums sample twelve albums and later tracks; repeated picks reuse the wide pool but recollect', async () => {
  clearPickerSourceCache(); requests.length = 0;
  const realRandom = Math.random;
  Math.random = () => 0;
  try {
    const { tools } = buildPickerTools();
    const first = await run(tools, 'recentlyAdded');
    assert.equal(first.length, 8);
    assert.ok(requests.some(url => url.searchParams.get('size') === '12'));
    assert.equal(requests.filter(url => url.pathname.endsWith('/getAlbum')).length, 12);
    const calls = requests.length;
    const second = await run(tools, 'recentlyAdded');
    assert.equal(second.length, 8);
    assert.ok([...first, ...second].some(song => Number(song.id.split('-').at(-1)) >= 3));
    assert.equal(new Set([...first, ...second].map(song => song.id)).size, 16);
    const next = buildPickerTools({ recentIds: new Set(first.map(song => song.id)) });
    const third = await run(next.tools, 'recentlyAdded');
    assert.ok(third.every(song => !first.some(old => old.id === song.id)));
    assert.equal(requests.length, calls, 'TTL holds raw pool, not recency-filtered output');
  } finally { Math.random = realRandom; }
});

test('frequent albums rotate the window, retry offset zero when empty, and cache the pool', async () => {
  clearPickerSourceCache(); requests.length = 0;
  const realRandom = Math.random;
  Math.random = () => 0.9;
  try {
    const { tools } = buildPickerTools();
    assert.equal((await run(tools, 'frequentAlbums')).length, 8);
    const offsets = requests.filter(url => url.pathname.endsWith('/getAlbumList2')).map(url => Number(url.searchParams.get('offset')));
    assert.deepEqual(offsets, [24, 0]);
    const count = requests.length;
    assert.equal((await run(tools, 'frequentAlbums')).length, 8);
    assert.equal(requests.length, count);
  } finally { Math.random = realRandom; }
});

test('mood playlists and the artist graph contribute through shared guards and cached raw data', async () => {
  for (const [source, args] of [['moodPlaylistTracks', { mood: 'calm' }], ['similarArtistTracks', { artist: 'Anchor' }]] as const) {
    clearPickerSourceCache(); requests.length = 0;
    const allowed = songs.slice(0, 8);
    const { tools } = buildPickerTools({
      genreLock: ['Jazz'], moodLock: ['calm'], energyLock: ['high'],
      hardRecentIds: new Set([allowed[0].id]), excludedIds: new Set([allowed[1].id]),
      minTrackSec: 180, maxTrackSec: 300,
    });
    const first = await run(tools, source, args);
    assert.ok(first.length > 0);
    assert.ok(first.every(song => allowed.slice(2).some(allowed => allowed.id === song.id)));
    const count = requests.length;
    await tools[source].execute!(args, { toolCallId: 'again', messages: [], context: undefined });
    assert.equal(requests.length, count, `${source} caches discovery data`);
  }
});

test('configured or resolved playlist anchors hide mood playlists, including stale pins', () => {
  for (const scope of [{ hasPlaylistAnchor: true }, { playlistTracks: [{ id: 'p' }] }, { playlistLock: new Set(['p']) }]) {
    assert.equal('moodPlaylistTracks' in buildPickerTools(scope).tools, false);
  }
});

test('a wildcard selects another covered mood and respects strict energy, exclusions and recency', async () => {
  const recent = songs[8].id;
  const { tools } = buildPickerTools({ energyLock: ['high'], hardRecentIds: new Set([recent]), excludedIds: new Set([songs[9].id]) });
  const rows = await run(tools, 'moodWildcard', { excludeMoods: ['CALM'] });
  assert.equal(rows.length, 3);
  assert.ok(rows.every(song => song.moods.includes('driving') && ![recent, songs[9].id].includes(song.id)));
  assert.equal('moodWildcard' in buildPickerTools({ energyLock: ['low'] }).tools, true);
  const empty = await buildPickerTools({ energyLock: ['low'] }).tools.moodWildcard.execute!({ excludeMoods: ['calm'] }, { toolCallId: 'strict', messages: [], context: undefined });
  assert.deepEqual((empty as any).tracks, [], 'wildcards never relax an explicit energy lock');
});

test('all added sources rotate within the existing budget; pinned moods suppress autonomous wildcards', () => {
  const available = new Set(['frequentAlbums', 'moodPlaylistTracks', 'similarArtistTracks', 'moodWildcard']);
  const found = new Set<string>();
  for (let rotationSeed = 0; rotationSeed < 30; rotationSeed++) {
    const context = { scope: pickerScope(), currentTrackId: 'seed', currentArtist: 'Anchor', discoveryPasses: 3, dominantMood: 'calm', rotationSeed };
    const plan = planShortlistSources(context, available);
    assert.equal(plan.length, 3);
    // Even a one-pass station reaches every source; family rotation must not
    // alias with the six-source autonomous diversity lane.
    planShortlistSources({ ...context, discoveryPasses: 1 }, available).forEach(call => found.add(call.source));
    assert.ok(!planShortlistSources({ ...context, moods: ['calm'] }, available).some(call => call.source === 'moodWildcard'));
    assert.ok(!planShortlistSources({ ...context, scope: pickerScope({ hasPlaylistAnchor: true }) }, available).some(call => call.source === 'moodPlaylistTracks'));
  }
  assert.deepEqual(found, available);
});


test('empty server pools hide unavailable sources temporarily and cache invalidation permits a fresh probe', async () => {
  const { cachedPickerSource, pickerSourceAvailable } = await import('../src/llm/internal/tools/picker/source-pool-cache.js');
  clearPickerSourceCache();
  await cachedPickerSource('recent-albums', async () => []);
  assert.equal('recentlyAdded' in buildPickerTools().tools, false);
  const realNow = Date.now;
  const now = realNow();
  Date.now = () => now + 5 * 60_000 + 1;
  try { assert.equal(pickerSourceAvailable('recent-albums'), true); }
  finally { Date.now = realNow; }
  let finish!: (rows: any[]) => void;
  const old = cachedPickerSource('old-server', () => new Promise(resolve => { finish = resolve; }));
  clearPickerSourceCache();
  finish([]);
  await old;
  assert.equal(pickerSourceAvailable('old-server'), true, 'an old server response cannot refill the cleared cache');
  assert.equal('recentlyAdded' in buildPickerTools().tools, true);
});
