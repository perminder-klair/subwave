// The Station login on the wire (#764, #1873). Android's fetch (OkHttp) and
// image loaders never send a login from URL userinfo, so every request to the
// station carries it as an `Authorization` header from one helper, and the
// API goes to the credential-free base. Images keep the userinfo as well, for
// RNTP's iOS lock-screen artwork, which takes no headers.

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test, { type TestContext } from 'node:test';
import { createApi, FETCH_TIMEOUT_MS, loginHeaders, type StationApi } from '../src/lib/api.ts';
import { authorizationFor, type StationCredentials } from '../src/lib/station-credentials.ts';
import { loginRefused } from '../src/lib/station-login.ts';
import type { StationAuthResult } from '../src/lib/station-password.ts';

const LOGIN: StationCredentials = { username: 'dj', password: 'p@ss:word' };
const BASIC = authorizationFor(LOGIN);

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  signal: AbortSignal;
}

/** Stub the global fetch for one test: record each request, answer `reply`. */
function stubFetch(
  t: TestContext,
  reply: (signal: AbortSignal) => Response | Promise<Response> = () => Response.json({}),
): Sent[] {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init!.signal!;
    sent.push({ url: String(input), method: init?.method ?? 'GET', headers: new Headers(init?.headers), signal });
    return reply(signal);
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

/** The calls that hand their caller's signal to the request. */
const SIGNALLED: [string, (api: StationApi, signal: AbortSignal) => Promise<unknown>][] = [
  ['nowPlaying', (a, s) => a.nowPlaying(s)],
  ['state', (a, s) => a.state(s)],
  ['session', (a, s) => a.session(s)],
  ['schedule', (a, s) => a.schedule(s)],
  ['dj', (a, s) => a.dj(s)],
  ['themes', (a, s) => a.themes(s)],
];

/** The two reads that bound a body, what each makes of `{"ok":false}`, and how
 *  each ends when it gives up: getJson rejects, /station-auth stays unverified. */
const BODY_READS: [
  name: string,
  status: number,
  read: (api: StationApi) => Promise<unknown>,
  arrived: unknown,
  gaveUp: Outcome,
][] = [
  ['getJson', 200, (a) => a.state(), { ok: false }, { failed: true }],
  ['/station-auth', 401, (a) => a.checkStationAuth('station-pw'), 'denied', { value: 'unavailable' }],
];

/** What a read of a stalled body does once its request is aborted. expo/fetch's
 *  native text() waits for a complete body: after a cancel iOS never gets one
 *  (NativeResponse.swift ends in errorReceived), and Android calls what it has
 *  complete (NativeResponse.kt), so the read resolves with the bytes so far. */
const ABORTED_READS = ['never settles', 'truncates', 'rejects'] as const;
type AbortedRead = (typeof ABORTED_READS)[number];

function stalledBody(signal: AbortSignal, aborted: AbortedRead, sentSoFar = ''): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (sentSoFar) controller.enqueue(new TextEncoder().encode(sentSoFar));
      signal.addEventListener('abort', () => {
        if (aborted === 'truncates') controller.close();
        if (aborted === 'rejects') controller.error(new Error('aborted'));
      });
    },
  });
}

interface Outcome {
  value?: unknown;
  failed?: boolean;
}

/** A read's outcome as it lands, undefined until then. A test here never awaits
 *  a read that can stall: in the test runner's per-file process, a promise that
 *  never settles hangs the run instead of failing it, and `npm test` with it. */
function watch(read: Promise<unknown>): { outcome?: Outcome } {
  const watched: { outcome?: Outcome } = {};
  read.then(
    (value) => {
      watched.outcome = { value };
    },
    () => {
      watched.outcome = { failed: true };
    },
  );
  return watched;
}

/** Let promises and stream reads run. Mock timers leave setImmediate alone. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The timers armed and neither fired nor cleared. Enable mock timers first. */
function liveTimers(t: TestContext): Set<unknown> {
  const live = new Set<unknown>();
  const { setTimeout: arm, clearTimeout: clear } = globalThis;
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms: number) => {
    const id = arm(() => {
      live.delete(id);
      fn();
    }, ms);
    live.add(id);
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id: ReturnType<typeof setTimeout>) => {
    live.delete(id);
    clear(id);
  });
  return live;
}

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

test("a health probe carries a failure's login challenge as sent", async (t) => {
  const twoHeaders = new Headers();
  twoHeaders.append('WWW-Authenticate', 'Bearer realm="x"');
  twoHeaders.append('WWW-Authenticate', 'Basic realm="y"');
  const replies = [
    new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="radio"' } }),
    new Response('', { status: 401, headers: twoHeaders }),
    new Response('', { status: 401, headers: { 'WWW-Authenticate': '' } }),
    new Response('', { status: 401 }),
    new Response('', { status: 403 }),
  ];
  stubFetch(t, () => replies.shift()!);
  const api = createApi('https://radio.example', LOGIN);
  const failed = (status: number, challenge?: string) => ({ ok: false, kind: 'http', status, challenge });
  assert.deepEqual(await api.probeHealth(), failed(401, 'Basic realm="radio"'));
  assert.deepEqual(await api.probeHealth(), failed(401, 'Bearer realm="x", Basic realm="y"'));
  assert.deepEqual(await api.probeHealth(), failed(401, ''));
  assert.deepEqual(await api.probeHealth(), failed(401));
  assert.deepEqual(await api.probeHealth(), failed(403));
});

test('only a Basic challenge refuses the login; /station-auth reads any challenge as unverified', async (t) => {
  // The refusal stops the player, so it needs the scheme the login answers.
  // /station-auth only tells a proxy from the controller, which never
  // challenges, so a correct station password behind any proxy is kept.
  const cases: [header: string | null, refused: boolean, stationAuth: StationAuthResult][] = [
    ['Basic realm="radio"', true, 'unavailable'],
    ['basic realm="radio"', true, 'unavailable'],
    ['Bearer realm="x", Basic realm="y"', true, 'unavailable'],
    ['Bearer realm="radio"', false, 'unavailable'],
    ['Digest realm="radio", qop="auth", nonce="abc"', false, 'unavailable'],
    ['', false, 'unavailable'],
    [null, false, 'denied'],
  ];
  let header: string | null = null;
  stubFetch(t, () =>
    Response.json({ ok: false }, { status: 401, headers: header === null ? {} : { 'WWW-Authenticate': header } }),
  );
  const api = createApi('https://radio.example', LOGIN);
  for (const [h, refused, stationAuth] of cases) {
    header = h;
    assert.equal(loginRefused(await api.probeHealth()), refused, `health: ${h}`);
    assert.equal(await api.checkStationAuth('station-pw'), stationAuth, `station-auth: ${h}`);
  }
});

test("/station-auth reads a proxy's login challenge as unverified, never a wrong password", async (t) => {
  const replies = [
    new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="radio"' } }),
    Response.json({ ok: false }, { status: 401 }),
    Response.json({ ok: true }, { status: 200 }),
    Response.json({ ok: false, error: 'too many attempts' }, { status: 429 }),
  ];
  stubFetch(t, () => replies.shift()!);
  const api = createApi('https://radio.example', LOGIN);
  assert.equal(await api.checkStationAuth('station-pw'), 'unavailable');
  assert.equal(await api.checkStationAuth('station-pw'), 'denied');
  assert.equal(await api.checkStationAuth('station-pw'), 'ok');
  assert.equal(await api.checkStationAuth('station-pw'), 'rate-limited');
});

test("/station-auth reads only the controller's own 401 as a wrong password (#2143)", async (t) => {
  // The controller's refusal is `401 {"ok":false}` on every version that has
  // the route. A forward-auth proxy's 401 carries no challenge and never
  // reached the password check, so the saved password must survive it.
  const cases: [reply: () => Response, result: StationAuthResult][] = [
    [() => Response.json({ ok: false }, { status: 401 }), 'denied'],
    // oauth2-proxy's API routes: plain text.
    [() => new Response('Unauthorized\n', { status: 401, headers: { 'Content-Type': 'text/plain' } }), 'unavailable'],
    // nginx auth_request passes the 401 on with its own page.
    [
      () =>
        new Response('<html><head><title>401 Authorization Required</title></head></html>', {
          status: 401,
          headers: { 'Content-Type': 'text/html' },
        }),
      'unavailable',
    ],
    [() => new Response('', { status: 401 }), 'unavailable'],
    [() => Response.json({ status: 'KO', message: 'Unauthorized' }, { status: 401 }), 'unavailable'],
  ];
  let reply = cases[0][0];
  stubFetch(t, () => reply());
  const api = createApi('https://radio.example', LOGIN);
  for (const [r, result] of cases) {
    reply = r;
    assert.equal(await api.checkStationAuth('station-pw'), result, (await r().text()) || '(empty)');
  }
});

test('/station-auth gives up on a 401 whose body never arrives, and keeps the password', async (t) => {
  // On a device fetch resolves on the headers, so the fetch's own timer has
  // stopped by the time the body is read. A body that stalls there must not
  // leave the visit check, the prompt or the stuck check waiting forever.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubFetch(t, () => new Response(new ReadableStream(), { status: 401 }));
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  let result: StationAuthResult | undefined;
  void createApi('https://radio.example', LOGIN)
    .checkStationAuth('station-pw')
    .then((r) => {
      result = r;
    });
  await settle();
  assert.equal(result, undefined, 'still reading the body');
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await settle();
  assert.equal(result, 'unavailable');
});

test('/station-auth still hears a refusal that lands just inside the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      body = controller;
    },
  });
  stubFetch(t, () => new Response(stream, { status: 401 }));
  const check = createApi('https://radio.example', LOGIN).checkStationAuth('station-pw');
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
  body.enqueue(new TextEncoder().encode('{"ok":false}'));
  body.close();
  assert.equal(await check, 'denied');
});

test('/station-auth leaves no timer running once a 401 is read', async (t) => {
  const armed = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  stubFetch(t, () => Response.json({ ok: false }, { status: 401 }));
  assert.equal(await createApi('https://radio.example', LOGIN).checkStationAuth('station-pw'), 'denied');
  assert.equal(cleared.mock.callCount(), armed.mock.callCount());
});

for (const [name, status, read, , gaveUp] of BODY_READS) {
  for (const aborted of ABORTED_READS) {
    test(`${name} aborts a stalled body's request at the deadline, not before (a read that ${aborted})`, async (t) => {
      // Every byte of the answer has come but the body never ends, so a read
      // that stops at the abort must not hand that answer on as the real one.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sent = stubFetch(t, (signal) => new Response(stalledBody(signal, aborted, '{"ok":false}'), { status }));
      const watched = watch(read(createApi('https://radio.example', LOGIN)));
      await settle();
      t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
      await settle();
      assert.equal(sent[0].signal.aborted, false, 'still inside the deadline');
      assert.equal(watched.outcome, undefined);
      t.mock.timers.tick(1);
      assert.equal(sent[0].signal.aborted, true);
      await settle();
      assert.deepEqual(watched.outcome, gaveUp);
    });
  }
}

for (const [name, status, read, arrived] of BODY_READS) {
  test(`${name} never aborts a body that lands inside the deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        body = controller;
      },
    });
    const sent = stubFetch(t, () => new Response(stream, { status }));
    const reading = read(createApi('https://radio.example', LOGIN));
    await settle();
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    body.enqueue(new TextEncoder().encode('{"ok":false}'));
    body.close();
    assert.deepEqual(await reading, arrived);
    t.mock.timers.tick(FETCH_TIMEOUT_MS * 2);
    assert.equal(sent[0].signal.aborted, false);
  });

  test(`${name} gets the whole timeout for its headers, then again for its body`, async (t) => {
    // The bound on a call is twice the timeout: a healthy but slow station's
    // body is not charged for the time its headers took.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let headers!: (res: Response) => void;
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        body = controller;
      },
    });
    const sent = stubFetch(t, () => new Promise<Response>((resolve) => (headers = resolve)));
    const reading = read(createApi('https://radio.example', LOGIN));
    await settle();
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    headers(new Response(stream, { status }));
    await settle();
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    assert.equal(sent[0].signal.aborted, false);
    body.enqueue(new TextEncoder().encode('{"ok":false}'));
    body.close();
    assert.deepEqual(await reading, arrived);
  });

  test(`${name} ends at twice the timeout when slow headers meet a stalled body`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let headers!: (res: Response) => void;
    const sent = stubFetch(t, () => new Promise<Response>((resolve) => (headers = resolve)));
    const reading = watch(read(createApi('https://radio.example', LOGIN)));
    await settle();
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    headers(new Response(new ReadableStream(), { status }));
    await settle();
    t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
    await settle();
    assert.equal(reading.outcome, undefined);
    t.mock.timers.tick(1);
    assert.equal(sent[0].signal.aborted, true);
  });
}

for (const [name, call] of SIGNALLED) {
  for (const aborted of ABORTED_READS) {
    test(`a caller's abort mid-body rejects ${name} and reaches the request (a read that ${aborted})`, async (t) => {
      // The feed's teardown and the onboarding probe's own timeout both land
      // here. Neither may wait for the body, nor for the deadline.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sent = stubFetch(t, (signal) => new Response(stalledBody(signal, aborted, '{"ok":false}')));
      const caller = new AbortController();
      const reading = watch(call(createApi('https://radio.example', LOGIN), caller.signal));
      await settle();
      assert.equal(sent[0].signal.aborted, false);
      caller.abort();
      assert.equal(sent[0].signal.aborted, true);
      await settle();
      assert.deepEqual(reading.outcome, { failed: true });
    });
  }
}

test("a caller's abort that lands with the headers still ends the read", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const caller = new AbortController();
  stubFetch(t, (signal) => {
    caller.abort();
    return new Response(stalledBody(signal, 'never settles'));
  });
  const reading = watch(createApi('https://radio.example', LOGIN).state(caller.signal));
  await settle();
  assert.deepEqual(reading.outcome, { failed: true });
});

test("a caller's abort still ends a request waiting on its headers", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejectOnAbort = (signal: AbortSignal) =>
    new Promise<Response>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'));
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const sent = stubFetch(t, rejectOnAbort);
  const api = createApi('https://radio.example', LOGIN);
  const caller = new AbortController();
  const reading = watch(api.state(caller.signal));
  await settle();
  caller.abort();
  await settle();
  assert.deepEqual(reading.outcome, { failed: true });
  assert.equal(sent[0].signal.aborted, true);
  const late = watch(api.state(caller.signal));
  await settle();
  assert.deepEqual(late.outcome, { failed: true });
  assert.equal(sent[1].signal.aborted, true, 'already aborted when it was asked');
});

test('no timer or listener outlives a request, however it ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = liveTimers(t);
  let reply: (signal: AbortSignal) => Response | Promise<Response> = () => Response.json({});
  stubFetch(t, (signal) => reply(signal));
  const api = createApi('https://radio.example', LOGIN);
  // One signal across every call, as StationLiveStatus's 30 s probe has it.
  const caller = new AbortController();
  const listeners = () => getEventListeners(caller.signal, 'abort').length;
  const nothingLeft = (ending: string) => {
    assert.equal(timers.size, 0, `timers after ${ending}`);
    assert.equal(listeners(), 0, `listeners after ${ending}`);
  };

  await api.state(caller.signal);
  nothingLeft('a healthy body');

  reply = () => new Response('nope', { status: 500 });
  await assert.rejects(api.state(caller.signal));
  nothingLeft('a failure whose body is never read');

  reply = () => new Response('<html>');
  await assert.rejects(api.state(caller.signal));
  nothingLeft('a body that is not JSON');

  reply = (signal) => new Response(stalledBody(signal, 'never settles'));
  const stalled = watch(api.state(caller.signal));
  await settle();
  assert.equal(timers.size, 1, 'the body deadline');
  assert.equal(listeners(), 1, "the caller's abort");
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await settle();
  assert.deepEqual(stalled.outcome, { failed: true });
  nothingLeft('a stalled body');

  reply = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const noHeaders = watch(api.state(caller.signal));
  await settle();
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await settle();
  assert.deepEqual(noHeaders.outcome, { failed: true });
  nothingLeft('headers that never came');

  reply = (signal) => new Response(stalledBody(signal, 'never settles'), { status: 401 });
  const refusal = watch(api.checkStationAuth('station-pw'));
  await settle();
  t.mock.timers.tick(FETCH_TIMEOUT_MS);
  await settle();
  assert.deepEqual(refusal.outcome, { value: 'unavailable' });
  assert.equal(timers.size, 0, 'timers after a stalled refusal');

  reply = (signal) => new Response(stalledBody(signal, 'never settles'));
  const abandoned = watch(api.state(caller.signal));
  await settle();
  caller.abort();
  await settle();
  assert.deepEqual(abandoned.outcome, { failed: true });
  nothingLeft("a caller's abort");
});

test('only a body that is read has a deadline: one nobody reads keeps its request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = liveTimers(t);
  const sent = stubFetch(t, (signal) => new Response(stalledBody(signal, 'never settles')));
  assert.deepEqual(await createApi('https://radio.example', LOGIN).probeHealth(), { ok: true });
  assert.equal(timers.size, 0);
  t.mock.timers.tick(FETCH_TIMEOUT_MS * 2);
  assert.equal(sent[0].signal.aborted, false);
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
