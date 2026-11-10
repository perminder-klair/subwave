// POST /listener-auth answers only Icecast (#478). The edge denies the path,
// but the controller's router also answers a trailing slash and any case, so
// the handler refuses a call that came through a proxy itself. Driven through
// a real Express app so the router's own path matching is what is tested.
//
// Two properties: a forwarded call is a 404 before any password is compared
// (right or wrong, so the answer carries nothing), and Icecast's direct call
// keeps its fail-OPEN decision exactly as before.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-listener-auth-route-'));

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/public.js');
const { forwardedByProxy } = await import('../src/util/listener-auth.js');
const { resetListenerAuthFailures } = await import('../src/middleware/ratelimit.js');

const PW = 'hunter2-correct-horse';

const app = express();
app.use(router);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
  await res.text();
  return { status: res.status, admitted: res.headers.get('icecast-auth-user') === '1' };
}

const ADD = { action: 'listener_add', mount: '/stream.mp3' };

test('forwardedByProxy reads every header the documented edges add', () => {
  assert.equal(forwardedByProxy({}), false, 'Icecast sends none');
  assert.equal(forwardedByProxy(undefined), false);
  assert.equal(forwardedByProxy({ 'content-type': 'x', 'user-agent': 'Icecast 2.4.0-kh22' }), false);
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'via']) {
    assert.equal(forwardedByProxy({ [h]: '' }), true, `${h} marks a proxied call, even empty`);
  }
});

test('a forwarded call is refused before any password is compared', async () => {
  await settings.update({ privacy: { password: PW, listenerAuth: true } } as never);
  resetListenerAuthFailures();
  const xff = { 'x-forwarded-for': '203.0.113.9' };

  // Every path variant the router answers, right and wrong password alike:
  // identical 404s, so nothing distinguishes a correct guess.
  for (const path of ['/listener-auth', '/listener-auth/', '/Listener-Auth', '/LISTENER-AUTH/']) {
    for (const pass of [PW, 'wrong']) {
      const r = await post(path, { ...ADD, pass }, xff);
      assert.equal(r.status, 404, `${path} with a forwarding header is a 404`);
      assert.equal(r.admitted, false, `${path} never admits through a proxy`);
    }
  }
  assert.equal((await post('/listener-auth/', { ...ADD, pass: PW }, { forwarded: 'for=203.0.113.9' })).status, 404);
  assert.equal((await post('/listener-auth/', { ...ADD, pass: PW }, { 'cf-connecting-ip': '203.0.113.9' })).status, 404);
});

test('Icecast\'s direct call keeps its decision', async () => {
  await settings.update({ privacy: { password: PW, listenerAuth: true } } as never);
  resetListenerAuthFailures();

  const ok = await post('/listener-auth', { ...ADD, pass: PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.admitted, true, 'the right password admits');

  const tokenOk = await post('/listener-auth', { action: 'listener_add', mount: `/stream.mp3?auth=${PW}` });
  assert.equal(tokenOk.admitted, true, 'the ?auth= mount token still admits');

  const bad = await post('/listener-auth', { ...ADD, pass: 'wrong' });
  assert.equal(bad.status, 401, 'a wrong password is still a 401 for Icecast');
  assert.equal(bad.admitted, false);

  const remove = await post('/listener-auth', { action: 'listener_remove', mount: '/stream.mp3' });
  assert.equal(remove.admitted, true, 'disconnect bookkeeping is never denied');
  resetListenerAuthFailures();
});

test('ASYMMETRY: with stream auth off, Icecast is still admitted (fail OPEN)', async () => {
  await settings.update({ privacy: { password: PW, listenerAuth: false } } as never);
  const r = await post('/listener-auth', { ...ADD, pass: 'anything' });
  assert.equal(r.status, 200);
  assert.equal(r.admitted, true, 'the restart-grace window still admits every listener');
});
