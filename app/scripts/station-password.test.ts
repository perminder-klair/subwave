// The app's private-station support (#478, #1848 item 1): the per-station
// password store, the ?auth= stream token, the /station-auth result mapping,
// and the rule deciding whether passwords already on the device open a lock.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStationPasswordStore,
  stationAuthResult,
  stationLockRequired,
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

test('only 401 means wrong; 429 is the rate limit; anything else says nothing', () => {
  assert.equal(stationAuthResult(200), 'ok');
  assert.equal(stationAuthResult(401), 'denied');
  assert.equal(stationAuthResult(429), 'rate-limited');
  for (const status of [null, 404, 500, 502, 403]) assert.equal(stationAuthResult(status), 'unavailable');
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
