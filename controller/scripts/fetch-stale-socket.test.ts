// fetchWithTimeout's retryStaleSocket: a request that dies on a connection the
// server already closed, before any response, is sent again, a bounded number
// of times, and nothing else is: an HTTP error status, a timeout and a caller
// that did not opt in all keep the single attempt.
//
// Production shape (4 Nov 2026): the tagger held the event loop for a few
// seconds, missed the analyzer's keep-alive idle close, and its next
// POST /embed-text went out on the dead socket and failed within a millisecond
// with UND_ERR_SOCKET "other side closed", so a whole descriptor pass was
// skipped. A server that destroys the socket mid-request produces the same
// rejection deterministically, which is what these tests stand up.

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';
import {
  STALE_SOCKET_ATTEMPTS,
  STALE_SOCKET_RETRY_MS,
  describeFetchError,
  fetchWithTimeout,
  isStaleSocketError,
} from '../src/util/fetch-timeout.js';

// Per path: how many requests to drop before answering, and how many arrived.
const dropFirst = new Map<string, number>();
const seen = new Map<string, number>();

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const path = req.url ?? '/';
  const n = (seen.get(path) ?? 0) + 1;
  seen.set(path, n);
  req.resume();
  req.on('end', () => {
    if (path.startsWith('/slow')) {
      setTimeout(() => { if (!res.destroyed) res.end('late'); }, 1_000);
      return;
    }
    if (path.startsWith('/late-drop')) {
      // The server took the request and was working on it when the connection
      // went: a resend would run it a second time.
      setTimeout(() => req.socket.destroy(), STALE_SOCKET_RETRY_MS + 200);
      return;
    }
    if (path.startsWith('/error')) {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    if (n <= (dropFirst.get(path) ?? 0)) {
      req.socket.destroy(); // no response: the client sees "other side closed"
      return;
    }
    res.end(`ok ${n}`);
  });
});

let base = '';
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (path: string, extra: { retryStaleSocket?: boolean; timeoutMs?: number } = {}) =>
  fetchWithTimeout(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: ['a recording of piano'] }),
    timeoutMs: extra.timeoutMs ?? 5_000,
    bodyDeadline: true,
    ...(extra.retryStaleSocket !== undefined ? { retryStaleSocket: extra.retryStaleSocket } : {}),
  });

test('a dropped connection is sent again on a fresh one and answers', async () => {
  dropFirst.set('/once', 1);
  const res = await post('/once', { retryStaleSocket: true });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok 2');
  assert.equal(seen.get('/once'), 2);
});

test('several dead sockets in a row still answer within the bound', async () => {
  dropFirst.set('/twice', STALE_SOCKET_ATTEMPTS - 1);
  const res = await post('/twice', { retryStaleSocket: true });
  assert.equal(await res.text(), `ok ${STALE_SOCKET_ATTEMPTS}`);
});

test('a connection that keeps dropping gives up after the bound, with the socket error', async () => {
  dropFirst.set('/always', 1_000);
  await assert.rejects(post('/always', { retryStaleSocket: true }), (err: unknown) => {
    assert.ok(isStaleSocketError(err), `not a stale-socket error: ${describeFetchError(err)}`);
    return true;
  });
  assert.equal(seen.get('/always'), STALE_SOCKET_ATTEMPTS);
});

test('without the opt-in a dropped connection fails on the first attempt', async () => {
  dropFirst.set('/optout', 1);
  await assert.rejects(post('/optout'), (err: unknown) => isStaleSocketError(err));
  assert.equal(seen.get('/optout'), 1);
});

test('an HTTP error status is an answer, never resent', async () => {
  const res = await post('/error', { retryStaleSocket: true });
  assert.equal(res.status, 500);
  await res.text();
  assert.equal(seen.get('/error'), 1);
});

test('a refused connection is a different failure, never resent', async () => {
  // Port 9 has no listener (run-tests.ts). Count the fetch() calls, since no
  // server sees them.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => { calls++; return realFetch(...args); }) as typeof fetch;
  try {
    await assert.rejects(
      fetchWithTimeout('http://127.0.0.1:9/', { method: 'POST', body: '{}', timeoutMs: 5_000, retryStaleSocket: true }),
      (err: unknown) => {
        assert.equal(isStaleSocketError(err), false, describeFetchError(err));
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 1);
});

test('a connection that drops after the stale-socket window is never resent', async () => {
  await assert.rejects(post('/late-drop', { retryStaleSocket: true }), (err: unknown) => isStaleSocketError(err));
  assert.equal(seen.get('/late-drop'), 1);
});

test('a timeout is never resent', async () => {
  await assert.rejects(post('/slow', { retryStaleSocket: true, timeoutMs: 150 }), (err: unknown) => {
    assert.equal(isStaleSocketError(err), false);
    return true;
  });
  assert.equal(seen.get('/slow'), 1);
});

test('the warning names the real cause', () => {
  const err = new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(describeFetchError(err), 'fetch failed (UND_ERR_SOCKET: other side closed)');
  assert.ok(isStaleSocketError(err));
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.equal(describeFetchError(abort), 'This operation was aborted (timed out or aborted)');
  assert.equal(isStaleSocketError(abort), false);
  assert.equal(isStaleSocketError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), false);
});
