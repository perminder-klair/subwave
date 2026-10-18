// Drift guard for the Connect catalog. Run: `npm test -- connect-catalog`
// (also picked up by `npm test`, which auto-discovers scripts/*.test.ts).
//
// The catalog (src/connect/catalog.ts) is hand-curated, so a renamed or removed
// route would silently leave a dead entry in the admin explorer + the OpenAPI
// export. This walks the REAL Express routers the catalog documents and asserts
// every catalog endpoint still resolves to a live route. It does NOT require
// full coverage — the catalog is an intentional integration subset — only that
// nothing it lists has drifted away.
//

import test from 'node:test';
import assert from 'node:assert/strict';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ENDPOINTS, MCP_TOOLS } from '../src/connect/catalog.js';
import { toOpenApi } from '../src/connect/openapi.js';
import { registerSubwaveTools } from '../src/mcp/tools.js';
import type { SubwaveClient } from '../src/mcp/client.js';

// Every route module that carries a documented endpoint. Import them and merge
// their router stacks into one "METHOD path" set of real routes.
import { router as publicRouter } from '../src/routes/public.js';
import { router as requestRouter } from '../src/routes/request.js';
import { router as djRouter } from '../src/routes/dj.js';
import { router as sfxRouter } from '../src/routes/sfx.js';
import { router as jinglesRouter } from '../src/routes/jingles.js';
import { router as statsRouter } from '../src/routes/stats.js';
import { router as listenersRouter } from '../src/routes/listeners.js';

// Collect "GET /now-playing"-style keys from a router's stack.
function routeKeys(router: any): Set<string> {
  const keys = new Set<string>();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path: string = layer.route.path;
    for (const method of Object.keys(layer.route.methods)) {
      if (layer.route.methods[method]) keys.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys;
}

const real = new Set<string>();
for (const r of [publicRouter, requestRouter, djRouter, sfxRouter, jinglesRouter, statsRouter, listenersRouter]) {
  for (const k of routeKeys(r)) real.add(k);
}

for (const ep of ENDPOINTS) {
  const key = `${ep.method} ${ep.path}`;
  test(`${key} exists in a router`, () => {
    assert.ok(real.has(key), `catalog documents ${key} but no router serves it`);
  });
}

test('generates a 3.1.0 doc with a server + every endpoint', () => {
  const doc = toOpenApi('https://radio.example.com');
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0].url, 'https://radio.example.com/api');
  const opCount = Object.values(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
  assert.equal(opCount, ENDPOINTS.length, 'every catalog endpoint should map to one operation');
});
// The /api prefix lives on the SERVER url and NOT on each path key. Putting
// it in both resolves to /api/api/..., and a doc that disagrees with the
// module's own header comment is how a client gets generated against the
// wrong base — this pins which half carries it.
test('the /api prefix rides on servers[0], never on the path keys', () => {
  const doc = toOpenApi('https://radio.example.com');
  assert.equal(doc.servers[0].url, 'https://radio.example.com/api');
  const prefixed = Object.keys(doc.paths).filter(p => p.startsWith('/api/'));
  assert.deepEqual(prefixed, [], 'path keys are prefix-free');
  assert.ok(doc.paths['/similar-tracks'], 'station-gated read is keyed prefix-free');
  assert.ok(doc.paths['/health'], 'public read is keyed prefix-free');
});
test('Express :id path params become {id}', () => {
  const doc = toOpenApi('https://radio.example.com');
  assert.ok(doc.paths['/request/{id}'], ':id should be rewritten to {id}');
  assert.ok(!Object.keys(doc.paths).some(p => p.includes(':')), 'no raw :param should leak');
});
test('admin endpoints carry basicAuth, public ones do not', () => {
  const doc = toOpenApi('https://radio.example.com');
  const search = doc.paths['/dj/search']?.get as any;
  assert.deepEqual(search.security, [{ basicAuth: [] }], '/dj/search is admin');
  const health = doc.paths['/health']?.get as any;
  assert.equal(health.security, undefined, '/health is public');
});
// A station-gated read is open on a public station, so its requirement must
// be OPTIONAL — the empty object first. Emitting only { stationAuth: [] }
// makes every generated client demand a password most stations don't have.
test('station-gated endpoints declare an OPTIONAL apiKey requirement', () => {
  const doc = toOpenApi('https://radio.example.com');
  const similar = doc.paths['/similar-tracks']?.get as any;
  assert.deepEqual(similar.security, [{}, { stationAuth: [] }], '/similar-tracks is station-gated');
  assert.equal(doc.components.securitySchemes.stationAuth.name, 'x-station-auth');
});

// MCP_TOOLS is a hand-maintained mirror of the tools registerSubwaveTools
// actually registers; assert the two sets match exactly. A stub server
// captures names — no transport, no client calls.
test('MCP_TOOLS mirrors registerSubwaveTools exactly', () => {
  const registered: string[] = [];
  const stub = { registerTool: (name: string) => { registered.push(name); } } as unknown as McpServer;
  registerSubwaveTools(stub, {} as SubwaveClient);
  const documented = MCP_TOOLS.map(t => t.name);
  assert.deepEqual(
    [...registered].sort(),
    [...documented].sort(),
    'catalog MCP_TOOLS and registerSubwaveTools disagree',
  );
});
