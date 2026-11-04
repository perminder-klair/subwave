// A small library through the REAL auto.m3u writer: when every track has aired
// inside the recency window, each source comes back empty, and without a
// fallback the mixer airs the emergency loop until someone queues a track by
// hand (seen on a hosted pilot station with 21 tracks). The rested fallback
// fills the coast with the longest-rested tracks instead, and says so in the
// booth log; with any fresh track available it never runs.
// Run: `npm test -- rested-coast`.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-rested-coast-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://rested-coast.invalid';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const mixer = createServer(socket => socket.once('data', () => socket.end('OK\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');

const song = (i: number) => ({ id: `t${i}`, title: `Track ${i}`, artist: `Act ${i}`, duration: 200, genre: 'Hip-Hop' });
const LIBRARY = Array.from({ length: 6 }, (_, i) => song(i + 1));

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  assert.equal(url.hostname, 'rested-coast.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getRandomSongs' ? { randomSongs: { song: LIBRARY } }
    : endpoint === 'getGenres' ? { genres: { genre: [{ value: 'Hip-Hop', songCount: LIBRARY.length }] } }
      : endpoint === 'getPlaylists' ? { playlists: { playlist: [] } }
        : endpoint === 'getAlbumList2' ? { albumList2: { album: [] } }
          : endpoint === 'getStarred2' ? { starred2: { song: [] } } : {};
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

const coastIds = () => readFileSync(join(root, 'auto.m3u'), 'utf8').split('\n')
  .filter(line => line.includes('subsonic_id='))
  .map(line => line.match(/subsonic_id="([^"]+)"/)![1]);
const boothLines = () => queue.djLog.map((e: any) => String(e.message));
const markAired = (ids: string[]) => {
  const now = Date.now();
  (queue as any)._recentPlays = ids.map((id, i) => {
    const s = LIBRARY.find(t => t.id === id)!;
    return { id, title: s.title, artist: s.artist, endedAt: new Date(now - i * 60_000).toISOString() };
  });
};

test('every track aired inside the window: the coast repeats the longest-rested, not the emergency loop', async () => {
  markAired(LIBRARY.map(t => t.id));
  await refreshAutoPlaylist();
  const ids = coastIds();
  assert.ok(ids.length > 0, 'the coast must not be empty');
  assert.ok(ids.every(id => LIBRARY.some(t => t.id === id)));
  assert.ok(boothLines().some(l => /longest-rested instead of the emergency loop/.test(l)), boothLines().join('\n'));
});

test('with a fresh track available the fallback does not run', async () => {
  markAired(LIBRARY.slice(0, 4).map(t => t.id)); // t5, t6 never aired
  const before = boothLines().filter(l => /longest-rested/.test(l)).length;
  await refreshAutoPlaylist();
  const ids = coastIds();
  assert.ok(ids.includes('t5') || ids.includes('t6'));
  assert.equal(boothLines().filter(l => /longest-rested/.test(l)).length, before);
});
