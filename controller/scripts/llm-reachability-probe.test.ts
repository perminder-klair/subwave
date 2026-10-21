// legs.probeLegReachable probes every SELF-HOSTED provider, locca included.
//
// locca is the self-hosted llama.cpp transport, but the probe used to branch on
// two provider names only, so a powered-off locca box fell into "hosted —
// assume up": the doctor reported it reachable and the dual-model tagger gave
// it a consumer that burned connect timeouts. Which providers are probed, and
// how, is now a capability fact (capabilities.ts `reachabilityProbe`).
//
// Run: npm test -- llm-reachability-probe

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-reachability-probe-'));
process.env.STATE_DIR = stateRoot;
const { probeLegReachable } = await import('../src/llm/internal/provider/legs.js');
const { capabilitiesFor } = await import('../src/llm/internal/provider/capabilities.js');
const { DEFAULT_LOCCA_BASE_URL } = await import('../src/llm/internal/provider/registry.js');

const seen: string[] = [];
const server = createServer((req, res) => { seen.push(req.url || ''); res.statusCode = 404; res.end(); });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(stateRoot, { recursive: true, force: true });
});

const leg = (cfg: Record<string, unknown>) => ({ cfg }) as never;

test('locca is probed like openai-compatible, at its own base URL', async () => {
  assert.equal(capabilitiesFor('locca').reachabilityProbe, 'openai-models');
  seen.length = 0;
  assert.equal(await probeLegReachable(leg({ provider: 'locca', baseUrl: `${base}/v1/` })), true, 'any HTTP answer means the host is up');
  assert.deepEqual(seen, ['/v1/models']);
});

test('a switched-off locca box reads as down', async () => {
  // Port 9 (discard) on loopback is closed on any sane test host.
  assert.equal(await probeLegReachable(leg({ provider: 'locca', baseUrl: 'http://127.0.0.1:9/v1' }), 1000), false);
});

test('locca with no base URL probes its default server', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (u: string) => { urls.push(String(u)); return new Response(''); });
  assert.equal(await probeLegReachable(leg({ provider: 'locca' })), true);
  assert.deepEqual(urls, [`${DEFAULT_LOCCA_BASE_URL}/models`]);
});

test('the existing probes are unchanged, and hosted providers are still assumed up', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (u: string) => { urls.push(String(u)); return new Response(''); });
  assert.equal(await probeLegReachable(leg({ provider: 'ollama', ollamaUrl: 'http://ollama.test:11434' })), true);
  assert.equal(await probeLegReachable(leg({ provider: 'openai-compatible', baseUrl: 'http://compat.test/v1' })), true);
  assert.equal(await probeLegReachable(leg({ provider: 'openai-compatible' })), false, 'no server configured');
  assert.equal(await probeLegReachable(leg({ provider: 'anthropic' })), true);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/api\/version$/);
  assert.equal(urls[1], 'http://compat.test/v1/models');
});
