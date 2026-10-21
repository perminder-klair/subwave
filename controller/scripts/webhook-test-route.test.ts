// POST /webhooks/:id/test reports the real delivery result.
//
// Webhooks are fire-and-forget with no retry, so the admin Test button is the
// operator's only way to confirm a hook works. Delivery swallowed every failure,
// so the route answered ok for a wrong URL, a dead host or a 401. Now a failure
// is a 502 whose reason is built from the HTTP status or an error code alone:
// never the endpoint's response body, never the hook URL (which may carry a
// token in its query string).
//
// Run: `npm test -- webhook-test-route`.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-webhook-test-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/webhooks.js');
const { deliveryErrorReason } = await import('../src/broadcast/webhooks.js');

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
  server.unref();
  return (server.address() as any).port;
}

// The receiving end: answers with the status named in the path, and echoes a
// body the route must not pass through.
let lastAuth: string | undefined;
const receiver = createServer((req, res) => {
  lastAuth = req.headers.authorization;
  req.resume();
  const status = Number(new URL(req.url ?? '/', 'http://x').pathname.slice(1)) || 200;
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end('receiver-body-must-not-leak');
});
const rport = await listen(receiver);

// A port that was open and is now closed: connection refused.
const closed = createServer();
const cport = await listen(closed);
await new Promise<void>((r) => closed.close(() => r()));

const app = express();
app.use(express.json());
app.use(router);
const base = `http://127.0.0.1:${await listen(createServer(app))}`;

const SECRET = 'tok_supersecret';
await settings.update({
  webhooks: [
    { id: 'good', url: `http://127.0.0.1:${rport}/200?key=${SECRET}`, events: ['track.play'], enabled: true, authHeader: 'Bearer abc' },
    { id: 'denied', url: `http://127.0.0.1:${rport}/401?key=${SECRET}`, events: ['track.play'], enabled: true },
    { id: 'dead', url: `http://127.0.0.1:${cport}/hook?key=${SECRET}`, events: ['track.play'], enabled: true },
  ],
});

async function fire(id: string) {
  const res = await fetch(`${base}/webhooks/${id}/test`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

test('a delivered test answers ok with the endpoint status, sending the stored auth header', async () => {
  const r = await fire('good');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { ok: true, status: 200 });
  assert.equal(lastAuth, 'Bearer abc');
});

test('a non-2xx answer is a 502 naming the status, without the endpoint body', async () => {
  const r = await fire('denied');
  assert.equal(r.status, 502, r.text);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.status, 401);
  assert.match(r.body.error, /HTTP 401/);
  assert.ok(!r.text.includes('receiver-body-must-not-leak'), r.text);
  assert.ok(!r.text.includes(SECRET), r.text);
});

test('an unreachable endpoint is a 502 naming the error code, without the URL', async () => {
  const r = await fire('dead');
  assert.equal(r.status, 502, r.text);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.status, null);
  assert.match(r.body.error, /ECONNREFUSED/);
  assert.ok(!r.text.includes(SECRET), r.text);
  assert.ok(!r.text.includes(String(cport)), r.text);
});

test('an unknown hook is still a 404', async () => {
  const r = await fire('nope');
  assert.equal(r.status, 404);
});

test('delivery reasons never carry the error message', () => {
  const urlError = new TypeError(`Failed to parse URL from http://x/?key=${SECRET}`);
  assert.equal(deliveryErrorReason(urlError), 'request failed');
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.match(deliveryErrorReason(abort), /no answer within 5s/);
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }) });
  assert.equal(deliveryErrorReason(refused), 'could not connect (ECONNREFUSED)');
  // A code that is not a plain token is not echoed.
  const odd = new TypeError('fetch failed', { cause: { code: `weird ${SECRET}` } });
  assert.equal(deliveryErrorReason(odd), 'request failed');
});
