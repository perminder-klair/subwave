// Drift guard for the Connect catalog. Run: `npm run test:connect`
// (also picked up by `npm test`, which auto-discovers scripts/*.test.ts).
//
// The catalog (src/connect/catalog.ts) is hand-curated, so a renamed or removed
// route would silently leave a dead entry in the admin explorer + the OpenAPI
// export. This walks the REAL Express routers the catalog documents and asserts
// every catalog endpoint still resolves to a live route. It does NOT require
// full coverage — the catalog is an intentional integration subset — only that
// nothing it lists has drifted away.
//
// Style matches scripts/llm-pure.test.ts (node:assert via tsx, count failures).

import assert from 'node:assert/strict';
import { ENDPOINTS } from '../src/connect/catalog.js';
import { toOpenApi } from '../src/connect/openapi.js';

// Every route module that carries a documented endpoint. Import them and merge
// their router stacks into one "METHOD path" set of real routes.
import { router as publicRouter } from '../src/routes/public.js';
import { router as requestRouter } from '../src/routes/request.js';
import { router as djRouter } from '../src/routes/dj.js';
import { router as sfxRouter } from '../src/routes/sfx.js';
import { router as statsRouter } from '../src/routes/stats.js';
import { router as listenersRouter } from '../src/routes/listeners.js';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

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

async function main() {
  const real = new Set<string>();
  for (const r of [publicRouter, requestRouter, djRouter, sfxRouter, statsRouter, listenersRouter]) {
    for (const k of routeKeys(r)) real.add(k);
  }

  console.log('Connect catalog ↔ real routes:');
  for (const ep of ENDPOINTS) {
    const key = `${ep.method} ${ep.path}`;
    await test(`${key} exists in a router`, () => {
      assert.ok(real.has(key), `catalog documents ${key} but no router serves it`);
    });
  }

  console.log('\nOpenAPI export sanity:');
  await test('generates a 3.1.0 doc with a server + every endpoint', () => {
    const doc = toOpenApi('https://radio.example.com');
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.servers[0].url, 'https://radio.example.com/api');
    const opCount = Object.values(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
    assert.equal(opCount, ENDPOINTS.length, 'every catalog endpoint should map to one operation');
  });
  await test('Express :id path params become {id}', () => {
    const doc = toOpenApi('https://radio.example.com');
    assert.ok(doc.paths['/request/{id}'], ':id should be rewritten to {id}');
    assert.ok(!Object.keys(doc.paths).some(p => p.includes(':')), 'no raw :param should leak');
  });
  await test('admin endpoints carry basicAuth, public ones do not', () => {
    const doc = toOpenApi('https://radio.example.com');
    const search = doc.paths['/dj/search']?.get as any;
    assert.deepEqual(search.security, [{ basicAuth: [] }], '/dj/search is admin');
    const health = doc.paths['/health']?.get as any;
    assert.equal(health.security, undefined, '/health is public');
  });

  if (failures) {
    console.error(`\n✗ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log(`\n✓ all checks passed (${ENDPOINTS.length} endpoints)`);
}

void main();
