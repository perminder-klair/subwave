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

type Outbound = { url: string; method: string; headers: Headers; body: string };

// Stubs every provider call with `status`; the test's own calls pass through.
function stubProvider(t: TestContext, status: number, body: unknown = {}) {
  const realFetch = globalThis.fetch;
  const outbound: Outbound[] = [];
  t.mock.method(globalThis, 'fetch', (async (url: string | URL | Request, init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target.startsWith(base)) return realFetch(url, init);
    outbound.push({ url: target, method: init?.method || 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') });
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
    { key: 'SEARCH_API_KEY', provider: 'outcrawl' },
    { key: 'SEARCH_API_KEY', provider: 'specstream' },
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

// Tavily and Brave searches refuse a key with another provider's prefix (#2223),
// so the probe refuses it too: a key typed under the wrong provider never
// reaches that provider. Their own formats aren't confirmed, so anything else is
// still probed.
test("Tavily and Brave: another provider's key is refused without a request", async (t) => {
  const cases: Array<[string, string, string]> = [
    ['tavily', 'fc-left-over', 'A Firecrawl key, not a Tavily key'],
    ['tavily', 'keen_left-over', 'A Keenable key, not a Tavily key'],
    ['brave', 'fc-left-over', 'A Firecrawl key, not a Brave Search key'],
    ['brave', 'tvly-left-over', 'A Tavily key, not a Brave Search key'],
    ['brave', 'keen_left-over', 'A Keenable key, not a Brave Search key'],
    ['tavily', 'ock_left.over', 'An Outcrawl key, not a Tavily key'],
    ['brave', 'ock_left.over', 'An Outcrawl key, not a Brave Search key'],
    ['tavily', 'ss_live_left-over', 'A SpecStream key, not a Tavily key'],
    ['brave', 'ss_live_left-over', 'A SpecStream key, not a Brave Search key'],
  ];
  for (const [provider, value, message] of cases) {
    const outbound = stubProvider(t, 200);
    const r = await testKey({ key: 'SEARCH_API_KEY', value, provider });
    assert.equal(r.ok, false, `${provider} ${value}`);
    assert.equal(r.message, message);
    assert.equal(outbound.length, 0, `${provider} ${value} reached a provider`);
    t.mock.restoreAll();
  }
});

test("Tavily and Brave: an env key from another provider is refused too", async (t) => {
  const outbound = stubProvider(t, 200);
  process.env.SEARCH_API_KEY = 'fc-from-env';
  t.after(() => { delete process.env.SEARCH_API_KEY; });
  for (const provider of ['tavily', 'brave']) {
    const r = await testKey({ key: 'SEARCH_API_KEY', provider });
    assert.equal(r.ok, false, provider);
    assert.match(r.message, /^A Firecrawl key, not a /);
  }
  assert.equal(outbound.length, 0);
});

test('Tavily and Brave: their own keys, and keys of any other format, are still probed', async (t) => {
  const cases: Array<[string, string, string]> = [
    ['tavily', 'tvly-good', 'https://api.tavily.com/search'],
    ['tavily', 'an-unprefixed-key', 'https://api.tavily.com/search'],
    ['brave', 'BSAgood', 'https://api.search.brave.com/res/v1/web/search'],
    ['brave', 'an-unprefixed-key', 'https://api.search.brave.com/res/v1/web/search'],
  ];
  for (const [provider, value, endpoint] of cases) {
    const outbound = stubProvider(t, 200, { results: [] });
    const r = await testKey({ key: 'SEARCH_API_KEY', value, provider });
    assert.equal(r.ok, true, `${provider} ${value}: ${r.message}`);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url.split('?')[0], endpoint);
    t.mock.restoreAll();
  }
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

test('Outcrawl: a key is probed with a one-result search; 401 reads as rejected, 402 as drained', async (t) => {
  const outbound = stubProvider(t, 200, { hits: [], usage: { credits: '0' } });
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'ock_good.secret', provider: 'outcrawl' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ Outcrawl key valid');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.outcrawl.ai/v1/search');
  assert.equal(outbound[0].method, 'POST');
  assert.equal(outbound[0].headers.get('authorization'), 'Bearer ock_good.secret');
  assert.deepEqual(JSON.parse(outbound[0].body), { query: 'test', limit: 1 });
  t.mock.restoreAll();

  stubProvider(t, 401, { error: 'invalid api key' });
  const rejected = await testKey({ key: 'SEARCH_API_KEY', value: 'ock_bad.secret', provider: 'outcrawl' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.message, 'Key rejected — check it\'s correct and active');
  t.mock.restoreAll();

  stubProvider(t, 402, { error: 'out of credits' });
  const drained = await testKey({ key: 'SEARCH_API_KEY', value: 'ock_drained.secret', provider: 'outcrawl' });
  assert.equal(drained.ok, false);
  assert.equal(drained.message, 'Outcrawl key valid, but it has no credits left');
});

// Outcrawl's error body is { code, message, details } and its docs map no HTTP
// status to a code, so a documented code decides before the status does.
test('Outcrawl: a documented error code decides the message, whatever the status', async (t) => {
  const cases: Array<[number, unknown, string]> = [
    [429, { code: 'quota_exceeded', message: 'over plan', details: {} },
      'Outcrawl key valid, but the account is over its plan limit (monthly credits or requests per minute)'],
    [402, { code: 'quota_exceeded', message: 'over plan', details: {} },
      'Outcrawl key valid, but the account is over its plan limit (monthly credits or requests per minute)'],
    [400, { code: 'unauthorized', message: 'bad key', details: {} }, 'Key rejected — check it\'s correct and active'],
    [403, {}, 'Key rejected — check it\'s correct and active'],
    [429, { code: 'something_else' }, 'Request failed (429)'],
    [500, 'not an envelope', 'Request failed (500)'],
  ];
  for (const [status, body, message] of cases) {
    stubProvider(t, status, body);
    const r = await testKey({ key: 'SEARCH_API_KEY', value: 'ock_any.secret', provider: 'outcrawl' });
    assert.equal(r.ok, false, `${status}`);
    assert.equal(r.message, message, `${status} ${JSON.stringify(body)}`);
    t.mock.restoreAll();
  }
});

test("Outcrawl: another provider's key is refused without a request", async (t) => {
  const outbound = stubProvider(t, 200);
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'fc-left-over', provider: 'outcrawl' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Not an Outcrawl key (they start with ock_)');
  assert.equal(outbound.length, 0);
});

test('SpecStream: a key is probed with a one-result search; 401 reads as rejected, 402 and 403 name the account', async (t) => {
  const outbound = stubProvider(t, 200, { data: { sources: [] } });
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'ss_live_good', provider: 'specstream' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ SpecStream key valid');
  assert.equal(outbound.length, 1);
  const sent = new URL(outbound[0].url);
  assert.equal(sent.origin + sent.pathname, 'https://api.specstream.ai/v1/web-search');
  assert.equal(sent.searchParams.get('num'), '1');
  assert.equal(outbound[0].method, 'GET');
  assert.equal(outbound[0].headers.get('authorization'), 'Bearer ss_live_good');
  t.mock.restoreAll();

  const cases: Array<[number, string]> = [
    [401, 'Key rejected — check it\'s correct and active'],
    [402, 'SpecStream key valid, but the account has no balance left or is at its monthly limit'],
    [403, 'SpecStream key valid, but it may not spend: it needs the finds:spend scope and room under its spending limit'],
    [500, 'Request failed (500)'],
  ];
  for (const [status, message] of cases) {
    stubProvider(t, status, { error: { code: 'unavailable', message: 'no' } });
    const res = await testKey({ key: 'SEARCH_API_KEY', value: 'ss_live_any', provider: 'specstream' });
    assert.equal(res.ok, false, `${status}`);
    assert.equal(res.message, message, `${status}`);
    t.mock.restoreAll();
  }
});

test("SpecStream: another provider's key is refused without a request", async (t) => {
  const outbound = stubProvider(t, 200);
  const r = await testKey({ key: 'SEARCH_API_KEY', value: 'ock_left.over', provider: 'specstream' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Not a SpecStream key (they start with ss_)');
  assert.equal(outbound.length, 0);
});

test('Discogs: the identity call with the token in the header names the user', async (t) => {
  const outbound = stubProvider(t, 200, { username: 'crate-digger' });
  const r = await testKey({ key: 'DISCOGS_TOKEN', value: 'dg-good' });
  assert.equal(r.ok, true);
  assert.equal(r.message, '✓ Discogs token valid · user: crate-digger');
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.discogs.com/oauth/identity');
  assert.equal(outbound[0].headers.get('authorization'), 'Discogs token=dg-good');
});

// The year lookup reads a 401 or a 403 as the token refused (music/discogs.ts),
// so the button must say the same for both.
test('Discogs: a 401 or 403 reads as a rejected token, anything else as the status', async (t) => {
  for (const status of [401, 403]) {
    stubProvider(t, status, { message: 'You must authenticate to access this resource.' });
    const r = await testKey({ key: 'DISCOGS_TOKEN', value: 'dg-bad' });
    assert.equal(r.ok, false, `status ${status}`);
    assert.equal(r.message, 'Token rejected — check your Discogs personal access token', `status ${status}`);
    t.mock.restoreAll();
  }
  stubProvider(t, 502);
  const r = await testKey({ key: 'DISCOGS_TOKEN', value: 'dg-any' });
  assert.equal(r.ok, false);
  assert.equal(r.message, 'Request failed (502)');
});
