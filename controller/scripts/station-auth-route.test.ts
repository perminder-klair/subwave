// POST /station-auth's answers are a contract with every app already on a
// phone (#2164), so they are pinned here at the HTTP layer, through a real
// Express app. The app keeps a saved password unless it hears the controller
// itself, and tells the controller from whatever sits in front of it by these
// exact shapes (stationAuthResult, app/src/lib/station-password.ts):
//
// - 200 {"ok":true} proves the password. A login page's 200 does not.
// - 401 {"ok":false} with no WWW-Authenticate is a wrong password. A proxy's
//   401 keeps the saved one.
// - 429 carries Retry-After, which the stuck-password check waits out.
//
// Adding a field is safe. Changing a status, the type of `ok`, or adding a
// challenge makes released apps stop unlocking or stop noticing a rotation.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-station-auth-route-'));
process.env.STATE_DIR = stateDir;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/public.js');

const PW = 'hunter2-correct-horse';
const WINDOW_SECONDS = 15 * 60;
const LOCKS = [
  { privatePlayer: true, listenerAuth: false },
  { privatePlayer: false, listenerAuth: true },
  { privatePlayer: true, listenerAuth: true },
];

const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  await removeTempDir(stateDir);
});

// The limiter keys on the left-most forwarded address, so each test passes its
// own and starts with a full allowance of attempts.
async function post(ip: string, body: unknown) {
  const res = await fetch(`${base}/station-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function lock(privacy: { privatePlayer: boolean; listenerAuth: boolean }) {
  await settings.update({ privacy: { password: PW, ...privacy } } as never);
}

test('the right password answers 200 {"ok":true}, on either lock', async () => {
  for (const privacy of LOCKS) {
    await lock(privacy);
    const r = await post('203.0.113.1', { password: PW });
    assert.equal(r.status, 200, JSON.stringify(privacy));
    assert.deepEqual(r.body, { ok: true }, JSON.stringify(privacy));
  }
});

test('a station with no lock answers 200 {"ok":true} to any password', async () => {
  await lock({ privatePlayer: false, listenerAuth: false });
  const r = await post('203.0.113.2', { password: 'anything' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('a wrong password answers 401 {"ok":false} with no WWW-Authenticate, on either lock', async () => {
  for (const privacy of LOCKS) {
    await lock(privacy);
    for (const body of [{ password: 'wrong' }, { password: '' }, { password: 42 }, {}]) {
      const r = await post('203.0.113.3', body);
      const label = JSON.stringify({ privacy, body });
      assert.equal(r.status, 401, label);
      assert.deepEqual(r.body, { ok: false }, label);
      assert.equal(r.headers.get('www-authenticate'), null, label);
    }
  }
});

test('the 21st attempt in the window answers 429 with Retry-After, whatever the password', async () => {
  await lock({ privatePlayer: false, listenerAuth: true });
  const ip = '203.0.113.4';
  for (let i = 0; i < 20; i++) {
    const r = await post(ip, { password: i % 2 ? PW : 'wrong' });
    assert.equal(r.status, i % 2 ? 200 : 401, `attempt ${i + 1} is counted, not refused`);
  }
  const limited = await post(ip, { password: PW });
  assert.equal(limited.status, 429);
  assert.equal((limited.body as { ok: unknown }).ok, false);
  assert.equal(limited.headers.get('www-authenticate'), null);

  const retryAfter = limited.headers.get('retry-after');
  assert.match(retryAfter ?? '', /^\d+$/, 'whole seconds, the form the app reads');
  assert.ok(Number(retryAfter) > 0 && Number(retryAfter) <= WINDOW_SECONDS, `Retry-After: ${retryAfter}`);

  const other = await post('203.0.113.5', { password: PW });
  assert.equal(other.status, 200, 'the limit is per address');
});
