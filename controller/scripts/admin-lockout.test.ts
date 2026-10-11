// The requireAdmin strike counter (middleware/auth.ts). Every case below runs on
// ONE shared client address, the shape of a station behind an edge that hides
// client addresses — where a per-address lock is a station-wide one.
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';
const { requireAdmin, resetAdminLockout } = await import('../src/middleware/auth.js');

const SHARED = '198.51.100.77';
const GOOD = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;
const BAD = `Basic ${Buffer.from('test-admin:nope').toString('base64')}`;

interface Outcome { status: number; cookie?: string }

function call(opts: { auth?: string; ip?: string; cookie?: string } = {}): Outcome {
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? SHARED };
  if (opts.auth) headers.authorization = opts.auth;
  if (opts.cookie) headers.cookie = opts.cookie;
  const req = { headers, socket: { remoteAddress: '127.0.0.1' }, secure: false };
  let status = 200;
  let cookie: string | undefined;
  const res = {
    setHeader() {},
    append(name: string, value: string) { if (name === 'Set-Cookie') cookie = value.split(';')[0]; },
    status(code: number) { status = code; return { json() {} }; },
  };
  let passed = false;
  requireAdmin(req, res, () => { passed = true; });
  return { status: passed ? 200 : status, cookie };
}

function signIn(): string {
  const out = call({ auth: GOOD });
  assert.equal(out.status, 200);
  assert.ok(out.cookie, 'a successful sign-in is handed a device cookie');
  return out.cookie;
}

beforeEach(() => resetAdminLockout());

test('ten bad passwords lock the address, and the lock refuses the right password too', () => {
  for (let i = 0; i < 9; i++) assert.equal(call({ auth: BAD }).status, 401);
  assert.equal(call({ auth: BAD }).status, 401, 'the tenth strike is still answered');
  assert.equal(call({ auth: BAD }).status, 429);
  assert.equal(call({ auth: GOOD }).status, 429, 'a lock that admitted a right guess would cap nothing');
});

test('a stranger on the same address cannot lock out a signed-in console', () => {
  const cookie = signIn();
  for (let i = 0; i < 12; i++) call({ auth: BAD });
  assert.equal(call({ auth: BAD }).status, 429, 'the stranger is locked');
  assert.equal(call({ auth: GOOD, cookie }).status, 200, 'the console keeps working');
});

test("the operator's success does not reset a stranger's strikes", () => {
  for (let i = 0; i < 9; i++) call({ auth: BAD });
  signIn();                                         // same address, no cookie yet
  assert.equal(call({ auth: BAD }).status, 401, 'tenth strike');
  assert.equal(call({ auth: BAD }).status, 429, 'locked — the success cleared nothing');
});

test("a device's own failures lock only that device", () => {
  const cookie = signIn();
  for (let i = 0; i < 10; i++) call({ auth: BAD, cookie });
  assert.equal(call({ auth: GOOD, cookie }).status, 429);
  assert.equal(call({ auth: GOOD }).status, 200, 'the address counter was never touched');
});

test('a forged or malformed device cookie is ignored', () => {
  for (let i = 0; i < 10; i++) call({ auth: BAD });
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
  for (let i = 0; i < 9; i++) call({ auth: BAD });
  now += 16 * 60_000;
  for (let i = 0; i < 9; i++) assert.equal(call({ auth: BAD }).status, 401);
  assert.equal(call({ auth: GOOD }).status, 200, 'eighteen typos over half an hour never locked');
});

test('a lapsed lock gives a fresh window, not one try per lockout', t => {
  let now = 20_000_000;
  t.mock.method(Date, 'now', () => now);
  for (let i = 0; i < 10; i++) call({ auth: BAD });
  assert.equal(call({ auth: GOOD }).status, 429);
  now += 15 * 60_000 + 1;
  assert.equal(call({ auth: BAD }).status, 401);
  assert.equal(call({ auth: GOOD }).status, 200);
});

test('many locked addresses do not stop a new address from being counted', () => {
  // The old >500-key cleanup deleted every unlocked counter, including the one
  // it had just written, so past 500 tracked keys nothing else could reach ten.
  for (let k = 0; k < 600; k++) {
    for (let i = 0; i < 10; i++) call({ auth: BAD, ip: `10.9.${k >> 8}.${k & 255}` });
  }
  const fresh = '203.0.113.200';
  for (let i = 0; i < 10; i++) call({ auth: BAD, ip: fresh });
  assert.equal(call({ auth: BAD, ip: fresh }).status, 429);
});
