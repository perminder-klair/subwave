import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import {
  RATE_LIMIT_MAX_WAIT_MS,
  STATION_AUTH_TIMEOUT_MS,
  checkStationAuth,
  rateLimitedUntil,
  stationAuthFailureCopy,
  stationAuthResult,
  storedPasswordVerdict,
  type StationAuthCheck,
  type StationAuthResult,
} from './stationAuth';

// The classifier mirrors app/src/lib/station-password.ts, so these mirror
// app/scripts/station-password.test.ts and app/scripts/api.test.ts.

// What POST /station-auth has answered since #478.
const CONTROLLER_PASS = { body: { ok: true } };
const CONTROLLER_DENIAL = { body: { ok: false } };

test("only the controller's 401 means wrong; 429 is the rate limit; anything else says nothing", () => {
  assert.equal(stationAuthResult(200, CONTROLLER_PASS), 'ok');
  assert.equal(stationAuthResult(401, CONTROLLER_DENIAL), 'denied');
  assert.equal(stationAuthResult(429), 'rate-limited');
  for (const status of [null, 404, 500, 502, 503, 403]) assert.equal(stationAuthResult(status), 'unavailable');
});

test("a proxy's login challenge never reads as a wrong station password", () => {
  assert.equal(stationAuthResult(401, { ...CONTROLLER_DENIAL, challenged: true }), 'unavailable');
  assert.equal(stationAuthResult(401, { ...CONTROLLER_DENIAL, challenged: false }), 'denied');
});

test("a forward-auth proxy's unchallenged 401 never reads as a wrong station password", () => {
  const proxied: unknown[] = [
    undefined, // empty, or not JSON: plain-text "Unauthorized", an HTML page
    null,
    'Unauthorized',
    { error: 'Unauthorized' },
    { status: 'KO', message: 'Unauthorized' },
    { ok: 'false' },
    { ok: true },
    [false],
  ];
  for (const body of proxied) {
    assert.equal(stationAuthResult(401, { body }), 'unavailable', JSON.stringify(body));
  }
  // A later controller that says more keeps saying `ok: false`.
  assert.equal(stationAuthResult(401, { body: { ok: false, error: 'wrong password' } }), 'denied');
});

test("a 200 that is not the controller's own never reads as a right password", () => {
  const proxied: unknown[] = [
    undefined, // empty, or not JSON: an HTML login page
    null,
    'ok',
    {},
    { status: 'ok' },
    { ok: 'true' },
    { ok: 1 },
    { ok: false },
    [true],
  ];
  for (const body of proxied) {
    assert.equal(stationAuthResult(200, { body }), 'unavailable', JSON.stringify(body));
  }
  assert.equal(stationAuthResult(200), 'unavailable');
  // A later controller that says more keeps saying `ok: true`.
  assert.equal(stationAuthResult(200, { body: { ok: true, expires: 60 } }), 'ok');
});

test("a 429's Retry-After holds until then, up to the route's own window", () => {
  const now = 1_000_000;
  assert.equal(rateLimitedUntil('300', now), now + 300_000);
  assert.equal(rateLimitedUntil('1.5', now), now + 1_500);
  assert.equal(rateLimitedUntil('900', now), now + RATE_LIMIT_MAX_WAIT_MS, 'the longest the controller asks for');
  assert.equal(rateLimitedUntil('86400', now), now + RATE_LIMIT_MAX_WAIT_MS, "a day is not the controller's");
});

test('a Retry-After with no count of seconds holds nothing', () => {
  for (const header of [null, '', '0', '-5', 'soon', 'NaN', 'Infinity', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    assert.equal(rateLimitedUntil(header, 1_000_000), 0, String(header));
  }
});

test("only the station's own refusal forgets a stored password", () => {
  assert.deepEqual(storedPasswordVerdict('ok'), { phase: 'ok', clearStored: false });
  assert.deepEqual(storedPasswordVerdict('denied'), { phase: 'prompt', clearStored: true });
});

test('an unverifiable stored password is kept and used: a blip must not sign anyone out', () => {
  for (const result of ['unavailable', 'rate-limited'] as const) {
    assert.deepEqual(storedPasswordVerdict(result), { phase: 'ok', clearStored: false }, result);
  }
});

test('a typed password failure names what happened', () => {
  const now = 1_000_000;
  assert.equal(stationAuthFailureCopy('denied', 0, now), 'That password was not accepted.');
  assert.match(stationAuthFailureCopy('unavailable', 0, now), /^Could not reach the station\./);
  assert.match(stationAuthFailureCopy('rate-limited', 0, now), /^Too many attempts\. Wait a few minutes/);
});

test('a rate limit says how long is left, rounded up', () => {
  const now = 1_000_000;
  const copy = (ms: number) => stationAuthFailureCopy('rate-limited', now + ms, now);
  assert.equal(copy(1), 'Too many attempts. Try again in 1 second.');
  assert.equal(copy(45_000), 'Too many attempts. Try again in 45 seconds.');
  assert.equal(copy(60_000), 'Too many attempts. Try again in 1 minute.');
  assert.equal(copy(60_001), 'Too many attempts. Try again in 2 minutes.');
  assert.equal(copy(RATE_LIMIT_MAX_WAIT_MS), 'Too many attempts. Try again in 15 minutes.');
  // A wait that has run out names no time at all.
  assert.match(stationAuthFailureCopy('rate-limited', now, now), /Wait a few minutes/);
});

function stubFetch(t: TestContext, reply: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return reply();
  });
  return calls;
}

test("checkStationAuth posts the password to the controller's fail-closed route", async t => {
  const calls = stubFetch(t, () => Response.json({ ok: true }));
  await checkStationAuth('/api', 'station-pw');
  assert.equal(calls[0]?.url, '/api/station-auth');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.equal(calls[0]?.init?.body, JSON.stringify({ password: 'station-pw' }));
});

test("the controller's real answers", async t => {
  const cases: [reply: () => Response, result: StationAuthResult][] = [
    [() => Response.json({ ok: true }), 'ok'],
    [() => Response.json({ ok: false }, { status: 401 }), 'denied'],
    [() => Response.json({ ok: false, error: 'too many attempts' }, { status: 429 }), 'rate-limited'],
  ];
  let reply = cases[0]![0];
  stubFetch(t, () => reply());
  for (const [r, result] of cases) {
    reply = r;
    assert.equal((await checkStationAuth('/api', 'pw')).result, result);
  }
});

test("a proxy's answers say nothing about the password", async t => {
  const text = (body: string, status: number, contentType: string) => () =>
    new Response(body, { status, headers: { 'Content-Type': contentType } });
  const cases: Array<[name: string, reply: () => Response]> = [
    ['oauth2-proxy API routes', text('Unauthorized\n', 401, 'text/plain')],
    ['nginx auth_request', text('<html><head><title>401 Authorization Required</title></head></html>', 401, 'text/html')],
    ['empty 401', () => new Response('', { status: 401 })],
    ['Authelia-style JSON', () => Response.json({ status: 'KO', message: 'Unauthorized' }, { status: 401 })],
    ['challenged 401', () => Response.json({ ok: false }, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } })],
    ['login page', text('<html><head><title>Sign in</title></head></html>', 200, 'text/html')],
    ['empty 200', () => new Response('', { status: 200 })],
    ['plain 200', () => new Response('ok', { status: 200 })],
    ['empty object', () => Response.json({})],
    ['200 with ok false', () => Response.json({ ok: false })],
    ['200 with ok as text', () => Response.json({ ok: 'true' })],
    ['201', () => Response.json({ ok: true }, { status: 201 })],
    ['401 with ok true', () => Response.json({ ok: true }, { status: 401 })],
    ['500', () => Response.json({ ok: true }, { status: 500 })],
    ['502', text('<html>Bad Gateway</html>', 502, 'text/html')],
    ['404', () => new Response('Not found', { status: 404 })],
  ];
  let reply = cases[0]![1];
  stubFetch(t, () => reply());
  for (const [name, r] of cases) {
    reply = r;
    assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'unavailable', retryAt: 0 }, name);
  }
});

test('a network error says nothing about the password', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'unavailable', retryAt: 0 });
});

test("a 429 hands on when to ask again, and only a 429's header counts", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const limited = (retryAfter?: string) =>
    Response.json({ ok: false, error: 'too many attempts' }, {
      status: 429,
      headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
    });
  let reply = limited('300');
  stubFetch(t, () => reply);
  assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'rate-limited', retryAt: 1_300_000 });

  reply = limited();
  assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'rate-limited', retryAt: 0 });

  reply = new Response('Service Unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'unavailable', retryAt: 0 });
});

test("a 429 is read from its headers alone: a proxy's page still says when to ask again", async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  stubFetch(t, () => new Response('<html>Too Many Requests</html>', {
    status: 429,
    headers: { 'Content-Type': 'text/html', 'Retry-After': '30' },
  }));
  assert.deepEqual(await checkStationAuth('/api', 'pw'), { result: 'rate-limited', retryAt: 1_030_000 });
});

const realSetTimeout = globalThis.setTimeout;

/** A mutant that drops the deadline must fail here, not hang the suite. */
function settled<T>(check: Promise<T>): Promise<T> {
  return Promise.race([
    check,
    new Promise<never>((_, reject) => {
      realSetTimeout(() => reject(new Error('the check never settled')), 2000).unref();
    }),
  ]);
}

async function yieldToSockets() {
  await new Promise(resolve => setImmediate(resolve));
}

/** A real socket and the real fetch: a stub can't show that the abort reaches
 *  the body read, which is the part that decides whether the gate ever opens. */
async function stallingStation(t: TestContext, answer: (res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => answer(res));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

/** Resolves once fetch has handed back the headers. */
function watchHeaders(t: TestContext) {
  const realFetch = globalThis.fetch;
  let arrived = () => {};
  const headers = new Promise<void>(resolve => { arrived = resolve; });
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const res = await realFetch(...args);
    arrived();
    return res;
  });
  return headers;
}

async function assertGivesUpAtDeadline(t: TestContext, check: Promise<StationAuthCheck>) {
  let done = false;
  void check.then(() => { done = true; });
  t.mock.timers.tick(STATION_AUTH_TIMEOUT_MS - 1);
  await yieldToSockets();
  assert.equal(done, false, 'still inside the deadline');
  t.mock.timers.tick(1);
  assert.deepEqual(await settled(check), { result: 'unavailable', retryAt: 0 });
}

test('a request that never answers ends at the deadline, and proves nothing', async t => {
  let asked = () => {};
  const reached = new Promise<void>(resolve => { asked = resolve; });
  const api = await stallingStation(t, () => asked());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const check = checkStationAuth(api, 'pw');
  await settled(reached);
  await assertGivesUpAtDeadline(t, check);
});

for (const status of [200, 401]) {
  test(`a ${status} whose body never finishes ends at the deadline, and proves nothing`, async t => {
    const api = await stallingStation(t, res => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write(status === 200 ? '{"ok":' : '{"ok":f');
    });
    const headers = watchHeaders(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const check = checkStationAuth(api, 'pw');
    await settled(headers);
    await assertGivesUpAtDeadline(t, check);
  });
}

test('a pass that lands just inside the deadline is still heard', async t => {
  let finish = () => {};
  const api = await stallingStation(t, res => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"ok":');
    finish = () => res.end('true}');
  });
  const headers = watchHeaders(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const check = checkStationAuth(api, 'pw');
  await settled(headers);
  t.mock.timers.tick(STATION_AUTH_TIMEOUT_MS - 1);
  finish();
  assert.deepEqual(await settled(check), { result: 'ok', retryAt: 0 });
});

test('no timer is left running once the answer is read', async t => {
  const armed = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  stubFetch(t, () => Response.json({ ok: true }));
  assert.equal((await checkStationAuth('/api', 'pw')).result, 'ok');
  assert.equal(armed.mock.callCount(), 1);
  assert.equal(cleared.mock.callCount(), 1);
});
