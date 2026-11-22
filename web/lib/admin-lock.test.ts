import assert from 'node:assert/strict';
import test from 'node:test';
import { adminLockedUntil, lockRemaining } from './admin-lock';

const NOW = 1_000_000;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

test('reads the lock and how long it lasts', async () => {
  const res = json(429, { code: 'admin_locked' }, { 'Retry-After': '90' });
  assert.equal(await adminLockedUntil(res, NOW), NOW + 90_000);
});

test("an admin route's own 429 is not the lock", async () => {
  // POST /playlists/generate: a busy route must never read as a sign-in lock.
  assert.equal(await adminLockedUntil(json(429, { error: 'too many generations' }, { 'Retry-After': '5' }), NOW), null);
  assert.equal(await adminLockedUntil(new Response('busy', { status: 429 }), NOW), null);
});

test('only a 429 is ever the lock', async () => {
  assert.equal(await adminLockedUntil(json(401, { code: 'admin_locked' }), NOW), null);
});

test('leaves the body readable for the caller', async () => {
  const res = json(429, { code: 'admin_locked', error: 'locked' }, { 'Retry-After': '1' });
  await adminLockedUntil(res, NOW);
  assert.equal((await res.json() as { error: string }).error, 'locked');
});

test("falls back to the controller's window when a proxy drops Retry-After", async () => {
  assert.equal(await adminLockedUntil(json(429, { code: 'admin_locked' }), NOW), NOW + 15 * 60_000);
  assert.equal(await adminLockedUntil(json(429, { code: 'admin_locked' }, { 'Retry-After': 'soon' }), NOW), NOW + 15 * 60_000);
});

test('the countdown rounds up and never goes negative', () => {
  assert.equal(lockRemaining(NOW + 14 * 60_000 + 1, NOW), '15 min');
  assert.equal(lockRemaining(NOW + 60_000, NOW), '1 min');
  assert.equal(lockRemaining(NOW + 59_000, NOW), '59s');
  assert.equal(lockRemaining(NOW + 1, NOW), '1s');
  assert.equal(lockRemaining(NOW - 5_000, NOW), '0s');
});
