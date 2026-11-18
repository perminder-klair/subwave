// #2213, through the REAL auto.m3u writer and the REAL queue: refreshAutoPlaylist
// against a stubbed Navidrome and a fake mixer, then queue.onTrackStarted.
//
// 1. A strict playlist whose every pinned track another rule holds back still
//    never-starves to the off-playlist pool, but says so: a loud booth line and
//    `(strict, unenforced)` on the refresh line.
// 2. An untracked play the coast the controller last wrote does not hold is
//    logged (warn only: the queue never skips it), and the legitimate untracked
//    plays stay quiet.
// Run: `npm test -- strict-coast-warnings`.

import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const root = createTempDir(join(tmpdir(), 'subwave-strict-coast-'));
process.env.STATE_DIR = root;
process.env.NAVIDROME_URL = 'http://strict-coast.invalid';
process.env.LIQUIDSOAP_HOST = '127.0.0.1';
const commands: string[] = [];
const mixer = createServer(socket => socket.once('data', data => {
  commands.push(String(data).split('\n')[0]);
  socket.end('OK\nEND\n');
}));
await new Promise<void>(resolve => mixer.listen(0, '127.0.0.1', resolve));
process.env.LIQUIDSOAP_PORT = String((mixer.address() as { port: number }).port);

const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const { queue } = await import('../src/broadcast/queue.js');
const { refreshAutoPlaylist } = await import('../src/broadcast/scheduler.js');
const { clearPlaylistCache } = await import('../src/music/show-playlist.js');
const { REPLACED_COAST_GRACE_MS } = await import('../src/broadcast/off-coast-policy.js');

type Song = { id: string; title: string; artist: string; duration: number; explicitStatus?: string };
let seq = 0;
const track = (id: string, opts: { explicit?: boolean; duration?: number } = {}): Song => ({
  id, title: `Title ${id}`, artist: `Act ${++seq}`, duration: opts.duration ?? 240,
  ...(opts.explicit ? { explicitStatus: 'explicit' } : {}),
});
let starred: Song[] = [];
let playlist: Song[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.open-meteo.com') return Response.json({ current: { temperature_2m: 15, weather_code: 0, is_day: 1 } });
  assert.equal(url.hostname, 'strict-coast.invalid', 'no live service calls');
  const endpoint = url.pathname.split('/').at(-1);
  const data = endpoint === 'getPlaylists' ? { playlists: { playlist: [{ id: 'pin', name: 'Anchor' }] } }
    : endpoint === 'getPlaylist' ? { playlist: { entry: playlist } }
      : endpoint === 'getAlbumList2' ? { albumList2: { album: [] } }
        : endpoint === 'getStarred2' ? { starred2: { song: starred } }
          : endpoint === 'getRandomSongs' ? { randomSongs: { song: [] } } : {};
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

const q = queue as any;
const coastIds = () => readFileSync(join(root, 'auto.m3u'), 'utf8').split('\n')
  .filter(line => line.includes('subsonic_id='))
  .map(line => line.match(/subsonic_id="([^"]+)"/)![1]);
const boothLines = () => queue.djLog.map((e: any) => e.message as string);
const unenforcedLines = () => boothLines().filter(l => /STRICT playlist for show/.test(l));
const refreshedLine = () => boothLines().find(l => l.startsWith('Auto-playlist refreshed:')) ?? '';
const offCoastLines = () => boothLines().filter(l => l.startsWith('Off-coast play:'));

async function onAir(show: Record<string, unknown>) {
  const now = Date.now();
  await settings.update({
    shows: [{ id: 's_strict', name: 'Strict Hour', personaId: settings.get().personas[0].id, playlistIds: ['pin'], playlistStrict: true, ...show }],
    scheduleOverride: { showId: 's_strict', startedAt: now - 60_000, expiresAt: now + 3_600_000 },
  } as never);
  clearPlaylistCache();
}

// The settings save behind onAir starts a refresh of its own; let it land, so
// the lines read are this build's.
async function build() {
  await refreshAutoPlaylist();
  queue.djLog = [];
  await refreshAutoPlaylist();
}

const air = (song: Song) => queue.onTrackStarted({ subsonic_id: song.id, title: song.title, artist: song.artist } as never);

beforeEach(() => {
  starred = []; playlist = [];
  queue.djLog = [];
  q.upcoming = [];
  q.lastSeenKey = null;
  writeFileSync(join(root, 'auto.m3u'), '#EXTM3U');
});

test('a clean strict show whose pinned tracks are all tagged coasts off-playlist, and says so', async () => {
  await onAir({ excludeExplicit: true });
  playlist = [track('pin-a', { explicit: true }), track('pin-b', { explicit: true })];
  starred = [track('star-clean')];
  await build();
  assert.deepEqual(coastIds(), ['star-clean'], 'the never-starve stays: the station keeps playing');
  const lines = unenforcedLines();
  assert.equal(lines.length, 1, boothLines().join(' | '));
  assert.match(lines[0], /STRICT playlist for show "Strict Hour" left nothing that may air \(2 pinned: 2 tagged explicit on a clean show\)/);
  assert.match(lines[0], /coasting on 1 off-playlist track\(s\)/);
  assert.match(refreshedLine(), /playlist=Anchor \(strict, unenforced\)/);
});

test('a strict show whose pinned tracks all run past an exclude-mode maximum says so', async () => {
  // Fixtures first: each settings save starts a refresh that memoises the playlist.
  playlist = [track('pin-long', { duration: 900 })];
  starred = [track('star-short', { duration: 200 })];
  await settings.update({ maxTrackLengthMode: 'exclude' } as never);
  await onAir({ maxTrackSeconds: 300 });
  try {
    await build();
    assert.deepEqual(coastIds(), ['star-short']);
    assert.match(unenforcedLines()[0] ?? '', /1 pinned: 1 over the 300s maximum length/, boothLines().join(' | '));
    assert.match(refreshedLine(), /\(strict, unenforced\)/);
  } finally {
    await settings.update({ maxTrackLengthMode: 'cut' } as never);
  }
});

test('an enforced strict playlist is "(strict)" and says nothing more', async () => {
  await onAir({});
  playlist = [track('pin-ok')];
  starred = [track('star-other')];
  await build();
  assert.deepEqual(coastIds(), ['pin-ok']);
  assert.deepEqual(unenforcedLines(), []);
  assert.match(refreshedLine(), /playlist=Anchor \(strict\)/);
});

test('an untracked play the coast does not hold is logged, never skipped; the coast\'s own plays are quiet', async (t) => {
  await onAir({});
  playlist = [track('first-show')];
  await refreshAutoPlaylist();
  playlist = [track('second-show')];
  clearPlaylistCache();
  await refreshAutoPlaylist();
  assert.deepEqual(coastIds(), ['second-show']);
  // Past the replaced file's grace: the mixer reloaded it long ago.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + REPLACED_COAST_GRACE_MS + 60_000 });
  queue.djLog = [];
  commands.length = 0;

  air(track('second-show'));
  assert.deepEqual(offCoastLines(), [], 'the coast\'s own track');

  air(track('first-show'));
  const lines = offCoastLines();
  assert.equal(lines.length, 1, boothLines().join(' | '));
  assert.match(lines[0], /"Title first-show"/);
  assert.match(lines[0], /show "Strict Hour" \(strict playlist\)/);
  assert.equal(q.current.source, 'auto', 'still recorded as the coast it aired from');
  assert.ok(!commands.some(c => /skip/.test(c)), `the queue never skips it (${commands.join(', ')})`);
});

test('an untracked play while a sent pick is unmatched is quiet: it may be that pick under another name', async (t) => {
  await onAir({});
  playlist = [track('coast-only')];
  await refreshAutoPlaylist();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + REPLACED_COAST_GRACE_MS + 60_000 });
  q.reconcileWithDjQueue = async () => {};
  q.upcoming = [{ track: track('picked'), sent: true, aiPicked: true }];
  queue.djLog = [];
  air({ id: 'mixer-says-other', title: 'Retagged title', artist: 'Someone', duration: 200 });
  assert.deepEqual(offCoastLines(), []);
});
