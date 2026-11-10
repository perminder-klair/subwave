// The stdio MCP server's controller URL: an explicit SUBWAVE_API_URL wins
// unprobed, else the first candidate whose /health answers as the controller,
// else the dev default. The probe must reject a server that answers /health
// with something other than the controller's JSON — dev's :7700 is the Next
// dev server, which has no /api proxy.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';
import { answersAsController, resolveApiUrl, DEFAULT_API_URLS } from '../src/mcp/base-url.js';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

test('an explicit URL wins, trimmed, and is never probed', async () => {
  const url = await resolveApiUrl(' http://radio.lan:7700/api/ ', async () => {
    throw new Error('probed');
  });
  assert.equal(url, 'http://radio.lan:7700/api');
});

test('unset: the first candidate that answers wins', async () => {
  const asked: string[] = [];
  const url = await resolveApiUrl(undefined, async (b) => { asked.push(b); return b.endsWith('/api'); });
  assert.equal(url, 'http://localhost:7700/api');
  assert.deepEqual(asked, DEFAULT_API_URLS);
});

test('dev default comes first, so a dev stack never reaches the second probe', async () => {
  const asked: string[] = [];
  assert.equal(await resolveApiUrl('', async (b) => { asked.push(b); return true; }), 'http://localhost:7701');
  assert.deepEqual(asked, ['http://localhost:7701']);
});

test('nothing answers: falls back to the pre-existing default', async () => {
  assert.equal(await resolveApiUrl(undefined, async () => false), 'http://localhost:7701');
});

test('the probe accepts the controller and rejects a Next-style 404 or non-JSON page', async () => {
  const controller = await serve((req, res) => {
    if (req.url === '/api/health') { res.setHeader('content-type', 'application/json'); res.end('{"status":"on-air"}'); }
    else { res.statusCode = 404; res.end(); }
  });
  const nextDev = await serve((_req, res) => { res.statusCode = 404; res.end('<html>404</html>'); });
  const htmlOk = await serve((_req, res) => { res.end('<html>hello</html>'); });
  assert.equal(await answersAsController(`${controller}/api`), true);
  assert.equal(await answersAsController(`${nextDev}/api`), false);
  assert.equal(await answersAsController(htmlOk), false);
  assert.equal(await answersAsController('http://127.0.0.1:1'), false, 'refused connection');
});
