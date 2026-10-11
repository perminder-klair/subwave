// POST /mcp refuses a JSON-RPC batch that would fan out into many loopback
// REST calls, before any server, transport or loopback client is built. A
// single message — what the documented clients send — is untouched.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-mcp-batch-'));
const express = (await import('express')).default;
const { router, mcpBatchRefusal, MCP_MAX_BATCH } = await import('../src/routes/mcp.js');

const call = (id: number, name = 'subwave_now_playing') =>
  ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });
const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

test('single messages and small cheap batches pass', () => {
  assert.equal(mcpBatchRefusal(call(1)), null);
  assert.equal(mcpBatchRefusal({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), null);
  assert.equal(mcpBatchRefusal([ping(1), ping(2), call(3)]), null, 'one tool call may ride with cheap messages');
});

test('a batch carrying more than one tool call is refused', () => {
  assert.match(String(mcpBatchRefusal([call(1), call(2)])), /tools\/call/);
});

test('an oversized batch is refused whatever it carries', () => {
  const big = Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => ping(i));
  assert.match(String(mcpBatchRefusal(big)), /must not exceed/);
});

const app = express();
app.use(express.json());
app.use(router);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
server.unref();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => new Promise<void>(resolve => server.close(() => resolve())));

test('the route answers a refused batch with a JSON-RPC -32600', async () => {
  const batch = Array.from({ length: 100 }, (_, i) => call(i, 'subwave_similar_tracks'));
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(batch),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error?: { code?: number }; id?: unknown };
  assert.equal(body.error?.code, -32600);
  assert.equal(body.id, null);
});

test('a single initialize still reaches the transport', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(body.result?.serverInfo?.name, 'subwave-mcp');
});
