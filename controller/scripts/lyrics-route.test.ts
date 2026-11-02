// GET /lyrics/current and PUT /lyrics/offsets/:trackId (routes/lyrics.ts),
// driven through a real Express app against a fake Navidrome, so the switch,
// the station gate, the recent-play window, the trim shift and the outage
// answer are all the route's own behaviour rather than a helper's.
//
// Run: `npm test -- lyrics-route`.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// ---- fake Navidrome --------------------------------------------------------
const lyricCalls = new Map<string, number>();
const ok = (body: Record<string, unknown>) => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } });
const synced = (lines: Array<[number, string]>) => ok({
  lyricsList: {
    structuredLyrics: [{ synced: true, lang: 'eng', line: lines.map(([start, value]) => ({ start, value })) }],
  },
});
const LYRICS: Record<string, () => { status: number; body: unknown }> = {
  'song-live': () => ({ status: 200, body: synced([[8000, 'first sung line'], [11_500, 'second sung line']]) }),
  'song-prev': () => ({ status: 200, body: synced([[4000, 'an earlier song']]) }),
  'song-auto': () => ({ status: 200, body: synced([[8000, 'auto line']]) }),
  'song-none': () => ({ status: 200, body: ok({ lyricsList: {} }) }),
  'song-gone': () => ({
    status: 200,
    body: { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 70, message: 'not found' } } },
  }),
  'song-down': () => ({ status: 500, body: 'navidrome fell over' }),
  // A server without the OpenSubsonic lyrics endpoint.
  'song-noapi': () => ({ status: 404, body: '404 page not found' }),
  'song-501': () => ({ status: 501, body: 'not implemented' }),
};

function navidrome(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  if (!url.pathname.includes('getLyricsBySongId')) {
    res.writeHead(404).end();
    return;
  }
  const id = url.searchParams.get('id') || '';
  lyricCalls.set(id, (lyricCalls.get(id) || 0) + 1);
  const answer = LYRICS[id]?.() ?? { status: 200, body: ok({ lyricsList: {} }) };
  res.writeHead(answer.status, { 'Content-Type': 'application/json' });
  res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
}

const fake = createServer(navidrome);
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));

const stateDir = createTempDir(join(tmpdir(), 'subwave-lyrics-route-'));
process.env.STATE_DIR = stateDir;
process.env.NAVIDROME_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASS = 'admin-pass';

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/lyrics.js');
const { router: publicRouter } = await import('../src/routes/public.js');
const { cors } = await import('../src/middleware/cors.js');

const app = express();
app.use(cors);
app.use(express.json());
app.use(router);
app.use(publicRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  fake.close();
  library.shutdown();
  await removeTempDir(stateDir);
});

const ADMIN = { Authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}` };

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, headers: res.headers, body: await res.json() as any };
}

async function put(path: string, body: unknown, headers: Record<string, string> = ADMIN) {
  const res = await fetch(base + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

let onAir: string | null = 'song-live';
queue.getNowPlaying = (async () => (onAir ? { subsonic_id: onAir, title: onAir, artist: 'A' } : null)) as never;

const play = (id: string, extra: Record<string, unknown> = {}) => ({
  track: { id, title: id, artist: 'A' },
  startedAt: new Date().toISOString(),
  ...extra,
});

beforeEach(async () => {
  onAir = 'song-live';
  // A drained request: the queue stamped the cue it handed Liquidsoap.
  queue.current = play('song-live', { source: 'request', cueInSec: 5.75 }) as never;
  queue.history = [
    play('song-prev', { source: 'dj' }),
    play('older-1', { source: 'dj' }),
    play('older-2', { source: 'dj' }),
    play('too-old', { source: 'dj' }),
  ] as never;
  // The music server's answers alone: the LRCLIB fallback (on by default) has
  // its own file, lyrics-lrclib-route.test.ts, with a fake LRCLIB.
  await settings.update({ lyrics: { enabled: true, lrclib: false }, privacy: { privatePlayer: false, listenerAuth: false } } as never);
});

test('switched off: the read refuses and /state says so', async () => {
  await settings.update({ lyrics: { enabled: false } } as never);
  const r = await get('/lyrics/current');
  assert.equal(r.status, 403);
  assert.equal(r.body.enabled, false);
  assert.deepEqual((await get('/state')).body.lyrics, { enabled: false });
  await settings.update({ lyrics: { enabled: true } } as never);
  assert.deepEqual((await get('/state')).body.lyrics, { enabled: true });
});

test('the on-air track, on the played timeline of the cue its play was given', async () => {
  const r = await get('/lyrics/current');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.body, {
    songId: 'song-live',
    synced: true,
    offsetMs: 0,
    lines: [
      { startMs: 2250, text: 'first sung line' },
      { startMs: 5750, text: 'second sung line' },
    ],
    source: 'music-server',
    pending: false,
  });
  assert.deepEqual((await get('/lyrics/current?songId=song-live')).body, r.body, 'naming it is the same answer');
});

test('a listener behind the live edge gets the track it is hearing, within the recent window only', async () => {
  const prev = await get('/lyrics/current?songId=song-prev');
  assert.equal(prev.status, 200);
  assert.deepEqual(prev.body.lines, [{ startMs: 4000, text: 'an earlier song' }], 'a play with no cue keeps file time');

  const old = await get('/lyrics/current?songId=too-old');
  assert.equal(old.status, 409, 'the fourth play back is outside the window');
  assert.equal(old.body.songId, 'song-live');
  assert.equal((await get('/lyrics/current?songId=never-aired')).status, 409);
  assert.equal(lyricCalls.get('never-aired'), undefined, 'a refused id never reaches the music server');
  assert.equal((await get(`/lyrics/current?songId=${'x'.repeat(201)}`)).status, 400);
});

test('a stem-blended play is not shifted: its clip is the track from byte zero under its own name', async () => {
  // The clip is the incoming track's head from byte 0 to the cue, annotated as
  // that track, so now-playing (and the listener's clock) starts at file time
  // 0. cueInSec on the item is where the real file resumes after the clip.
  queue.current = play('song-live', { source: 'dj', stemSeam: true, cueInSec: 7.7 }) as never;
  const r = await get('/lyrics/current');
  assert.deepEqual(r.body.lines, [
    { startMs: 8000, text: 'first sung line' },
    { startMs: 11_500, text: 'second sung line' },
  ]);
});

test('an auto-playlist play is shifted by the trim policy, which is what its playlist line carried', async () => {
  await library.load();
  db.upsertTrackMeta('song-auto', { title: 'song-auto', artist: 'A', album: 'B', duration: 200 });
  db.upsertTrackAnalysis('song-auto', { leadSilenceMs: 6000, tailSilenceMs: 0, tailStartMs: 200_000 } as never);
  await settings.update({ silenceTrim: { enabled: true, minGapMs: 1500 } } as never);
  onAir = 'song-auto';
  queue.current = play('song-auto', { source: 'auto' }) as never;
  try {
    const r = await get('/lyrics/current');
    assert.deepEqual(r.body.lines, [{ startMs: 2250, text: 'auto line' }]);
  } finally {
    await settings.update({ silenceTrim: { enabled: false } } as never);
  }
});

test('no lyrics and an unknown song are answers; an outage is a 503, asked again only after the window', async () => {
  for (const id of ['song-none', 'song-gone', 'song-noapi', 'song-501']) {
    onAir = id;
    queue.current = play(id, { source: 'dj' }) as never;
    const r = await get('/lyrics/current');
    assert.equal(r.status, 200, `${id} is an answer`);
    assert.deepEqual(r.body, { songId: id, synced: false, offsetMs: 0, lines: [], source: null, pending: false });
  }

  onAir = 'song-down';
  queue.current = play('song-down', { source: 'dj' }) as never;
  const down = await get('/lyrics/current');
  assert.equal(down.status, 503, 'a server that did not answer is never "no lyrics"');
  assert.equal(down.headers.get('retry-after'), '10');
  assert.equal(down.body.retryAfter, 10);
  const calls = lyricCalls.get('song-down');
  assert.equal((await get('/lyrics/current')).status, 503);
  assert.equal(lyricCalls.get('song-down'), calls, 'a poll inside the window does not reach the server');
});

test('a private station gates the read on the station password', async () => {
  await settings.update({ privacy: { password: 'station-pw-1', privatePlayer: true } } as never);
  try {
    assert.equal((await get('/lyrics/current')).status, 401);
    const r = await get('/lyrics/current', { 'x-station-auth': 'station-pw-1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.songId, 'song-live');
  } finally {
    await settings.update({ privacy: { privatePlayer: false } } as never);
  }
});

test('the operator offset: admin only, validated, station-wide, and reset by zero', async () => {
  assert.equal((await put('/lyrics/offsets/song-live', { offsetMs: 2900 }, {})).status, 401);
  for (const bad of [{ offsetMs: 30_001 }, { offsetMs: -30_001 }, { offsetMs: 1.5 }, { offsetMs: '2900' }, { offsetMs: 100, extra: 1 }, {}]) {
    assert.equal((await put('/lyrics/offsets/song-live', bad)).status, 400, JSON.stringify(bad));
  }

  const saved = await put('/lyrics/offsets/song-live', { offsetMs: 2900 });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { ok: true, trackId: 'song-live', offsetMs: 2900 });
  const r = await get('/lyrics/current');
  assert.equal(r.body.offsetMs, 2900);
  assert.equal(r.body.lines[0].startMs, 2250, 'the offset is never folded into the lines');

  assert.equal((await put('/lyrics/offsets/song-live', { offsetMs: 0 })).status, 200);
  assert.equal((await get('/lyrics/current')).body.offsetMs, 0);
});

test('nothing on air answers an empty payload rather than an error', async () => {
  onAir = null;
  queue.current = null;
  const r = await get('/lyrics/current');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { songId: null, synced: false, offsetMs: 0, lines: [], source: null, pending: false });
});

test('a cross-origin player may send the station password and read Retry-After', async () => {
  // A browser preflights a request carrying x-station-auth; a header missing
  // from Allow-Headers fails the request before it is sent.
  const pre = await fetch(`${base}/lyrics/current?songId=song-live`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://player.example',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'x-station-auth',
    },
  });
  assert.equal(pre.status, 200);
  const allowed = (pre.headers.get('access-control-allow-headers') || '').toLowerCase().split(/\s*,\s*/);
  assert.ok(allowed.includes('x-station-auth'), `allowed: ${allowed.join(', ')}`);
  const exposed = (pre.headers.get('access-control-expose-headers') || '').toLowerCase();
  assert.match(exposed, /retry-after/);
});
