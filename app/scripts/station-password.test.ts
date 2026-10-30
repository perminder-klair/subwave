// The app's private-station support (#478, #1848 item 1): the per-station
// password store, the ?auth= stream token, the /station-auth result mapping,
// and the rule deciding whether passwords already on the device open a lock.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStationPasswordStore,
  RATE_LIMIT_MAX_WAIT_MS,
  rateLimitedUntil,
  stationAuthResult,
  stationLockRequired,
  stationReadsOpen,
  verifyStoredPasswords,
  withStreamAuth,
  type StationAuthResult,
} from '../src/lib/station-password.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItemAsync: async (key: string) => data.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { data.set(key, value); },
  };
}

const A = 'https://a.example';
const B = 'https://b.example';

test('the password store keeps one password per station and forgets only its own', async () => {
  const storage = memoryStorage();
  const store = createStationPasswordStore(storage);
  assert.equal(await store.get(A), null);
  await store.set(A, 'alpha');
  await store.set(B, 'bravo');
  assert.equal(await store.get(A), 'alpha');
  await store.remove(A);
  assert.equal(await store.get(A), null);
  assert.equal(await store.get(B), 'bravo');
  await store.remove('https://never.example');
  assert.equal(await store.get(B), 'bravo');
});

test('the password store drops malformed entries and refuses a corrupt blob', async () => {
  const key = 'subwave.stationPasswords.v1';
  const store = createStationPasswordStore(
    memoryStorage({ [key]: JSON.stringify({ [A]: 'alpha', [B]: 7, 'https://c.example': '' }) }),
  );
  assert.equal(await store.get(A), 'alpha');
  assert.equal(await store.get(B), null);
  assert.equal(await store.get('https://c.example'), null, 'an empty password is not a password');
  await assert.rejects(createStationPasswordStore(memoryStorage({ [key]: '[]' })).get(A));
});

test('the stream carries the password as ?auth=, encoded, and nothing without one', () => {
  assert.equal(withStreamAuth(`${A}/stream.mp3`, null), `${A}/stream.mp3`);
  assert.equal(withStreamAuth(`${A}/stream.mp3`, ''), `${A}/stream.mp3`);
  assert.equal(withStreamAuth(`${A}/stream.mp3`, 'pw'), `${A}/stream.mp3?auth=pw`);
  assert.equal(withStreamAuth(`${A}/stream.mp3`, 'a b&c=d#?'), `${A}/stream.mp3?auth=a%20b%26c%3Dd%23%3F`);
  assert.equal(withStreamAuth(`${A}/stream.mp3?t=1`, 'pw'), `${A}/stream.mp3?t=1&auth=pw`);
});

test('either lock requires the password; absent flags are a public station', () => {
  assert.equal(stationLockRequired({ privatePlayer: true }), true);
  assert.equal(stationLockRequired({ listenerAuth: true }), true);
  assert.equal(stationLockRequired({ privatePlayer: false, listenerAuth: false }), false);
  assert.equal(stationLockRequired({}), false);
  assert.equal(stationLockRequired(undefined), false);
  assert.equal(stationLockRequired(null), false);
});

test('a gated read waits for a locked station’s proven password, never for open alone', () => {
  const phases = ['open', 'checking', 'prompt', 'ok'] as const;
  for (const privacy of [undefined, null, {}, { privatePlayer: false, listenerAuth: false }]) {
    for (const phase of phases) assert.equal(stationReadsOpen(privacy, phase), true);
  }
  for (const privacy of [{ privatePlayer: true }, { listenerAuth: true }]) {
    // 'open' is what the gate shows before /state lands, and for the render
    // in which a lock first appears.
    for (const phase of phases) assert.equal(stationReadsOpen(privacy, phase), phase === 'ok', `${phase}`);
  }
});

// What POST /station-auth has answered since #478. Every release has both:
// v0.45.0 to v1.28.0 send `res.status(ok ? 200 : 401).json({ ok })`.
const CONTROLLER_PASS = { body: { ok: true } };
const CONTROLLER_DENIAL = { body: { ok: false } };

test("only the controller's 401 means wrong; 429 is the rate limit; anything else says nothing", () => {
  assert.equal(stationAuthResult(200, CONTROLLER_PASS), 'ok');
  assert.equal(stationAuthResult(401, CONTROLLER_DENIAL), 'denied');
  assert.equal(stationAuthResult(429), 'rate-limited');
  for (const status of [null, 404, 500, 502, 403]) assert.equal(stationAuthResult(status), 'unavailable');
});

test("a proxy's login challenge never reads as a wrong station password (#1873)", async () => {
  // The controller's own 401 carries no WWW-Authenticate; a proxy refusing the
  // Station login always does, and the password never reached the controller.
  assert.equal(stationAuthResult(401, { ...CONTROLLER_DENIAL, challenged: true }), 'unavailable');
  assert.equal(stationAuthResult(401, { ...CONTROLLER_DENIAL, challenged: false }), 'denied');

  // So a saved station password checked through that proxy is kept, not forgotten.
  const verdict = await verifyStoredPasswords({
    stored: 'station-pw',
    login: 'proxy-pw',
    check: async () => stationAuthResult(401, { challenged: true }),
  });
  assert.deepEqual(verdict, { phase: 'ok', save: null, clearStored: false });
});

test("a forward-auth proxy's unchallenged 401 never reads as a wrong station password (#2143)", async () => {
  // oauth2-proxy in API mode, nginx auth_request, some Authelia setups: a 401
  // with no challenge, and a body that is not the controller's.
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

  const verdict = await verifyStoredPasswords({
    stored: 'station-pw',
    login: null,
    check: async () => stationAuthResult(401, { body: 'Unauthorized' }),
  });
  assert.deepEqual(verdict, { phase: 'ok', save: null, clearStored: false });
});

test("a 200 that is not the controller's own never reads as a right password (#2164)", async () => {
  // A forward-auth proxy's login page answers 200 with HTML, whatever the
  // password, and the request never reached the check.
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

test('a login page keeps a saved password, as offline does, and proves no other', async () => {
  const loginPage = async () => stationAuthResult(200, { body: undefined });

  const saved = await verifyStoredPasswords({ stored: 'station-pw', login: null, check: loginPage });
  assert.deepEqual(saved, { phase: 'ok', save: null, clearStored: false });

  // Read as 'ok', this would store a proxy's password as the station's.
  const fromLogin = await verifyStoredPasswords({ stored: null, login: 'proxy-pw', check: loginPage });
  assert.deepEqual(fromLogin, { phase: 'prompt', save: null, clearStored: false });
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

function checker(answers: Record<string, StationAuthResult>) {
  const asked: string[] = [];
  return {
    asked,
    check: async (pw: string) => {
      asked.push(pw);
      return answers[pw] ?? 'denied';
    },
  };
}

test('a stored password that still works is used, and nothing else is asked', async () => {
  const c = checker({ right: 'ok' });
  assert.deepEqual(await verifyStoredPasswords({ stored: 'right', login: 'proxy', check: c.check }), {
    phase: 'ok', save: null, clearStored: false,
  });
  assert.deepEqual(c.asked, ['right']);
});

test('a rejected stored password is forgotten and the listener is asked', async () => {
  const c = checker({});
  assert.deepEqual(await verifyStoredPasswords({ stored: 'rotated', login: null, check: c.check }), {
    phase: 'prompt', save: null, clearStored: true,
  });
});

test('an unverifiable stored password is kept and used — a blip must not sign anyone out', async () => {
  for (const result of ['unavailable', 'rate-limited'] as const) {
    const c = checker({ saved: result });
    assert.deepEqual(await verifyStoredPasswords({ stored: 'saved', login: 'other', check: c.check }), {
      phase: 'ok', save: null, clearStored: false,
    });
    assert.deepEqual(c.asked, ['saved'], 'and the login password is not tried behind it');
  }
});

test('the documented Station-login workaround is adopted without a re-prompt', async () => {
  const c = checker({ 'stream-pw': 'ok' });
  assert.deepEqual(await verifyStoredPasswords({ stored: null, login: 'stream-pw', check: c.check }), {
    phase: 'ok', save: 'stream-pw', clearStored: false,
  });
});

test('a login password that is not the station password is never trusted', async () => {
  for (const result of ['denied', 'unavailable', 'rate-limited'] as const) {
    const c = checker({ 'proxy-pw': result });
    assert.deepEqual(await verifyStoredPasswords({ stored: null, login: 'proxy-pw', check: c.check }), {
      phase: 'prompt', save: null, clearStored: false,
    });
  }
});

test('a rejected stored password falls through to a login password that works', async () => {
  const c = checker({ 'stream-pw': 'ok' });
  assert.deepEqual(await verifyStoredPasswords({ stored: 'rotated', login: 'stream-pw', check: c.check }), {
    phase: 'ok', save: 'stream-pw', clearStored: false,
  });
  assert.deepEqual(c.asked, ['rotated', 'stream-pw']);
});

test('the same password is never checked twice, and no password means ask', async () => {
  const c = checker({});
  await verifyStoredPasswords({ stored: 'same', login: 'same', check: c.check });
  assert.deepEqual(c.asked, ['same']);
  const none = checker({});
  assert.deepEqual(await verifyStoredPasswords({ stored: null, login: null, check: none.check }), {
    phase: 'prompt', save: null, clearStored: false,
  });
  assert.deepEqual(none.asked, []);
});
