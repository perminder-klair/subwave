// stationClient.currentLyrics: how each answer from GET /lyrics/current reaches
// the hook. Only `unavailable` is retried, so a refusal that lands there by
// mistake becomes a poll that never ends (a 401 also spends the address's
// station-read attempts on every try).
//
// Run: `npm test -- stationClient.lyrics`.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createStationClient } from './stationClient';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
});

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return calls;
}

const client = createStationClient({ apiUrl: 'http://station.test/api', streams: { mp3: '/s.mp3', opus: null } });
const payload = { songId: 'a b', synced: true, offsetMs: 0, lines: [{ startMs: 1000, text: 'x' }] };

test('a well-formed answer is ok, and the song id travels encoded', async () => {
  const calls = answer(200, payload);
  assert.deepEqual(await client.currentLyrics('a b'), { kind: 'ok', payload });
  assert.equal(calls[0]?.url, 'http://station.test/api/lyrics/current?songId=a%20b');
});

test('the LRCLIB fields come through, and a station without them still parses', async () => {
  const fromLrclib = { ...payload, source: 'lrclib', pending: true };
  answer(200, fromLrclib);
  assert.deepEqual(await client.currentLyrics('a b'), { kind: 'ok', payload: fromLrclib });
  // A newer station's unknown source must not turn its lines into an outage.
  answer(200, { ...payload, source: 'somewhere-new' });
  const r = await client.currentLyrics('a b');
  assert.equal(r.kind, 'ok');
  assert.equal(r.kind === 'ok' && r.payload.source, null);
});

test('refusals are answers, not outages', async () => {
  answer(403, { error: 'off', enabled: false });
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'disabled' });
  answer(409, { error: 'gone' });
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'gone' });
  answer(401, { error: 'station password required' });
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'locked' });
});

test('an outage carries the Retry-After it was given', async () => {
  answer(503, { error: 'down', retryAfter: 10 }, { 'Retry-After': '10' });
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'unavailable', retryAfterSec: 10 });
  answer(500, 'boom');
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'unavailable', retryAfterSec: null });
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'unavailable', retryAfterSec: null });
});

test('a malformed 200 is not shown as lyrics', async () => {
  answer(200, { songId: 's', lines: 'nope' });
  assert.deepEqual(await client.currentLyrics('s'), { kind: 'unavailable', retryAfterSec: null });
});

test('a stored station password rides the header, and nothing is sent without one', async () => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
  };
  let calls = answer(200, payload);
  await client.currentLyrics('s');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-station-auth'), null);

  store.set('subwave-station-auth', 'pw-1');
  calls = answer(200, payload);
  await client.currentLyrics('s');
  assert.equal(new Headers(calls[0]?.init?.headers).get('x-station-auth'), 'pw-1');
});
