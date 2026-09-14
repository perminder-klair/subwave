// A pooled keep-alive socket Navidrome has already closed fails the next request
// on it instantly with undici's bare `TypeError: fetch failed`. ping() and
// pingWith() each carried their own workaround; every real call had none, so the
// library count — thousands of back-to-back album requests kicked off from an
// idle admin page — died on its first request and reported "fetch failed", with
// no endpoint, no origin and no errno to act on.
//
// Three things are pinned here, each one easy to "simplify" back out:
//   1. a FAST transport failure is retried once, so the walk survives it;
//   2. a SLOW one is not — only the stale-socket-shaped failure gets a retry;
//   3. the error an operator finally sees names the endpoint, the origin and the
//      underlying code, and never the URL, which carries the auth token.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-subsonic-socket-'));
process.env.STATE_DIR = stateRoot;
// config.ts reads these at import time; the client builds its URL from them.
process.env.NAVIDROME_URL = 'http://navidrome.test:4533';
process.env.NAVIDROME_USER = 'dj';
process.env.NAVIDROME_PASS = 'hunter2';

const subsonic = await import('../src/music/subsonic.js');

// Mirrors the constant in subsonic.ts: the boundary for a stale-socket-shaped
// failure. Delivery safety is decided separately by each call site.
const STALE_SOCKET_RETRY_MS = 2_000;

const realFetch = globalThis.fetch;
const realWarn = console.warn;

function socketClosed() {
  const err: any = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  return err;
}

function albumListOk() {
  return new Response(
    JSON.stringify({ 'subsonic-response': { status: 'ok', albumList2: { album: [{ id: 'a1' }] } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function withFetch(stub: (url: string) => Promise<any>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    return stub(url);
  }) as any;
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

test.after(() => rmSync(stateRoot, { recursive: true, force: true }));

test('a fast socket failure is retried once and the call succeeds', async () => {
  console.warn = () => {};
  let n = 0;
  const calls = withFetch(async () => {
    n += 1;
    if (n === 1) throw socketClosed();
    return albumListOk();
  });

  const albums = await subsonic.getAlbumList(0, 500);

  assert.equal(calls.length, 2, 'the dead socket costs one retry, not the walk');
  assert.deepEqual(albums, [{ id: 'a1' }]);
});

test('a second fast failure gives up, naming endpoint, origin and errno', async () => {
  console.warn = () => {};
  const calls = withFetch(async () => { throw socketClosed(); });

  const err = await subsonic.getAlbumList(0, 500).then(
    () => null,
    (e: any) => e,
  );

  assert.ok(err, 'a sustained outage still fails');
  assert.equal(calls.length, 2, 'exactly one retry');
  assert.match(err.message, /getAlbumList2/, 'names the endpoint');
  assert.match(err.message, /http:\/\/navidrome\.test:4533/, 'names the origin');
  assert.match(err.message, /UND_ERR_SOCKET/, 'carries the underlying code');
  assert.match(err.message, /other side closed/, 'carries the underlying reason');
  assert.notEqual(err.message, 'fetch failed', 'never the bare undici message');
});

test('the error never leaks the auth token or password', async () => {
  console.warn = () => {};
  const calls = withFetch(async () => { throw socketClosed(); });

  const err = await subsonic.getAlbumList(0, 500).then(() => null, (e: any) => e);

  // The request URL carries `u`, `t` and `s`; the message must carry none of it.
  assert.ok(!err.message.includes('hunter2'));
  assert.ok(!err.message.includes('?'), 'no query string in the message');
  const token = new URL(calls[0]).searchParams.get('t');
  assert.ok(token && !err.message.includes(token), 'no salted token in the message');
});

test('a slow transport failure is not retried', async (t) => {
  console.warn = () => {};
  t.mock.timers.enable({ apis: ['Date'] });
  const calls = withFetch(async () => {
    // Past the fast-failure boundary: this request may already have been served.
    t.mock.timers.tick(STALE_SOCKET_RETRY_MS + 500);
    throw socketClosed();
  });

  const err = await subsonic.getAlbumList(0, 500).then(() => null, (e: any) => e);

  assert.ok(err);
  assert.equal(calls.length, 1, 'a slow failure is reported, never repeated');
});

test('a timeout keeps its own message and is never retried', async () => {
  console.warn = () => {};
  const calls = withFetch(async () => {
    const err: any = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  });

  const err = await subsonic.getAlbumList(0, 500).then(() => null, (e: any) => e);

  assert.equal(calls.length, 1, 'a timeout already waited the full budget');
  assert.match(err.message, /timed out after \d+ms/);
});
