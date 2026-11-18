// ADMIN_LOCKOUT=off, the operator's final say over the requireAdmin lock. In its
// own file because auth.ts reads the switch once, at import.
import assert from 'node:assert/strict';
import { runMiddleware } from './test-utils/middleware.js';
import test from 'node:test';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';
process.env.ADMIN_LOCKOUT = 'off';
const { requireAdmin } = await import('../src/middleware/auth.js');

const basic = (pass: string) => `Basic ${Buffer.from(`test-admin:${pass}`).toString('base64')}`;

function call(authorization: string) {
  const req = { headers: { 'x-forwarded-for': '198.51.100.77', authorization }, socket: { remoteAddress: '127.0.0.1' }, secure: false };
  const out = runMiddleware(requireAdmin, req);
  return out.nextCalled ? 200 : out.status;
}

test('no number of wrong passwords locks anyone out', () => {
  for (let i = 0; i < 200; i++) assert.equal(call(basic(`guess-${i}`)), 401);
  assert.equal(call(basic('test-pass')), 200);
});

test('the password is still checked', () => {
  assert.equal(call(basic('nope')), 401);
});
