// The Station login on the wire (#764, #1873). Android's fetch (OkHttp) and
// image loaders never send a login from URL userinfo, so every request to the
// station carries it as an `Authorization` header from one helper, and the
// API goes to the credential-free base. Images keep the userinfo as well, for
// RNTP's iOS lock-screen artwork, which takes no headers.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createApi, loginHeaders, type StationApi } from '../src/lib/api.ts';
import { authorizationFor, type StationCredentials } from '../src/lib/station-credentials.ts';

const LOGIN: StationCredentials = { username: 'dj', password: 'p@ss:word' };
const BASIC = authorizationFor(LOGIN);

interface Sent {
  url: string;
  method: string;
  headers: Headers;
}

/** Stub the global fetch for one test: record each request, answer `reply`. */
function stubFetch(t: TestContext, reply: () => Response = () => Response.json({})): Sent[] {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    return reply();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return sent;
}

/** Every method that asks the station something, by the path it asks. */
const CALLS: [string, (api: StationApi) => Promise<unknown>][] = [
  ['/api/now-playing', (a) => a.nowPlaying()],
  ['/api/state', (a) => a.state()],
  ['/api/session', (a) => a.session()],
  ['/api/schedule', (a) => a.schedule()],
  ['/api/dj', (a) => a.dj()],
  ['/api/themes', (a) => a.themes()],
  ['/api/health', (a) => a.health()],
  ['/api/health', (a) => a.probeHealth()],
  ['/api/request', (a) => a.postRequest({ text: 'a song' })],
  ['/api/request/abc', (a) => a.pollRequest('abc')],
  ['/api/like', (a) => a.likeCurrent('song-1')],
  ['/api/like', (a) => a.likeStatus()],
  ['/api/beacon', (a) => a.postBeacon({ path: '/app' })],
  ['/api/lyrics/current?songId=song-1', (a) => a.currentLyrics('song-1')],
  ['/api/station-auth', (a) => a.checkStationAuth('station-pw')],
];

test('loginHeaders adds the login to the headers it is given, and nothing without one', () => {
  assert.deepEqual(loginHeaders(BASIC), { Authorization: BASIC });
  assert.deepEqual(loginHeaders(BASIC, { 'Content-Type': 'application/json' }), {
    'Content-Type': 'application/json',
    Authorization: BASIC,
  });
  assert.deepEqual(loginHeaders(BASIC, { Authorization: 'Basic stale' }), { Authorization: BASIC });
  assert.equal(loginHeaders(null), undefined);
  const own = { 'x-station-auth': 'pw' };
  assert.equal(loginHeaders(null, own), own);
});

test('every station request carries the login as a header, on a URL with no userinfo', async (t) => {
  const sent = stubFetch(t);
  const api = createApi('https://radio.example', LOGIN);
  for (const [, call] of CALLS) await call(api);
  assert.deepEqual(
    sent.map((s) => s.url),
    CALLS.map(([path]) => `https://radio.example${path}`),
  );
  for (const s of sent) assert.equal(s.headers.get('authorization'), BASIC, s.url);
  // The stream gets the very same header.
  assert.deepEqual(api.streamHeaders(), { Authorization: BASIC });
});

test("a request's own headers survive the login", async (t) => {
  const sent = stubFetch(t);
  const api = createApi('https://radio.example', LOGIN, () => 'station-pw');
  await api.currentLyrics('song-1');
  await api.checkStationAuth('station-pw');
  assert.equal(sent[0].headers.get('x-station-auth'), 'station-pw');
  assert.equal(sent[0].headers.get('authorization'), BASIC);
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].headers.get('content-type'), 'application/json');
  assert.equal(sent[1].headers.get('authorization'), BASIC);
});

test('a station with no login sends no Authorization header', async (t) => {
  const sent = stubFetch(t);
  const api = createApi('https://radio.example', null);
  for (const [, call] of CALLS) await call(api);
  assert.equal(sent.length, CALLS.length);
  for (const s of sent) assert.equal(s.headers.has('authorization'), false, s.url);
  assert.equal(api.streamHeaders(), undefined);
  assert.equal(api.imageHeaders(api.cover('song-1')), undefined);
});

test('a legacy userinfo address sends its login as the header, never in the URL', async (t) => {
  const sent = stubFetch(t);
  const api = createApi('https://dj:secret@radio.example/');
  await api.state();
  assert.equal(sent[0].url, 'https://radio.example/api/state');
  assert.equal(sent[0].headers.get('authorization'), authorizationFor({ username: 'dj', password: 'secret' }));
});

test("a health probe says whether a 401 carried a login challenge", async (t) => {
  const replies = [
    new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="radio"' } }),
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
  ];
  stubFetch(t, () => replies.shift()!);
  const api = createApi('https://radio.example', LOGIN);
  assert.deepEqual(await api.probeHealth(), { ok: false, kind: 'http', status: 401, challenged: true });
  assert.deepEqual(await api.probeHealth(), { ok: false, kind: 'http', status: 401, challenged: false });
  assert.deepEqual(await api.probeHealth(), { ok: false, kind: 'http', status: 403, challenged: false });
});

test("/station-auth reads a proxy's login challenge as unverified, never a wrong password", async (t) => {
  const replies = [
    new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="radio"' } }),
    new Response('', { status: 401 }),
    new Response('', { status: 200 }),
    new Response('', { status: 429 }),
  ];
  stubFetch(t, () => replies.shift()!);
  const api = createApi('https://radio.example', LOGIN);
  assert.equal(await api.checkStationAuth('station-pw'), 'unavailable');
  assert.equal(await api.checkStationAuth('station-pw'), 'denied');
  assert.equal(await api.checkStationAuth('station-pw'), 'ok');
  assert.equal(await api.checkStationAuth('station-pw'), 'rate-limited');
});

test('the stream URL never carries the login; the station password rides as ?auth=', () => {
  assert.equal(createApi('https://radio.example', LOGIN).streamUrl(), 'https://radio.example/stream.mp3');
  assert.equal(createApi('https://dj:secret@radio.example').streamUrl('ogg'), 'https://radio.example/stream.ogg');
  assert.equal(
    createApi('https://radio.example', LOGIN, () => 'station-pw').streamUrl(),
    'https://radio.example/stream.mp3?auth=station-pw',
  );
});

test('a station on a port, under a path, over http or on IPv6 keeps its address', async (t) => {
  const sent = stubFetch(t);
  for (const base of ['https://radio.example:8443', 'https://radio.example/radio', 'http://[fd00::1]:8000/radio/']) {
    const clean = base.replace(/\/$/, '');
    const api = createApi(base, LOGIN);
    await api.state();
    assert.equal(sent.at(-1)?.url, `${clean}/api/state`);
    assert.equal(sent.at(-1)?.headers.get('authorization'), BASIC);
    assert.equal(api.streamUrl(), `${clean}/stream.mp3`);
    assert.deepEqual(api.imageHeaders(api.cover('x')), { Authorization: BASIC }, base);
    assert.deepEqual(api.imageHeaders(`${clean}/api/persona-avatar/nova`), { Authorization: BASIC }, base);
  }
  assert.equal(sent.length, 3);
  // Another port is another origin.
  assert.equal(createApi('https://radio.example:8443', LOGIN).imageHeaders('https://radio.example:8444/x'), undefined);
});

test('a failed read names the URL without the login in it', async (t) => {
  stubFetch(t, () => new Response('nope', { status: 500 }));
  const api = createApi('https://radio.example', LOGIN);
  await assert.rejects(api.state(), (err: Error) => {
    assert.equal(err.message, '500 https://radio.example/api/state');
    return true;
  });
});

test('covers and avatars on the station get the login as a header; other hosts never do', () => {
  const api = createApi('https://radio.example', LOGIN);
  const cover = api.cover('song 1');
  // Kept as userinfo too, for the loader that takes no headers.
  assert.equal(cover, 'https://dj:p%40ss%3Aword@radio.example/api/cover/song%201');
  assert.deepEqual(api.imageHeaders(cover), { Authorization: BASIC });
  const avatar = api.avatar('/avatars/nova.png');
  assert.equal(avatar, 'https://dj:p%40ss%3Aword@radio.example/api/avatars/nova.png');
  assert.deepEqual(api.imageHeaders(avatar), { Authorization: BASIC });
  assert.deepEqual(api.imageHeaders('https://radio.example/api/cover/x'), { Authorization: BASIC });

  const elsewhere = api.avatar('https://cdn.example/nova.png');
  assert.equal(elsewhere, 'https://cdn.example/nova.png');
  assert.equal(api.imageHeaders(elsewhere), undefined);
  // A host that only starts with the station's name is another host.
  assert.equal(api.imageHeaders('https://radio.example.evil/api/cover/x'), undefined);
  assert.equal(api.imageHeaders('https://dj:p%40ss%3Aword@radio.example.evil/x'), undefined);
});
