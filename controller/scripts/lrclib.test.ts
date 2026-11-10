// The LRCLIB client (music/lrclib.ts): the matching rules that keep a lyric
// file for a different cut out, the answer-vs-failure split, and the throttle.
// Driven against a fake LRCLIB, so the request it actually sends is checked.
//
// Run: `npm test -- lrclib`.
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  bestSearchMatch,
  createLrclibClient,
  leadArtist,
  searchTitle,
  type LrclibRecord,
} from '../src/music/lrclib.js';

interface Seen { path: string; params: Record<string, string>; ua: string | undefined; at: number }
const seen: Seen[] = [];
let answer: (path: string, params: URLSearchParams) => { status: number; body?: unknown } = () => ({ status: 404 });

function lrclibServer(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://x');
  seen.push({
    path: url.pathname,
    params: Object.fromEntries(url.searchParams),
    ua: req.headers['user-agent'],
    at: Date.now(),
  });
  const { status, body } = answer(url.pathname, url.searchParams);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '{}' : JSON.stringify(body));
}

const fake = createServer(lrclibServer);
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
const baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
after(() => fake.close());
beforeEach(() => {
  seen.length = 0;
});

const client = createLrclibClient({ baseUrl, minGapMs: 0, retryDelaysMs: [20, 20] });
const TRACK = { artist: 'Karan Aujla feat. Ikky', title: 'On Top (feat. Ikky)', album: 'Making Memories', durationSec: 201.4 };
const LRC = '[00:10.00]first line\n[00:14.00]second line';
const record = (over: Partial<LrclibRecord> = {}): LrclibRecord => ({
  id: 7, trackName: 'On Top', artistName: 'Karan Aujla', duration: 201, instrumental: false,
  plainLyrics: 'first line\nsecond line', syncedLyrics: LRC, ...over,
});

test('the credit comes off the artist and the title, and nothing else does', () => {
  assert.equal(leadArtist('Skrillex Feat. Chief Keef, Corbin'), 'Skrillex');
  assert.equal(leadArtist('Ikka & Sanjoy'), 'Ikka');
  assert.equal(leadArtist('Kanye West x Jay-Z'), 'Kanye West');
  assert.equal(leadArtist('AC/DC'), 'AC/DC', 'a slash is part of a name');
  assert.equal(searchTitle('Superman (feat. Manj Musik) [Remix]'), 'Superman [Remix]');
  assert.equal(searchTitle('Diamonds (Remix) [feat. Kanye West]'), 'Diamonds (Remix)');
  assert.equal(searchTitle('Feathers'), 'Feathers');
});

test('a search result counts only as the same cut: duration within 2s, title and artist agreeing', () => {
  const track = { ...TRACK, durationSec: 201 };
  assert.equal(bestSearchMatch([record({ duration: 203 })], track)?.id, 7, '2s is inside');
  assert.equal(bestSearchMatch([record({ duration: 204 })], track), null, 'an extended mix is not this file');
  assert.equal(bestSearchMatch([record({ trackName: 'Different Song' })], track), null);
  assert.equal(bestSearchMatch([record({ artistName: 'Someone Else' })], track), null);
  assert.equal(bestSearchMatch([record({ duration: null })], track), null, 'no duration, no match');
  const plain = record({ id: 1, syncedLyrics: null });
  const synced = record({ id: 2 });
  assert.equal(bestSearchMatch([plain, synced], track)?.id, 2, 'synced beats plain');
  // Letters of every script count, so a Gurmukhi title cannot fold to '' and
  // then agree with anything.
  const gurmukhi = { artist: 'ਦਿਲਜੀਤ', title: 'ਲਵਰ', durationSec: 180 };
  assert.equal(bestSearchMatch([record({ trackName: 'ਲਵਰ', artistName: 'ਦਿਲਜੀਤ', duration: 180 })], gurmukhi)?.id, 7);
  assert.equal(bestSearchMatch([record({ trackName: 'ਹੋਰ', artistName: 'ਦਿਲਜੀਤ', duration: 180 })], gurmukhi), null);
});

test('an exact synced hit is the answer, asked with the whole signature and a named User-Agent', async () => {
  answer = (path) => (path === '/api/get' ? { status: 200, body: record() } : { status: 500 });
  const found = await client.find(TRACK);
  assert.equal(found?.syncedLyrics, LRC);
  assert.equal(seen.length, 1, 'no search after an exact synced hit');
  assert.deepEqual(seen[0].params, {
    artist_name: TRACK.artist, track_name: TRACK.title, album_name: TRACK.album, duration: '201',
  });
  assert.match(seen[0].ua ?? '', /subwave/);
});

test('no exact hit falls back to a search on the lead artist and the uncredited title', async () => {
  answer = (path) => (path === '/api/get'
    ? { status: 404 }
    : { status: 200, body: [record({ id: 9, duration: 300 }), record({ id: 8 })] });
  const found = await client.find(TRACK);
  assert.equal(found?.id, 8, 'the result of another length is passed over');
  assert.deepEqual(seen.map((s) => s.path), ['/api/get', '/api/search']);
  assert.deepEqual(seen[1].params, { track_name: 'On Top', artist_name: 'Karan Aujla' });
});

test('a plain-only exact hit is searched past for a synced one, and kept when there is none', async () => {
  answer = (path) => (path === '/api/get'
    ? { status: 200, body: record({ id: 3, syncedLyrics: null }) }
    : { status: 200, body: [record({ id: 4 })] });
  assert.equal((await client.find(TRACK))?.id, 4);

  answer = (path) => (path === '/api/get'
    ? { status: 200, body: record({ id: 3, syncedLyrics: null }) }
    : { status: 200, body: [] });
  assert.equal((await client.find(TRACK))?.id, 3);
});

test('nothing anywhere is null, an answer worth remembering', async () => {
  answer = (path) => (path === '/api/get' ? { status: 404 } : { status: 200, body: [] });
  assert.equal(await client.find(TRACK), null);
});

test('a refused request is asked again, and an answer on a later try is used', async () => {
  let refusals = 2;
  answer = (path) => {
    if (path === '/api/get' && refusals > 0) {
      refusals -= 1;
      return { status: 503 };
    }
    return path === '/api/get' ? { status: 200, body: record() } : { status: 500 };
  };
  assert.equal((await client.find(TRACK))?.syncedLyrics, LRC);
  assert.equal(seen.length, 3, 'two refusals, then the answer');
});

test('refused on every try, or failing outright, throws, so it is never stored as a miss', async () => {
  for (const status of [429, 503]) {
    answer = () => ({ status });
    await assert.rejects(client.find(TRACK), /503 or 429 3 times/);
    assert.equal(seen.length, 3, `${status}: the first try and two retries, then no more`);
    seen.length = 0;
  }
  answer = () => ({ status: 500 });
  await assert.rejects(client.find(TRACK), /HTTP 500/);
  assert.equal(seen.length, 1, 'a server error is not retried');
  const dead = createLrclibClient({ baseUrl: 'http://127.0.0.1:9', minGapMs: 0, timeoutMs: 500 });
  await assert.rejects(dead.find(TRACK));
});

test('a Retry-After stretches the wait before the retry', async () => {
  let refused = false;
  answer = (path) => {
    if (!refused) {
      refused = true;
      return { status: 503 };
    }
    return path === '/api/get' ? { status: 200, body: record() } : { status: 404 };
  };
  const patient = createLrclibClient({ baseUrl, minGapMs: 0, retryDelaysMs: [10] });
  const real = globalThis.fetch;
  // The fake cannot set headers per answer, so this one is stubbed in.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await real(input, init);
    return res.status === 503
      ? new Response(null, { status: 503, headers: { 'Retry-After': '1' } })
      : res;
  }) as typeof fetch;
  try {
    const started = Date.now();
    assert.equal((await patient.find(TRACK))?.syncedLyrics, LRC);
    assert.ok(Date.now() - started >= 950, 'waited the second LRCLIB asked for, not 10ms');
  } finally {
    globalThis.fetch = real;
  }
});

test('no duration, artist or title means no request at all', async () => {
  answer = () => ({ status: 200, body: record() });
  assert.equal(await client.find({ ...TRACK, durationSec: 0 }), null);
  assert.equal(await client.find({ ...TRACK, durationSec: Number.NaN }), null);
  assert.equal(await client.find({ ...TRACK, artist: ' ' }), null);
  assert.equal(await client.find({ ...TRACK, title: '' }), null);
  assert.equal(seen.length, 0);
});

test('requests start at least the minimum gap apart, even when fired together', async () => {
  answer = () => ({ status: 404 });
  const spaced = createLrclibClient({ baseUrl, minGapMs: 120 });
  // Each find is a get then a search (both 404/empty), so three finds are six requests.
  await Promise.all([spaced.find(TRACK), spaced.find(TRACK), spaced.find(TRACK)]);
  assert.equal(seen.length, 6);
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].at - seen[i - 1].at >= 110, `request ${i} came ${seen[i].at - seen[i - 1].at}ms after the last`);
  }
});
