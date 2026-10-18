// The strict-playlist coast (#1919) through the REAL fallback writer:
// refreshAutoPlaylist against a stubbed Navidrome, a temp library.db and a fake
// mixer, read back from the auto.m3u it writes.
//
// playlist-rotation-coast.test.ts pins the pure pieces and scrapes the wiring;
// this file is the round trip those cannot see — the durable plays index under
// queue.rotationAirTimes(), and what the floor does to the memoised playlist
// objects it tops up from.
//
// Run: npm test -- playlist-rotation-coast-build

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'subwave-rotation-coast-build-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://rotation-library.invalid';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const mixer = createServer(socket => socket.once('data', () => socket.end('OK\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');

type Song = { id: string; title: string; artist: string; duration: number; replayGain?: { trackGain: number; trackPeak: number } };
const songs = (prefix: string, n: number, extra: Partial<Song> = {}): Song[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i + 1}`, title: `${prefix} ${i + 1}`, artist: `Artist ${i + 1}`, duration: 240, ...extra,
  }));
const playlists: Record<string, Song[]> = {
  rotation: songs('rot', 109),
  // ReplayGain-tagged, so the coast stamps a gain on every row.
  strict: songs('strict', 109, { replayGain: { trackGain: -4, trackPeak: 0.5 } }),
};

const realFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  assert.equal(url.hostname, 'rotation-library.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getPlaylists'
    ? { playlists: { playlist: Object.keys(playlists).map(id => ({ id, name: id })) } }
    : endpoint === 'getPlaylist' ? { playlist: { entry: playlists[url.searchParams.get('id') || ''] ?? [] } }
      : endpoint === 'getAlbumList2' ? { albumList2: { album: [] } }
        : endpoint === 'getStarred2' ? { starred2: { song: [] } } : {};
  return Response.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...data } });
};
after(async () => {
  globalThis.fetch = realFetch;
  library.shutdown();
  await new Promise<void>(resolve => mixer.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const q = queue as any;
const coast = () => readFileSync(join(root, 'auto.m3u'), 'utf8').split('\n').filter(line => line.includes('subsonic_id='));
const coastIds = () => coast().map(line => line.match(/subsonic_id="([^"]+)"/)![1]);
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${from + i}`);
const takeover = async (show: Record<string, unknown>) => {
  const now = Date.now();
  await settings.update({
    shows: [{ name: String(show.id), personaId: settings.get().personas[0].id, playlistStrict: true, ...show }],
    scheduleOverride: { showId: show.id, startedAt: now - 60_000, expiresAt: now + 3600_000 },
  } as never);
};

await settings.load();
await library.load();

test('a full rotation coasts on its longest-waiting tracks, read from the durable plays index', async () => {
  // Every airing is ten days old: past the sidecar's 96h, where only
  // library.lastAiredInfo() remembers it — a weekly show's whole history.
  // Recorded before anything reads the index, which is memoised five minutes.
  const base = Date.now() - 10 * 24 * 3_600_000;
  for (const [i, song] of playlists.rotation.entries()) {
    await library.recordPlay({
      trackId: song.id, title: song.title, artist: song.artist, album: null,
      playedAt: new Date(base + i * 60_000).toISOString(),
      source: 'ai', requestedBy: null, showId: 's_rotation', showName: 'Rotation',
    });
  }
  q._recentPlays = [];
  q.current = null;
  q.upcoming = [];
  await takeover({ id: 's_rotation', playlistIds: ['rotation'], playlistExhaust: true });
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  assert.deepEqual(coastIds(), range('rot', 1, 32), 'the 32 that have waited longest, in that order');

  // The sidecar is fresher than the index, and on air / queued count as spent.
  q._recentPlays = [{ id: 'rot-1', title: 'rot 1', artist: 'Artist 1', endedAt: new Date().toISOString() }];
  q.current = { track: { id: 'rot-2', title: 'rot 2', artist: 'Artist 2' } };
  q.upcoming = [{ track: { id: 'rot-3', title: 'rot 3', artist: 'Artist 3' } }];
  try {
    assert.equal(await refreshAutoPlaylist(), 'refreshed');
    assert.deepEqual(coastIds(), range('rot', 4, 35), 'just aired, on air and queued all step aside');
  } finally {
    q._recentPlays = [];
    q.current = null;
    q.upcoming = [];
  }
});

test('the floor tops a collapsed strict coast up without stamping the cached playlist rows', async () => {
  // A non-rotating strict playlist heard almost entirely inside trackHours:
  // the recency-filtered take keeps 4 tracks, the floor makes up the hour.
  const now = Date.now();
  q._recentPlays = playlists.strict.slice(4).map((song, i) => ({
    id: song.id, title: song.title, artist: song.artist, endedAt: new Date(now - i * 1000).toISOString(),
  }));
  try {
    await takeover({ id: 's_strict', playlistIds: ['strict'] });
    assert.equal(await refreshAutoPlaylist(), 'refreshed');
    assert.equal(coast().length, 15, '15 x 240s is the hour');
    assert.ok(coastIds().slice(0, 4).every(id => range('strict', 1, 4).includes(id)), 'what the sources chose stays first');
    assert.ok(coast().every(line => line.includes('liq_amplify=')), 'every row is levelled from its ReplayGain tag');

    // The playlist is memoised for 30 minutes. If the floor handed the cached
    // song objects to the loudness stamp, the next build would carry this
    // build's gain on them even once nothing measures them any more.
    await settings.update({ loudness: { source: 'measured' } } as never);
    assert.equal(await refreshAutoPlaylist(), 'refreshed');
    assert.equal(coast().length, 15);
    assert.deepEqual(coast().filter(line => line.includes('liq_amplify=')), [], 'nothing measured, nothing stamped');
  } finally {
    q._recentPlays = [];
  }
});
