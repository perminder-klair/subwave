// Every route behind the Report Real Path card is the operator's alone. Reading
// the rows signs in to Navidrome with the station's password, and switching them
// writes to the operator's server, so an unauthenticated caller must get a 401
// and Navidrome must see nothing at all.
//
// In its own file: middleware/auth.ts reads ADMIN_USER/ADMIN_PASS once, at import,
// and scripts/navidrome-real-path.test.ts needs them unset to mount the same
// router bare. `npm test -- navidrome-real-path` runs both.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const { config } = await import('../src/config.js');
const express = (await import('express')).default;
const { router } = await import('../src/routes/settings/core.js');

const ROUTES = [
  ['GET', '/settings/navidrome/players'],
  ['POST', '/settings/navidrome/players/check'],
  ['POST', '/settings/navidrome/players/real-path'],
] as const;

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

let navidromeRequests = 0;
const navidrome = createServer((_req, res) => {
  navidromeRequests++;
  res.writeHead(404);
  res.end();
});
let app: Server;
let base = '';

before(async () => {
  await new Promise<void>(resolve => navidrome.listen(0, '127.0.0.1', resolve));
  config.navidrome.url = `http://127.0.0.1:${(navidrome.address() as AddressInfo).port}`;
  config.navidrome.user = 'radio';
  config.navidrome.password = 'secret';
  app = express().use(express.json()).use(router).listen(0, '127.0.0.1');
  await new Promise(resolve => app.once('listening', resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise(resolve => app.close(resolve));
  await new Promise(resolve => navidrome.close(resolve));
});

beforeEach(() => { navidromeRequests = 0; });

for (const [method, path] of ROUTES) {
  test(`${method} ${path} answers 401 without the admin login, and asks Navidrome nothing`, async () => {
    const bare = await fetch(`${base}${path}`, { method });
    assert.equal(bare.status, 401);
    const wrong = await fetch(`${base}${path}`, { method, headers: { authorization: basic('test-admin', 'nope') } });
    assert.equal(wrong.status, 401);
    assert.equal(navidromeRequests, 0);
  });

  test(`${method} ${path} answers the admin`, async () => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: basic('test-admin', 'test-pass') } });
    assert.equal(res.status, 200);
    assert.ok(navidromeRequests > 0, 'and that one reached the server');
  });
}
