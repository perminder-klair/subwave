// The requireAdmin strike counter (middleware/auth.ts). Every case below runs on
// ONE shared client address, the shape of a station behind an edge that hides
// client addresses — where a per-address lock is a station-wide one.
import assert from 'node:assert/strict';
import { runMiddleware } from './test-utils/middleware.js';
import test, { beforeEach } from 'node:test';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';
const { requireAdmin, resetAdminLockout } = await import('../src/middleware/auth.js');

const SHARED = '198.51.100.77';
const GOOD = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;
const BAD = `Basic ${Buffer.from('test-admin:nope').toString('base64')}`;
// Every call a different password: only a new guess is a strike.
let guesses = 0;
const guess = () => `Basic ${Buffer.from(`test-admin:guess-${guesses++}`).toString('base64')}`;

interface Outcome { status: number; cookie?: string; body?: unknown; retryAfter?: unknown }

function call(opts: { auth?: string; ip?: string; cookie?: string } = {}): Outcome {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? SHARED };
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.cookie) headers.cookie = opts.cookie;
  const req = { headers, socket: { remoteAddress: '127.0.0.1' }, secure: false };
  const out = runMiddleware(requireAdmin, req);
  const header = out.headers['set-cookie'];
  const cookie = typeof header === 'string' ? header.split(';')[0] : undefined;
  return { status: out.nextCalled ? 200 : out.status!, cookie, body: out.body, retryAfter: out.headers['retry-after'] };
}

function signIn(): string {
  const out = call({ auth: GOOD });
  assert.equal(out.status, 200);
  assert.ok(out.cookie, 'a successful sign-in is handed a device cookie');
  return out.cookie;
}

beforeEach(() => resetAdminLockout());

test('ten bad passwords lock the address, and the lock refuses the right password too', () => {
  for (let i = 0; i < 9; i++) assert.equal(call({ auth: guess() }).status, 401);
  assert.equal(call({ auth: guess() }).status, 401, 'the tenth strike is still answered');
  assert.equal(call({ auth: guess() }).status, 429);
  assert.equal(call({ auth: GOOD }).status, 429, 'a lock that admitted a right guess would cap nothing');
});

test('one stale password is one strike, however often a client re-sends it', () => {
  for (let i = 0; i < 500; i++) assert.equal(call({ auth: BAD }).status, 401, 'a poller never trips the lock');
  assert.equal(call({ auth: GOOD }).status, 200);
});

test('a repeated guess spends no strike of the ten', () => {
  for (let i = 0; i < 50; i++) call({ auth: BAD });
  for (let i = 0; i < 8; i++) assert.equal(call({ auth: guess() }).status, 401);
  assert.equal(call({ auth: BAD }).status, 401, 'still only nine distinct guesses');
  assert.equal(call({ auth: guess() }).status, 401, 'the tenth distinct guess locks');
  assert.equal(call({ auth: BAD }).status, 429);
});

test('a repeated guess re-counts only once its strike has decayed', t => {
  let now = 30_000_000;
  t.mock.method(Date, 'now', () => now);
  call({ auth: BAD });
  for (let i = 0; i < 8; i++) call({ auth: guess() });
  now += 16 * 60_000;
  for (let i = 0; i < 40; i++) call({ auth: BAD });
  for (let i = 0; i < 8; i++) assert.equal(call({ auth: guess() }).status, 401);
  assert.equal(call({ auth: GOOD }).status, 200, 'the poller holds one strike, not nine');
});

test('a lock tells a client what it is and how long it lasts', () => {
  for (let i = 0; i < 10; i++) call({ auth: guess() });
  const locked = call({ auth: GOOD });
  assert.equal(locked.status, 429);
  assert.equal((locked.body as { code?: string }).code, 'admin_locked', 'an admin route has 429s of its own');
  assert.equal(locked.retryAfter, String(15 * 60));
});

test('a stranger on the same address cannot lock out a signed-in console', () => {
  const cookie = signIn();
  for (let i = 0; i < 12; i++) call({ auth: guess() });
  assert.equal(call({ auth: guess() }).status, 429, 'the stranger is locked');
  assert.equal(call({ auth: GOOD, cookie }).status, 200, 'the console keeps working');
});

test("the operator's success does not reset a stranger's strikes", () => {
  for (let i = 0; i < 9; i++) call({ auth: guess() });
  signIn();                                         // same address, no cookie yet
  assert.equal(call({ auth: guess() }).status, 401, 'tenth strike');
  assert.equal(call({ auth: guess() }).status, 429, 'locked — the success cleared nothing');
});

test("a device's own failures lock only that device", () => {
  const cookie = signIn();
  for (let i = 0; i < 10; i++) call({ auth: guess(), cookie });
  assert.equal(call({ auth: GOOD, cookie }).status, 429);
  assert.equal(call({ auth: GOOD }).status, 200, 'the address counter was never touched');
});

test('a forged or malformed device cookie is ignored', () => {
  for (let i = 0; i < 10; i++) call({ auth: guess() });
  const forged = `subwave_admin_device=${'A'.repeat(22)}.${'B'.repeat(43)}`;
  assert.equal(call({ auth: GOOD, cookie: forged }).status, 429, 'falls back to the locked address');
  assert.equal(call({ auth: GOOD, cookie: 'subwave_admin_device=garbage' }).status, 429);
});

test('a request with no credentials is refused but spends no strike', () => {
  for (let i = 0; i < 50; i++) assert.equal(call().status, 401);
  assert.equal(call({ auth: GOOD }).status, 200);
});

test('strikes decay with time instead of accumulating forever', t => {
  let now = 10_000_000;
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 9; i++) call({ auth: guess() });
  now += 16 * 60_000;
  for (let i = 0; i < 9; i++) assert.equal(call({ auth: guess() }).status, 401);
  assert.equal(call({ auth: GOOD }).status, 200, 'eighteen typos over half an hour never locked');
});

test('a lapsed lock gives a fresh window, not one try per lockout', t => {
  let now = 20_000_000;
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 10; i++) call({ auth: guess() });
  assert.equal(call({ auth: GOOD }).status, 429);
  now += 15 * 60_000 + 1;
  assert.equal(call({ auth: guess() }).status, 401);
  assert.equal(call({ auth: GOOD }).status, 200);
});

test('many locked addresses do not stop a new address from being counted', () => {
  // The old >500-key cleanup deleted every unlocked counter, including the one
  // it had just written, so past 500 tracked keys nothing else could reach ten.
  for (let k = 0; k < 600; k++) {
    for (let i = 0; i < 10; i++) call({ auth: guess(), ip: `10.9.${k >> 8}.${k & 255}` });
  }
  const fresh = '203.0.113.200';
  for (let i = 0; i < 10; i++) call({ auth: guess(), ip: fresh });
  assert.equal(call({ auth: guess(), ip: fresh }).status, 429);
});
