// A clean show through the REAL auto.m3u writer, read back from the file it
// writes: refreshAutoPlaylist against a stubbed Navidrome and a fake mixer. This
// fallback airs with no pick and no queue.push() behind it, so nothing else
// stands between it and the air.
//
// It is also the one place a clean show may give way, because it is the last
// dead-air guard. The edge is pinned here: everything else relaxes first, and
// only an otherwise empty file keeps tagged tracks, with a booth line.
// Run: `npm test -- explicit-coast`.

import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-explicit-coast-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://explicit-coast.invalid';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const mixer = createServer(socket => socket.once('data', () => socket.end('OK\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const db = await import('../src/music/library-db.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');

type Song = { id: string; title: string; artist: string; duration: number; genre?: string; genres?: Array<{ name: string }>; explicitStatus?: string };
let seq = 0;
const track = (id: string, explicitStatus?: string, genre = 'Soul'): Song => ({
  id, title: id, artist: `Act ${++seq}`, duration: 240, genre, genres: [{ name: genre }],
  ...(explicitStatus === undefined ? {} : { explicitStatus }),
});
let random: Song[] = [];
let randomInGenre: Song[] = [];
let starred: Song[] = [];
let byGenre: Song[] = [];
let playlist: Song[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  assert.equal(url.hostname, 'explicit-coast.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: url.searchParams.has('genre') ? randomInGenre : random } }
    : endpoint === 'getSongsByGenre' ? { songsByGenre: { song: byGenre } }
      : endpoint === 'getGenres' ? { genres: { genre: [{ value: 'Soul', songCount: 10 }] } }
        : endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'pin', name: 'Pinned' }] } }
          : endpoint === 'getPlaylist' ? { playlist: { entry: playlist } }
            : endpoint === 'getAlbumList2' ? { albumList2: { album: [] } }
              : endpoint === 'getStarred2' ? { starred2: { song: starred } } : {};
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
}) as typeof fetch;

after(async () => {
  globalThis.fetch = realFetch;
  library.shutdown();
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  await removeTempDir(root);
});

await settings.load();
await library.load();

const { showPreparation } = await import('../src/broadcast/show-preparation.js');

const coastIds = () => readFileSync(join(root, 'auto.m3u'), 'utf8').split('\n')
  .filter(line => line.includes('subsonic_id='))
  .map(line => line.match(/subsonic_id="([^"]+)"/)![1]);
const boothLines = () => queue.djLog.map((e: any) => e.message as string);
const lastResort = (lines: string[]) => lines.filter(l => /keeping \d+ track\(s\) tagged explicit/.test(l));

async function onAir(show: Record<string, unknown>) {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_clean', name: 'Clean Hour', personaId: settings.get().personas[0].id, ...show }],
    scheduleOverride: { showId: 's_clean', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  clearPlaylistCache();
}

// The settings save behind onAir starts a refresh of its own, over whatever
// fixtures were set by then. Let it land, so the lines read are this build's.
async function build() {
  await refreshAutoPlaylist();
  queue.djLog = [];
  await refreshAutoPlaylist();
}

beforeEach(() => {
  random = []; randomInGenre = []; starred = []; byGenre = []; playlist = [];
  queue.djLog = [];
  writeFileSync(join(root, 'auto.m3u'), '#EXTM3U');
});

test('a clean show\'s fallback holds no tagged track, and keeps clean, untagged and unreported ones', async () => {
  await onAir({ excludeExplicit: true });
  random = [track('tagged', 'explicit'), track('marked', 'clean'), track('blank', ''), track('unreported')];
  await build();
  assert.deepEqual(coastIds().sort(), ['blank', 'marked', 'unreported']);
  assert.deepEqual(lastResort(boothLines()), []);
  assert.ok(boothLines().some(l => /Auto-playlist refreshed:.*clean=1 held back/.test(l)), boothLines().join(' | '));
});

test('a show that is not clean writes the same file it always did', async () => {
  await onAir({});
  random = [track('tagged', 'explicit'), track('marked', 'clean')];
  await build();
  assert.deepEqual(coastIds().sort(), ['marked', 'tagged']);
  assert.ok(!boothLines().some(l => /held back/.test(l)), boothLines().join(' | '));
});

test('a soft playlist anchor drops its tagged tracks from the fallback', async () => {
  await onAir({ excludeExplicit: true, playlistIds: ['pin'] });
  playlist = [track('pin-tagged', 'explicit'), track('pin-clean', 'clean')];
  await build();
  assert.deepEqual(coastIds(), ['pin-clean']);
});

test('a strict playlist\'s full rotation and its hour floor draw only what can air', async () => {
  const anchor = Array.from({ length: 12 }, (_, i) => track(`rot-${i}`, i < 4 ? 'explicit' : undefined));
  await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true, playlistExhaust: true });
  playlist = anchor;
  await build();
  const ids = coastIds();
  assert.ok(ids.length > 0);
  assert.ok(ids.every(id => !['rot-0', 'rot-1', 'rot-2', 'rot-3'].includes(id)), ids.join(','));
});

test('a strict genre gives way first: its only in-genre tracks are tagged, so an off-genre clean track airs', async () => {
  const tagged = track('soul-tagged', 'explicit');
  const clean = track('rock-clean', 'clean', 'Rock');
  await onAir({ excludeExplicit: true, filtersStrict: true, genres: ['Soul'] });
  byGenre = [tagged];
  random = [tagged, clean];
  await build();
  assert.deepEqual(coastIds(), ['rock-clean']);
  assert.deepEqual(lastResort(boothLines()), []);
});

test('an era only tagged tracks meet gives way, in either show-genre fetch', async () => {
  const inEra = { ...track('era-tagged', 'explicit'), year: 1975 };
  const offEra = { ...track('era-clean', 'clean'), year: 2015 };
  await onAir({ excludeExplicit: true, genres: ['Soul'], eras: [{ fromYear: 1970, toYear: 1979 }] });
  byGenre = [inEra, offEra];
  await build();
  assert.deepEqual(coastIds(), ['era-clean'], 'the sampled genre page');
  byGenre = [];
  randomInGenre = [inEra, offEra];
  await build();
  assert.deepEqual(coastIds(), ['era-clean'], 'the random genre draw');
  assert.deepEqual(lastResort(boothLines()), []);
});

test('an energy lean gives way, so a mood\'s only low-energy track being tagged airs another', async () => {
  const mood = settings.moodVocab()[0];
  for (const [id, energy, explicitStatus] of [['mood-tagged', 'low', 'explicit'], ['mood-clean', 'high', 'clean']] as const) {
    db.upsertTrackMeta(id, { title: id, artist: `Mood ${id}`, explicitStatus });
    db.upsertTrackTags(id, { moods: [mood], energy, source: 'llm' });
  }
  try {
    await onAir({ excludeExplicit: true, moods: [mood], energies: ['low'] });
    await build();
    assert.deepEqual(coastIds(), ['mood-clean']);
    assert.deepEqual(lastResort(boothLines()), []);
  } finally {
    const remove = db.getDb()!.prepare('DELETE FROM tracks WHERE id = ?');
    remove.run('mood-tagged');
    remove.run('mood-clean');
  }
});

test('a strict mood gives way inside a source, so a strict-playlist coast never reaches its last resort', async () => {
  // A strict playlist skips the random draws, so what the starred source keeps
  // is all there is. Its only in-mood track is tagged.
  const mood = settings.moodVocab()[0];
  db.upsertTrackMeta('star-tagged', { title: 'star-tagged', artist: 'Star A', explicitStatus: 'explicit' });
  db.upsertTrackTags('star-tagged', { moods: [mood], energy: 'low', source: 'llm' });
  try {
    await onAir({ excludeExplicit: true, filtersStrict: true, moods: [mood], playlistIds: ['pin'], playlistStrict: true });
    playlist = [track('pin-tagged', 'explicit')];
    starred = [{ id: 'star-tagged', title: 'star-tagged', artist: 'Star A', duration: 240 }, track('star-clean', 'clean')];
    await build();
    assert.deepEqual(coastIds(), ['star-clean']);
    assert.deepEqual(lastResort(boothLines()), []);
  } finally {
    db.getDb()!.prepare('DELETE FROM tracks WHERE id = ?').run('star-tagged');
  }
});

test('a strict playlist of nothing but tagged tracks gives way to a library-wide draw', async () => {
  await onAir({ excludeExplicit: true, playlistIds: ['pin'], playlistStrict: true });
  playlist = [track('pin-tagged', 'explicit')];
  random = [track('wider-clean', 'clean')];
  await build();
  assert.deepEqual(coastIds(), ['wider-clean']);
  assert.deepEqual(lastResort(boothLines()), []);
});

test('recency gives way before the filter: a just-aired clean track airs again rather than a tagged one', async () => {
  const clean = track('just-aired', 'clean');
  const tagged = track('tagged', 'explicit');
  await onAir({ excludeExplicit: true });
  const realRecent = queue.recentlyPlayed;
  queue.recentlyPlayed = (() => ({ ids: new Set(['just-aired']), keys: new Set<string>() })) as never;
  try {
    random = [clean, tagged];
    await build();
  } finally {
    queue.recentlyPlayed = realRecent;
  }
  assert.deepEqual(coastIds(), ['just-aired']);
  assert.deepEqual(lastResort(boothLines()), []);
});

test('the edge: with nothing else in the library the station keeps playing and the booth log says so', async () => {
  await onAir({ excludeExplicit: true });
  random = [track('only-a', 'explicit'), track('only-b', 'explicit')];
  await build();
  assert.deepEqual(coastIds().sort(), ['only-a', 'only-b'], 'never an empty fallback');
  const lines = lastResort(boothLines());
  assert.equal(lines.length, 1, boothLines().join(' | '));
  assert.match(lines[0], /clean show "Clean Hour" has nothing else to air — keeping 2 track\(s\) tagged explicit/);
});

test('an empty library is not a clean-show problem, and says nothing about one', async () => {
  await onAir({ excludeExplicit: true });
  await build();
  assert.deepEqual(coastIds(), []);
  assert.deepEqual(lastResort(boothLines()), []);
});

test('turning the switch on rebuilds the file already on disk', async () => {
  await onAir({});
  random = [track('tagged', 'explicit'), track('marked', 'clean')];
  await refreshAutoPlaylist();
  assert.ok(coastIds().includes('tagged'));
  await onAir({ excludeExplicit: true });
  const deadline = Date.now() + 5_000;
  while (coastIds().includes('tagged') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(coastIds(), ['marked'], 'settings changes publish through the coast policy seam');
});

test('an episode with nothing airable left does not empty the coast', async (t) => {
  // Prepared before the show went clean, or before the walk that tagged its
  // artist. The episode branch has no sources of its own to fall back on.
  await onAir({ excludeExplicit: true });
  const tracks = [track('episode-1', 'explicit'), track('episode-2', 'explicit')];
  t.mock.method(showPreparation, 'read', () => ({
    music: { kind: 'artist', identity: 'episode', artist: { id: 'a', name: 'A' }, tracks, ids: new Set(tracks.map(s => s.id)) },
    status: { kind: 'ready', occurrence: { id: 'o' } },
    editorial: null,
  }) as never);
  random = [track('clean-1', ''), track('clean-2', '')];
  await build();
  assert.deepEqual(coastIds().sort(), ['clean-1', 'clean-2'], 'the show gives way before the tag does');
});

test('an episode whose whole library is tagged still leaves the station something to play', async (t) => {
  await onAir({ excludeExplicit: true });
  const tracks = [track('episode-1', 'explicit')];
  t.mock.method(showPreparation, 'read', () => ({
    music: { kind: 'artist', identity: 'episode', artist: { id: 'a', name: 'A' }, tracks, ids: new Set(tracks.map(s => s.id)) },
    status: { kind: 'ready', occurrence: { id: 'o' } },
    editorial: null,
  }) as never);
  random = [];
  await build();
  assert.deepEqual(coastIds(), ['episode-1']);
  assert.equal(lastResort(boothLines()).length, 1, 'and the booth log says so');
});
