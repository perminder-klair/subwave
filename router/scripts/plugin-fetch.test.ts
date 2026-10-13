// The fetch a plugin gets (ctx.fetch). Its timeout covers reaching the server
// and receiving headers — not the body. A plugin's stream() may hand back the
// Response itself ({ response }, the documented pattern), and a track can take
// longer than the timeout to arrive; cutting it off sent a 200 with a truncated
// file (#1827 review).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pluginFetch } from '../src/host/registry.js';

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, server };
}

test('a body that streams for longer than the timeout arrives whole', async () => {
  const { url, server } = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(10 * 1024) });
    let n = 0;
    const t = setInterval(() => {
      res.write(Buffer.alloc(1024));
      if (++n === 10) {
        clearInterval(t);
        res.end();
      }
    }, 60);
  });
  try {
    const resp = await pluginFetch(200)(url);
    assert.equal((await resp.arrayBuffer()).byteLength, 10 * 1024, '600ms of body under a 200ms timeout');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a server that never answers still times out', async () => {
  const { url, server } = await serve(() => {});
  try {
    const started = Date.now();
    await assert.rejects(pluginFetch(200)(url), (err: Error) => err.name === 'TimeoutError');
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a plugin's own signal wins", async () => {
  const { url, server } = await serve(() => {});
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(pluginFetch(60_000)(url, { signal: ctrl.signal }), (err: Error) => err.name === 'AbortError');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
