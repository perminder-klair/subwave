// POST /settings/secrets/test: the admin "Test key" button. Each probe is
// checked through the real route against a fetch stub, so the endpoint, the
// credential header and the operator-facing message are pinned together.
//
// requireAdmin is a no-op with ADMIN_USER/ADMIN_PASS unset, so the router mounts
// bare over real HTTP against a temp state dir.
//
// Run: `npm test -- settings-secret-probes`.

import assert from 'node:assert/strict';
import { listen as listenHttp } from './test-utils/http.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-secret-probes-'));
process.env.STATE_DIR = stateRoot;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const express = (await import('express')).default;
const settings = await import('../src/settings.js');
const { router } = await import('../src/routes/settings/llm.js');
await settings.load();

const app = express();
app.use(express.json());
app.use(router);
const { server, url: base } = await listenHttp(app);
server.unref();

type Outbound = { url: string; method: string; headers: Headers };

// Stubs every provider call with `status`; the test's own calls pass through.
function stubProvider(t: TestContext, status: number, body: unknown = {}) {
  const realFetch = globalThis.fetch;
  const outbound: Outbound[] = [];
  t.mock.method(globalThis, 'fetch', (async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target.startsWith(base)) return realFetch(url, init);
    outbound.push({ url: target, method: init?.method || 'GET', headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  return outbound;
}

async function testKey(payload: Record<string, string>) {
  const res = await fetch(`${base}/settings/secrets/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  return await res.json() as { ok: boolean; message: string };
}

test('Requesty: a listed model set means the key is valid', async (t) => {
  const outbound = stubProvider(t, 200, { data: [{ id: 'openai/gpt-4o-mini' }] });
  const r = await testKey({ key: 'REQUESTY_API_KEY', value: 'rq-good' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ Requesty key valid');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://router.requesty.ai/v1/models');
  assert.equal(outbound[0].method, 'GET');
  assert.equal(outbound[0].headers.get('authorization'), 'Bearer rq-good');
});

// Requesty answers a bad bearer with 403 "Invalid authorization token", not
// 401, so both must read as a rejected key.
test('Requesty: a 401 or 403 reads as a rejected key, anything else as the status', async (t) => {
  for (const status of [401, 403]) {
    stubProvider(t, status, { error: { origin: 'router', message: 'Invalid authorization token' } });
    const rejected = await testKey({ key: 'REQUESTY_API_KEY', value: 'rq-bad' });
    assert.equal(rejected.ok, false, `status ${status}`);
    assert.equal(rejected.message, 'Key rejected — check it\'s correct and active', `status ${status}`);
    t.mock.restoreAll();
  }
  stubProvider(t, 502);
  const failed = await testKey({ key: 'REQUESTY_API_KEY', value: 'rq-any' });
  assert.equal(failed.ok, false);
  assert.equal(failed.message, 'Request failed (502)');
});

// keenableSearch sends only a keen_ value, so a Tavily or Brave key left in the
// shared SEARCH_API_KEY slot is unused, not wrong: it must never reach Keenable
// or come back as "Key rejected".
test('Keenable: a non-keen_ value is reported as unused, and never sent', async (t) => {
  const outbound = stubProvider(t, 401);
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'tvly-left-over', provider: 'keenable' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Not a Keenable key (they start with keen_) — searches run keyless without one');
  assert.doesNotMatch(r.message, /rejected/i);
  assert.equal(outbound.length, 0);
});

test('Keenable: a keen_ key is probed against the keyed endpoint', async (t) => {
  const outbound = stubProvider(t, 200, { results: [] });
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'keen_good', provider: 'keenable' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ Keenable key valid');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.keenable.ai/v1/search');
  assert.equal(outbound[0].headers.get('x-api-key'), 'keen_good');
});
