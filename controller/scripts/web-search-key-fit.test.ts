// Every keyed web-search backend reads one shared key slot (settings.search.apiKey,
// else SEARCH_API_KEY), so switching provider without replacing the key leaves
// another provider's key in it (#2223). search-key-policy.ts decides which key
// each provider may send: Firecrawl and Keenable only their own prefix, Tavily
// and Brave anything but another provider's known prefix, because their formats
// aren't confirmed. This pins that rule and every surface that asks it: the two
// searchers refuse before sending, searchReady(), searchKeyProblem(), the doctor
// and GET /settings, for a saved key and an env one. fetch is stubbed, so nothing
// reaches a provider. The Test-key probe is pinned in settings-secret-probes.
// Run: `npm test -- web-search-key-fit`.

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { listen as listenHttp } from './test-utils/http.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-search-key-fit-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
after(() => removeTempDir(stateDir));

const settings = await import('../src/settings.js');
const {
  searchKeyFits, searchKeyMismatch, searchKeyRequired, searchProvidersRefusing,
} = await import('../src/skills/search-key-policy.js');
const {
  tavilySearch, braveSearch, searchWeb, searchReady, searchKeyProblem, searchKeyRefusedBy,
} = await import('../src/skills/web-search.js');
const { checkCapabilities } = await import('../src/doctor/checks-station.js');
await settings.load();

// Stubs fetch for one test, records every outbound call with both credential
// headers, and puts the search settings and SEARCH_API_KEY back afterwards.
function stubSearch(t: TestContext) {
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; authorization: string | null; token: string | null }> = [];
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      authorization: headers.get('authorization'),
      token: headers.get('x-subscription-token'),
    });
    // An empty answer in each provider's own shape: Brave's reply must carry web
    // results to count as one.
    const body = String(input).includes('search.brave.com') ? { web: { results: [] } } : { answer: '', results: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
  t.after(async () => {
    delete process.env.SEARCH_API_KEY;
    await settings.update({ search: originalSearch });
  });
  return calls;
}

test('searchKeyFits: each provider takes its own key and refuses the others', () => {
  const table: Array<[string, string, boolean]> = [
    // Firecrawl and Keenable: only their own prefix.
    ['firecrawl', 'fc-abc', true],
    ['firecrawl', 'tvly-abc', false],
    ['firecrawl', 'BSAabc', false],
    ['keenable', 'keen_abc', true],
    ['keenable', 'fc-abc', false],
    // Tavily: anything but another provider's known prefix.
    ['tavily', 'tvly-abc', true],
    ['tavily', 'legacy-unprefixed', true],
    ['tavily', 'BSAabc', true],
    ['tavily', 'fc-abc', false],
    ['tavily', 'keen_abc', false],
    // Brave: the same, and a Tavily key is foreign too.
    ['brave', 'BSAabc', true],
    ['brave', 'legacy-unprefixed', true],
    ['brave', 'fc-abc', false],
    ['brave', 'keen_abc', false],
    ['brave', 'tvly-abc', false],
  ];
  for (const [provider, key, fits] of table) {
    assert.equal(searchKeyFits(provider, key), fits, `${provider} ${key}`);
    assert.equal(searchKeyFits(provider, ` ${key} `), fits, `${provider} ${key}, padded`);
  }
  for (const provider of ['tavily', 'brave', 'firecrawl', 'keenable']) {
    assert.equal(searchKeyFits(provider, ''), false, `${provider} empty`);
    assert.equal(searchKeyFits(provider, '   '), false, `${provider} blank`);
  }
});

test('searchKeyMismatch names whose key it is, and an empty key is not a mismatch', () => {
  assert.equal(searchKeyMismatch('tavily', 'fc-abc'), 'a Firecrawl key, not a Tavily key');
  assert.equal(searchKeyMismatch('brave', 'tvly-abc'), 'a Tavily key, not a Brave Search key');
  assert.equal(searchKeyMismatch('brave', 'keen_abc'), 'a Keenable key, not a Brave Search key');
  assert.equal(searchKeyMismatch('firecrawl', 'BSAabc'), 'not a Firecrawl key (they start with fc-)');
  assert.equal(searchKeyMismatch('tavily', 'tvly-abc'), null);
  assert.equal(searchKeyMismatch('tavily', ''), null);
});

test('searchProvidersRefusing lists the keyed providers that would refuse a key', () => {
  assert.deepEqual(searchProvidersRefusing('fc-abc'), ['tavily', 'brave']);
  assert.deepEqual(searchProvidersRefusing('tvly-abc'), ['brave', 'firecrawl']);
  assert.deepEqual(searchProvidersRefusing('keen_abc'), ['tavily', 'brave', 'firecrawl']);
  assert.deepEqual(searchProvidersRefusing('BSAabc'), ['firecrawl']);
  assert.deepEqual(searchProvidersRefusing(''), []);
  assert.equal(searchKeyRequired('tavily'), true);
  assert.equal(searchKeyRequired('keenable'), false);
  assert.equal(searchKeyRequired('duckduckgo'), false);
});

const FOREIGN: Array<[provider: 'tavily' | 'brave', key: string, sentence: string]> = [
  ['tavily', 'fc-firecrawl-secret', 'The key on file is a Firecrawl key, not a Tavily key'],
  ['tavily', 'keen_keenable-secret', 'The key on file is a Keenable key, not a Tavily key'],
  ['brave', 'fc-firecrawl-secret', 'The key on file is a Firecrawl key, not a Brave Search key'],
  ['brave', 'tvly-tavily-secret', 'The key on file is a Tavily key, not a Brave Search key'],
  ['brave', 'keen_keenable-secret', 'The key on file is a Keenable key, not a Brave Search key'],
];
const searcher = { tavily: tavilySearch, brave: braveSearch };

test("a saved key from another provider is refused before anything is sent", async (t) => {
  const calls = stubSearch(t);
  for (const [provider, key, sentence] of FOREIGN) {
    await settings.update({ search: { provider, apiKey: key } });
    assert.equal(searchReady(), false, `${provider} ${key}`);
    assert.equal(searchKeyProblem(), sentence);
    await assert.rejects(searcher[provider]('Sabrina Carpenter'), { message: sentence });
    await assert.rejects(searchWeb(`Sabrina Carpenter ${key}`), { message: sentence });
  }
  assert.equal(calls.length, 0);
});

test('an env key from another provider is refused the same way', async (t) => {
  const calls = stubSearch(t);
  for (const [provider, key, sentence] of FOREIGN) {
    await settings.update({ search: { provider, apiKey: '' } });
    process.env.SEARCH_API_KEY = key;
    assert.equal(searchReady(), false, `${provider} ${key}`);
    assert.equal(searchKeyProblem(), sentence);
    await assert.rejects(searcher[provider]('Sabrina Carpenter'), { message: sentence });
  }
  assert.equal(calls.length, 0);
});

test('a saved foreign key shadows a good env key, and a good saved key goes out', async (t) => {
  const calls = stubSearch(t);
  process.env.SEARCH_API_KEY = 'tvly-env';
  await settings.update({ search: { provider: 'tavily', apiKey: 'fc-saved' } });
  assert.equal(searchReady(), false);
  await assert.rejects(tavilySearch('q'), /a Firecrawl key, not a Tavily key/);
  assert.equal(calls.length, 0);

  await settings.update({ search: { apiKey: '' } });
  assert.equal(searchReady(), true);
  await tavilySearch('q');
  assert.equal(calls[0].authorization, 'Bearer tvly-env');
});

// Neither format is confirmed, so a key nobody's prefix claims still goes
// through: the refusal must not lock out a working key.
test('Tavily and Brave still send their own keys and keys of any other format', async (t) => {
  const calls = stubSearch(t);
  const cases: Array<['tavily' | 'brave', string]> = [
    ['tavily', 'tvly-dev-abc'],
    ['tavily', 'an-unprefixed-tavily-key'],
    ['brave', 'BSAabc123'],
    ['brave', 'an-unprefixed-brave-key'],
  ];
  for (const [provider, key] of cases) {
    calls.length = 0;
    await settings.update({ search: { provider, apiKey: key } });
    assert.equal(searchReady(), true, `${provider} ${key}`);
    assert.equal(searchKeyProblem(), null, `${provider} ${key}`);
    await searcher[provider]('Sabrina Carpenter');
    assert.equal(calls.length, 1, `${provider} ${key}`);
    if (provider === 'tavily') assert.equal(calls[0].authorization, `Bearer ${key}`);
    else assert.equal(calls[0].token, key);
  }
});

test('the doctor names the refused key instead of asking for one', async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'brave', apiKey: 'fc-left-over' } });
  const [foreign] = await checkCapabilities(settings.get());
  assert.equal(foreign.status, 'warn');
  assert.equal(foreign.detail, 'brave selected but the key on file is a Firecrawl key, not a Brave Search key');

  await settings.update({ search: { provider: 'firecrawl', apiKey: 'tvly-left-over' } });
  const [firecrawl] = await checkCapabilities(settings.get());
  assert.equal(firecrawl.detail, 'firecrawl selected but the key on file is not a Firecrawl key (they start with fc-)');

  await settings.update({ search: { provider: 'tavily', apiKey: '' } });
  const [missing] = await checkCapabilities(settings.get());
  assert.equal(missing.detail, 'tavily selected but no API key');
  assert.equal(calls.length, 0);
});

test('searchKeyRefusedBy follows the key on file, saved or env', async (t) => {
  stubSearch(t);
  await settings.update({ search: { provider: 'duckduckgo', apiKey: '' } });
  assert.deepEqual(searchKeyRefusedBy(), []);
  process.env.SEARCH_API_KEY = 'fc-env';
  assert.deepEqual(searchKeyRefusedBy(), ['tavily', 'brave']);
  await settings.update({ search: { apiKey: 'tvly-saved' } });
  assert.deepEqual(searchKeyRefusedBy(), ['brave', 'firecrawl']);
});

test('GET /settings serves keyRefusedBy', async (t) => {
  stubSearch(t);
  t.mock.restoreAll();
  process.env.SEARCH_API_KEY = 'fc-env';
  const express = (await import('express')).default;
  const { router } = await import('../src/routes/settings/core.js');
  const app = express();
  app.use(express.json());
  app.use(router);
  const { server, url } = await listenHttp(app);
  server.unref();
  const body = await (await fetch(`${url}/settings`)).json() as { search: { keyRefusedBy: unknown } };
  assert.deepEqual(body.search.keyRefusedBy, ['tavily', 'brave']);
});
