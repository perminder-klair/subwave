import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AdminReadTimeoutError, runAdminRead } from '../lib/admin-read';
import { adminJson, AdminResponseError } from '../lib/admin-query';

test('a response whose JSON body stalls times out and cancels its actual fetch', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"values":');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let requestSignal: AbortSignal | undefined;
  try {
    await assert.rejects(runAdminRead({
      signal: new AbortController().signal, timeoutMs: 100,
      request: async signal => {
        requestSignal = signal;
        const response = await fetch(`http://127.0.0.1:${address.port}`, { signal });
        return response.json();
      },
    }), AdminReadTimeoutError);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a request that ignores cancellation still cannot leave the query pending', async () => {
  await assert.rejects(runAdminRead({
    signal: new AbortController().signal, timeoutMs: 20,
    request: () => new Promise(() => {}),
  }), AdminReadTimeoutError);
});

test('observer cancellation keeps its original reason and prevents starting obsolete reads', async () => {
  const controller = new AbortController();
  const reason = new Error('Observer left');
  let calls = 0;
  const reading = runAdminRead({
    signal: controller.signal,
    request: async () => { calls++; return 'obsolete'; },
  });
  controller.abort(reason);
  await assert.rejects(reading, error => error === reason);
  assert.equal(calls, 0);
});

test('a completed read releases its cancellation listener and deadline', async () => {
  const controller = new AbortController();
  const observed: AbortSignal[] = [];
  assert.equal(await runAdminRead({
    signal: controller.signal, timeoutMs: 20,
    request: async signal => { observed.push(signal); return 'ready'; },
  }), 'ready');
  controller.abort(new Error('Later navigation'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(observed[0]?.aborted, false);
});

test('network failures have actionable copy while HTTP errors retain controller details', async () => {
  await assert.rejects(adminJson(async () => { throw new TypeError('Failed to fetch'); }, '/settings'), /Could not reach the controller.*connection.*retry/);
  await assert.rejects(adminJson(async () => new Response(JSON.stringify({ error: 'Station is starting' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  }), '/settings'), error => error instanceof AdminResponseError
    && error.status === 503 && error.body.error === 'Station is starting');
});
