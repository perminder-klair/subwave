// The LRCLIB fallback end to end (music/lyrics-sources.ts behind
// routes/lyrics.ts and the queue's on-air hook): a fake Navidrome and a fake
// LRCLIB, so which source answers, when LRCLIB is asked, and what is
// remembered are the station's own behaviour rather than a helper's.
//
// The shared LRCLIB client keeps its real 1 req/s throttle, so a few of these
// tests wait on it; that is the throttle being exercised, not a slow test.
//
// Run: `npm test -- lyrics-lrclib-route`.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

// ---- fake Navidrome --------------------------------------------------------
const ok = (body: Record<string, unknown>) => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } });
const structured = (synced: boolean, lines: Array<[number, string]>) => ok({
  lyricsList: {
    structuredLyrics: [{
      synced, lang: 'eng',
      line: lines.map(([start, value]) => (synced ? { start, value } : { value })),
    }],
  },
});
const PLAIN = structured(false, [[0, 'plain words'], [0, 'more plain words']]);

function navidrome(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  const id = url.searchParams.get('id') || '';
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (url.pathname.includes('getSong')) {
    return send(200, ok({ song: { id, title: `Title ${id}`, artist: 'Artist feat. Guest', album: 'Album', duration: 200 } }));
  }
  if (url.pathname.includes('getLyricsBySongId')) {
    if (id.startsWith('timed-')) return send(200, structured(true, [[8000, 'the server has this one timed']]));
    if (id.startsWith('down-')) return send(500, 'navidrome fell over');
    return send(200, PLAIN);
  }
  send(404, '');
}

// ---- fake LRCLIB -----------------------------------------------------------
const lrclibAsked: string[] = [];
const LRC = '[00:10.00]first timed line\n[00:14.00]second timed line';

function lrclibServer(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  const title = url.searchParams.get('track_name') || '';
  lrclibAsked.push(`${url.pathname} ${title}`);
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // A 500, not a 503: the client retries a 503 over 20s (scripts/lrclib.test.ts
  // pins that), and this file is about what the station does once it gives up.
  if (title.includes('fail-')) return send(500, { message: 'fell over' });
  if (title.includes('miss-')) return url.pathname === '/api/get' ? send(404, {}) : send(200, []);
  send(200, {
    id: 99, trackName: title, artistName: 'Artist', duration: 200, instrumental: false,
    plainLyrics: 'first timed line\nsecond timed line', syncedLyrics: LRC,
  });
}

const fakeNavidrome = createServer(navidrome);
const fakeLrclib = createServer(lrclibServer);
await new Promise<void>((r) => fakeNavidrome.listen(0, '127.0.0.1', () => r()));
await new Promise<void>((r) => fakeLrclib.listen(0, '127.0.0.1', () => r()));

const stateDir = createTempDir(join(tmpdir(), 'subwave-lyrics-lrclib-'));
process.env.STATE_DIR = stateDir;
process.env.NAVIDROME_URL = `http://127.0.0.1:${(fakeNavidrome.address() as AddressInfo).port}`;
process.env.NAVIDROME_USER = 'u';
process.env.NAVIDROME_PASS = 'p';
process.env.LRCLIB_URL = `http://127.0.0.1:${(fakeLrclib.address() as AddressInfo).port}`;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const library = await import('../src/music/library.js');
const db = await import('../src/music/library-db.js');
const lyricsSources = await import('../src/music/lyrics-sources.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router } = await import('../src/routes/lyrics.js');

const app = express();
app.use(express.json());
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  fakeNavidrome.close();
  fakeLrclib.close();
  library.shutdown();
  await removeTempDir(stateDir);
});

interface LyricsBody {
  synced: boolean;
  offsetMs: number;
  lines: Array<{ startMs: number | null; text: string }>;
  source?: string | null;
  pending?: boolean;
}

async function lyricsFor(id: string) {
  const res = await fetch(`${base}/lyrics/current?songId=${encodeURIComponent(id)}`);
  return { status: res.status, body: await res.json() as LyricsBody };
}

let onAir = '';
queue.getNowPlaying = (async () => ({ subsonic_id: onAir, title: onAir, artist: 'A' })) as never;
function putOnAir(id: string, extra: Record<string, unknown> = {}) {
  onAir = id;
  queue.current = { track: { id, title: id, artist: 'A' }, startedAt: new Date().toISOString(), source: 'request', ...extra } as never;
  queue.history = [] as never;
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const askedAbout = (id: string) => lrclibAsked.filter((a) => a.includes(id)).length;

beforeEach(async () => {
  await settings.update({ lyrics: { enabled: true, lrclib: true } } as never);
});

test('switched off, LRCLIB is never asked and the answer is the music server\'s', async () => {
  await settings.update({ lyrics: { enabled: true, lrclib: false } } as never);
  putOnAir('plain-off');
  lyricsSources.onTrackStarted('plain-off');
  const r = await lyricsFor('plain-off');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'music-server');
  assert.equal(r.body.pending, false);
  assert.deepEqual(r.body.lines.map((l) => l.text), ['plain words', 'more plain words']);
  // A stored answer is not served while the switch is off either.
  db.setExternalLyrics('plain-off', { source: 'lrclib', syncedLrc: LRC, plainText: null, instrumental: false, externalId: '1' });
  assert.equal((await lyricsFor('plain-off')).body.source, 'music-server');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(askedAbout('plain-off'), 0);

  // The panel itself off turns the fallback off with it.
  await settings.update({ lyrics: { enabled: false, lrclib: true } } as never);
  assert.equal(lyricsSources.fallbackEnabled(), false);
});

test('a track with only plain lyrics gets LRCLIB\'s timed ones, moved by its cue and offset', async () => {
  putOnAir('plain-cued', { cueInSec: 2 });
  const first = await lyricsFor('plain-cued');
  assert.equal(first.status, 200);
  assert.equal(first.body.pending, true, 'the lookup it started is still running');
  assert.equal(first.body.source, 'music-server', 'never waits on LRCLIB');
  assert.equal(first.body.synced, false);

  await until(async () => (await lyricsFor('plain-cued')).body.pending === false, 'the lookup to land');
  await library.setLyricOffset('plain-cued', 1500);
  const r = await lyricsFor('plain-cued');
  assert.equal(r.body.source, 'lrclib');
  assert.equal(r.body.synced, true);
  assert.equal(r.body.offsetMs, 1500);
  assert.deepEqual(r.body.lines, [
    { startMs: 8000, text: 'first timed line' },
    { startMs: 12_000, text: 'second timed line' },
  ]);
  assert.ok(lrclibAsked.includes('/api/get Title plain-cued'), 'asked with the music server\'s title for the track');
  assert.equal(askedAbout('plain-cued'), 1, 'one exact hit, one request');
});

test('the on-air hook has the answer stored before anyone asks', async () => {
  putOnAir('plain-aired');
  lyricsSources.onTrackStarted('plain-aired');
  await until(() => db.getExternalLyrics('plain-aired') !== null, 'the stored answer');
  const r = await lyricsFor('plain-aired');
  assert.equal(r.body.source, 'lrclib');
  assert.equal(r.body.pending, false);
});

test('a track the music server already has timed is never looked up', async () => {
  putOnAir('timed-1');
  lyricsSources.onTrackStarted('timed-1');
  const r = await lyricsFor('timed-1');
  assert.equal(r.body.source, 'music-server');
  assert.equal(r.body.synced, true);
  assert.equal(r.body.pending, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(askedAbout('timed-1'), 0);
});

test('a miss is remembered, and not asked about again', async () => {
  putOnAir('miss-1');
  await lyricsFor('miss-1');
  await until(() => db.getExternalLyrics('miss-1') !== null, 'the stored miss');
  const stored = db.getExternalLyrics('miss-1');
  assert.equal(stored?.syncedLrc, null);
  assert.equal(stored?.plainText, null);
  const asked = askedAbout('miss-1');
  const r = await lyricsFor('miss-1');
  assert.equal(r.body.pending, false);
  assert.equal(r.body.source, 'music-server', 'the plain lyrics still show');
  assert.equal(askedAbout('miss-1'), asked);
});

test('an LRCLIB failure is not stored as a miss, and listeners do not ask again at once', async () => {
  putOnAir('fail-1');
  await lyricsFor('fail-1');
  await until(() => askedAbout('fail-1') > 0, 'the failed request');
  await until(async () => (await lyricsFor('fail-1')).body.pending === false, 'the lookup to give up');
  assert.equal(db.getExternalLyrics('fail-1'), null);
  const asked = askedAbout('fail-1');
  await lyricsFor('fail-1');
  lyricsSources.onTrackQueued('fail-1');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(askedAbout('fail-1'), asked, 'backing off');
});

test('a track is looked up when it is queued, before it airs', async () => {
  lyricsSources.onTrackQueued('plain-queued');
  await until(() => db.getExternalLyrics('plain-queued') !== null, 'the stored answer');
  const asked = askedAbout('plain-queued');
  putOnAir('plain-queued');
  lyricsSources.onTrackStarted('plain-queued');
  const r = await lyricsFor('plain-queued');
  assert.equal(r.body.source, 'lrclib');
  assert.equal(r.body.pending, false, 'answered before it aired');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(askedAbout('plain-queued'), asked, 'airing a settled track asks nothing');
});

test('a failure at queue time still leaves the play its own on-air try', async () => {
  // The queue-time lookup fails and backs the track off. The on-air hook is
  // exempt once per play: LRCLIB refuses in bursts, and the backoff is longer
  // than a song, so honouring it there would cost this play its lyrics.
  lyricsSources.onTrackQueued('fail-queued');
  await until(() => askedAbout('fail-queued') > 0, 'the queue-time request');
  await new Promise((r) => setTimeout(r, 100));
  const asked = askedAbout('fail-queued');
  putOnAir('fail-queued');
  lyricsSources.onTrackStarted('fail-queued');
  await until(() => askedAbout('fail-queued') > asked, 'the on-air request');
  assert.equal(db.getExternalLyrics('fail-queued'), null, 'still nothing stored');
});

test('queue.push() starts the lookup for the track it queues', async () => {
  await queue.push({ track: { id: 'plain-pushed', title: 'Pushed', artist: 'A' } } as never);
  await until(() => db.getExternalLyrics('plain-pushed') !== null, 'the stored answer');
  assert.ok(lrclibAsked.includes('/api/get Title plain-pushed'));
  queue.upcoming = [] as never;
});

test('the music server down: a stored timed answer stands in, and nothing stored is still a 503', async () => {
  putOnAir('down-stored');
  db.setExternalLyrics('down-stored', { source: 'lrclib', syncedLrc: LRC, plainText: null, instrumental: false, externalId: '5' });
  const r = await lyricsFor('down-stored');
  assert.equal(r.status, 200);
  assert.equal(r.body.source, 'lrclib');
  assert.equal(r.body.synced, true);

  putOnAir('down-empty');
  const empty = await lyricsFor('down-empty');
  assert.equal(empty.status, 503, 'never "no lyrics" for a server that did not answer');
  // That ask started a lookup, so the player's retry after Retry-After is
  // answered from LRCLIB while the music server is still down.
  await until(() => db.getExternalLyrics('down-empty') !== null, 'the lookup the 503 started');
  const retry = await lyricsFor('down-empty');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.source, 'lrclib');
});

test('the precedence, as one decision', () => {
  const timed = { synced: true, lines: [{ startMs: 1000, text: 'timed' }] };
  const plain = { synced: false, lines: [{ startMs: Number.NaN, text: 'plain' }] };
  const marker = { synced: true, lines: [{ startMs: 0, text: '[au: instrumental]' }] };
  assert.equal(lyricsSources.chooseLyrics(timed, timed).source, 'music-server');
  assert.equal(lyricsSources.chooseLyrics(plain, timed).source, 'lrclib');
  assert.equal(lyricsSources.chooseLyrics(marker, timed).source, 'lrclib', 'a marker is not timed lyrics');
  assert.equal(lyricsSources.chooseLyrics(plain, plain).source, 'music-server');
  assert.equal(lyricsSources.chooseLyrics(null, plain).source, 'lrclib');
  assert.deepEqual(lyricsSources.chooseLyrics(null, null), { lyrics: null, source: 'music-server' });
});
