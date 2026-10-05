import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

process.env.ADMIN_USER = 'test-admin';
process.env.ADMIN_PASS = 'test-pass';

const express = (await import('express')).default;
const { requireAdmin } = await import('../src/middleware/auth.js');
const { router } = await import('../src/routes/auth.js');

const app = express();
app.use(router);
app.get('/protected', requireAdmin, (_req, res) => res.json({ ok: true }));

const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const validAuthorization = `Basic ${Buffer.from('test-admin:test-pass').toString('base64')}`;
const invalidAuthorization = `Basic ${Buffer.from('test-admin:wrong-pass').toString('base64')}`;

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('UI admin auth check rejects without opening a Basic Auth challenge', async () => {
  const response = await fetch(`${base}/admin-auth`, {
    headers: { authorization: invalidAuthorization },
  });
  const body = await response.json() as { error?: string };

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(body.error, 'admin auth required');
});

test('UI admin auth check accepts valid credentials', async () => {
  const response = await fetch(`${base}/admin-auth`, {
    headers: { authorization: validAuthorization },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('ordinary admin routes retain the Basic Auth challenge', async () => {
  const response = await fetch(`${base}/protected`, {
    headers: { authorization: invalidAuthorization },
  });

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Basic realm="SUB/WAVE admin"');
});
