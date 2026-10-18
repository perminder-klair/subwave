// Exercise the real fallback writer against a synthetic library and mixer.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const root = mkdtempSync(join(tmpdir(), 'subwave-coast-stale-pin-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://coast-library.invalid';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const mixer = createServer(socket => socket.once('data', () => socket.end('OK\nEND\n')));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
const realFetch = globalThis.fetch;
const reads: string[] = [];
const songs = Array.from({ length: 60 }, (_, i) => ({ id: `ordinary-${i}`, title: `Song ${i}`, artist: `Artist ${i}`, duration: 240 }));
globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  assert.equal(url.hostname, 'coast-library.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const id = url.searchParams.get('id') || '';
  if (endpoint === 'getPlaylist') reads.push(id);
  const data = endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'other-show', name: 'Calm Other Show' }] } }
    : endpoint === 'getPlaylist' ? { playlist: { entry: id === 'stale' ? [] : [{ id: 'borrowed', title: 'Borrowed', artist: 'Other Show', duration: 240 }] } }
      : endpoint === 'getRandomSongs' ? { randomSongs: { song: songs } }
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

test('a stale show pin prevents borrowed mood playlists while ordinary sources keep the coast playable', async () => {
  await settings.load();
  await library.load();
  const show = { id: 's_stale', name: 'Stale Show', personaId: settings.get().personas[0].id, moods: ['calm'], playlistIds: ['stale'], playlistStrict: true };
  const now = Date.now();
  await settings.update({ shows: [show], scheduleOverride: { showId: show.id, startedAt: now - 60_000, expiresAt: now + 3600_000 } });
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  assert.ok(reads.includes('stale'), 'the pinned playlist was actually probed');
  assert.ok(!reads.includes('other-show'), 'a failed pin cannot borrow another show playlist');
  const playlist = readFileSync(join(root, 'auto.m3u'), 'utf8');
  assert.match(playlist, /ordinary-/);
  assert.doesNotMatch(playlist, /borrowed/);
  reads.length = 0;
  await settings.update({ shows: [{ ...show, playlistIds: [] }] });
  assert.equal(await refreshAutoPlaylist(), 'refreshed');
  assert.ok(reads.includes('other-show'), 'removing the pin restores mood playlist discovery');
});
