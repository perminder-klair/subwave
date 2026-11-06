// A small library through the REAL auto.m3u writer: when every track has aired
// inside the recency window, each source comes back empty, and without a
// fallback the mixer airs the emergency loop until someone queues a track by
// hand (seen on a hosted pilot station with 21 tracks). The rested fallback
// fills the coast with the longest-rested tracks instead, by when each last
// went to air: the longest-waiting half, never the track on air, topped up to
// an hour of audio (the rotation coast's rule, music/show-recency.ts). It says
// so in the booth log, and with any fresh track available it never runs.
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

// Five-minute tracks: twelve of them are exactly the coast's one-hour floor.
const song = (i: number) => ({ id: `t${i}`, title: `Track ${i}`, artist: `Act ${i}`, duration: 300, genre: 'Hip-Hop' });
const libraryOf = (n: number) => Array.from({ length: n }, (_, i) => song(i + 1));
let LIBRARY = libraryOf(24);

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
// Aired in the order given, the first most recently (a minute apart).
const markAired = (ids: string[]) => {
  const now = Date.now();
  (queue as any)._recentPlays = ids.map((id, i) => {
    const s = LIBRARY.find(t => t.id === id)!;
    return { id, title: s.title, artist: s.artist, endedAt: new Date(now - i * 60_000).toISOString() };
  });
};
const onAir = (id: string | null) => {
  (queue as any).current = id ? { track: LIBRARY.find(t => t.id === id) } : null;
};
const sorted = (ids: string[]) => [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

test('every track aired inside the window: the coast is the longest-rested half, never the track on air', async () => {
  LIBRARY = libraryOf(24);
  // t1 aired last, t24 longest ago; t24 is also back on air right now.
  markAired(LIBRARY.map(t => t.id));
  onAir('t24');
  await refreshAutoPlaylist();
  // The longest-waiting half of 24 is 12, an hour of audio: t23 back to t12.
  // The most recent plays (t1..t11) and the on-air t24 are held back.
  assert.deepEqual(sorted(coastIds()), LIBRARY.slice(11, 23).map(t => t.id));
  assert.ok(boothLines().some(l => /repeating the 12 longest-rested .*instead of the emergency loop/.test(l)), boothLines().join('\n'));
});

test('a library too small for an hour tops up from the next longest-rested, still never the on-air track', async () => {
  LIBRARY = libraryOf(6);
  markAired(LIBRARY.map(t => t.id));
  onAir('t3');
  await refreshAutoPlaylist();
  assert.deepEqual(sorted(coastIds()), ['t1', 't2', 't4', 't5', 't6']);
});

test('with a fresh track available the fallback does not run', async () => {
  LIBRARY = libraryOf(6);
  onAir(null);
  markAired(LIBRARY.slice(0, 4).map(t => t.id)); // t5, t6 never aired
  const before = boothLines().filter(l => /longest-rested/.test(l)).length;
  await refreshAutoPlaylist();
  const ids = coastIds();
  assert.ok(ids.includes('t5') || ids.includes('t6'));
  assert.equal(boothLines().filter(l => /longest-rested/.test(l)).length, before);
});
