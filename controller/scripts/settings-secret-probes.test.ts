// POST /settings/secrets/test: the admin "Test key" button. Each probe is
// checked through the real route against a fetch stub, so the endpoint, the
// credential header and the operator-facing message are pinned together. The
// malformed-key refusal is pinned here for POST /settings/embedding/probe too,
// which sits on the same router.
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

// fetch rejects a header value with a line break, NUL or other control
// character, and its error quotes the whole value. A key pasted across a line
// wrap must be refused before any probe runs, never echoed back.
const MALFORMED_KEY_MESSAGE = 'The key has a line break or other control character in it. Paste it again as one line.';

test('a key with a control character is refused before any probe, without echoing it', async (t) => {
  const cases: Record<string, string>[] = [
    { key: 'REQUESTY_API_KEY' },
    { key: 'SEARCH_API_KEY', provider: 'tavily' },
    { key: 'SEARCH_API_KEY', provider: 'brave' },
    { key: 'SEARCH_API_KEY', provider: 'keenable' },
    { key: 'SEARCH_API_KEY', provider: 'firecrawl' },
    { key: 'ELEVENLABS_API_KEY' },
    { key: 'LISTENBRAINZ_USER_TOKEN' },
    { key: 'EMBEDDING_API_KEY' },
  ];
  for (const c of cases) {
    for (const value of ['keen_SECRET\npart2', 'keen_SECRET\rpart2', 'keen_SECRET\u0000part2', 'keen_SECRET\u007fpart2']) {
      const outbound = stubProvider(t, 200);
      const r = await testKey({ ...c, value });
      const label = `${c.key}${c.provider ? `/${c.provider}` : ''} ${JSON.stringify(value)}`;
      assert.equal(r.ok, false, label);
      assert.equal(r.message, MALFORMED_KEY_MESSAGE, label);
      assert.doesNotMatch(r.message, /SECRET/, label);
      assert.equal(outbound.length, 0, `${label} reached a provider`);
      t.mock.restoreAll();
    }
  }
});

// With no typed value the route probes the env key, which the admin never
// displays otherwise.
test('an env key with a control character is refused too', async (t) => {
  const outbound = stubProvider(t, 200);
  process.env.ELEVENLABS_API_KEY = 'el-SECRET\npart2';
  t.after(() => { delete process.env.ELEVENLABS_API_KEY; });
  const r = await testKey({ key: 'ELEVENLABS_API_KEY' });
  assert.equal(r.ok, false);
  assert.equal(r.message, MALFORMED_KEY_MESSAGE);
  assert.equal(outbound.length, 0);
});

test('embedding probe: a typed key with a control character is refused, not echoed', async (t) => {
  const outbound = stubProvider(t, 200);
  const res = await fetch(`${base}/settings/embedding/probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-SECRET\npart2' }),
  });
  assert.equal(res.status, 200);
  const r = await res.json() as { ok: boolean; code: string; message: string };
  assert.equal(r.ok, false);
  assert.equal(r.code, 'invalid');
  assert.equal(r.message, MALFORMED_KEY_MESSAGE);
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

test('Firecrawl: a key is probed against the free /v2/team/credit-usage; a 401 reads as rejected', async (t) => {
  const outbound = stubProvider(t, 200, { success: true, data: { remainingCredits: 500, planCredits: 500, billingPeriodStart: null, billingPeriodEnd: null } });
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-good', provider: 'firecrawl' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ Firecrawl key valid · 500 credits left');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.firecrawl.dev/v2/team/credit-usage');
  assert.equal(outbound[0].method, 'GET');
  assert.equal(outbound[0].headers.get('authorization'), 'Bearer fc-good');
  t.mock.restoreAll();

  stubProvider(t, 401, { success: false, error: 'Unauthorized: Invalid token' });
  const rejected = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-bad', provider: 'firecrawl' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.message, 'Key rejected — check it\'s correct and active');
});

test("Firecrawl: another provider's key is refused without a request", async (t) => {
  const outbound = stubProvider(t, 200);
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'tvly-left-over', provider: 'firecrawl' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Not a Firecrawl key (they start with fc-)');
  assert.equal(outbound.length, 0);
});

test('Firecrawl: a drained key does not read as valid', async (t) => {
  stubProvider(t, 200, { success: true, data: { remainingCredits: 0, planCredits: 500 } });
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-drained', provider: 'firecrawl' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Firecrawl key valid, but it has no credits left');
});

test('Firecrawl: one credit reads in the singular, and a body with no count stays a plain pass', async (t) => {
  stubProvider(t, 200, { success: true, data: { remainingCredits: 1 } });
  const one = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-good', provider: 'firecrawl' });
  assert.equal(one.message, '✓ Firecrawl key valid · 1 credit left');
  t.mock.restoreAll();

  for (const body of [{}, { data: {} }, { data: { remainingCredits: '500' } }]) {
    stubProvider(t, 200, body);
    const r = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-good', provider: 'firecrawl' });
    assert.equal(r.ok, true);
    assert.equal(r.message, '✓ Firecrawl key valid');
    t.mock.restoreAll();
  }
});
