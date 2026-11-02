// Tests for the Outcrawl web-search backend. The parser and request builder
// are pure and pinned directly; outcrawlSearch() and searchWeb() run against a
// stubbed fetch, so nothing reaches Outcrawl and the key is checked through the
// real settings + SEARCH_API_KEY resolution, including the refusal of a key that
// isn't an ock_ one. The fixture is a recorded /v1/search response.
// Run: `npm test -- web-search-outcrawl`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-outcrawl-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
after(() => removeTempDir(stateDir));

const settings = await import('../src/settings.js');
const {
  buildOutcrawlRequest, parseOutcrawlResponse, outcrawlSearch,
  isOutcrawlKey, searchKeyProblem, searchReady, searchWeb,
} = await import('../src/skills/web-search.js');
const { checkCapabilities } = await import('../src/doctor/checks-station.js');
await settings.load();

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

// Stubs fetch for one test, records every outbound call, and puts the search
// settings and SEARCH_API_KEY back afterwards.
function stubSearch(t: TestContext) {
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body: String(init?.body),
    });
    return new Response(JSON.stringify(fixture('outcrawl-artist.json')), { status: 200 });
  }) as typeof fetch);
  t.after(async () => {
    delete process.env.SEARCH_API_KEY;
    await settings.update({ search: originalSearch });
  });
  return calls;
}

test('parse: recorded response maps hits into title and content', () => {
  const out = parseOutcrawlResponse(fixture('outcrawl-artist.json'));
  assert.equal(out.answer, '');
  // The fifth recorded hit has an empty snippet, so it is dropped.
  assert.equal(out.results.length, 4);
  assert.equal(out.results[0].title, 'Sabrina Carpenter News | Latest News - NewsNow');
  assert.match(out.results[1].content, /Quakertown/);
  for (const r of out.results) {
    assert.ok(r.title.length > 0);
    assert.ok(r.content.length > 0 && r.content.length <= 300);
  }
});

test('parse: collapses whitespace, decodes entities and caps content at 300 chars', () => {
  const out = parseOutcrawlResponse({
    hits: [{ title: ' Tour\n dates ', snippet: `line one &amp;\n\n  line two ${'x'.repeat(400)}`, url: 'https://example.com', rank: 1 }],
  });
  assert.equal(out.results[0].title, 'Tour dates');
  assert.match(out.results[0].content, /^line one & line two x+$/);
  assert.equal(out.results[0].content.length, 300);
});

test('parse: tolerates malformed input and drops untitled or empty rows', () => {
  assert.deepEqual(parseOutcrawlResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseOutcrawlResponse({ hits: 'nope' }), { answer: '', results: [] });
  assert.deepEqual(
    parseOutcrawlResponse({ hits: [null, 42, { title: 'no text', snippet: '' }, { snippet: 'no title' }] }),
    { answer: '', results: [] },
  );
});

test('request: posts the query to /v1/search with the key as a Bearer', () => {
  const { url, init } = buildOutcrawlRequest({ query: 'Sabrina Carpenter', apiKey: ' ock_abc.def ' });
  assert.equal(url, 'https://api.outcrawl.ai/v1/search');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer ock_abc.def' });
  assert.deepEqual(JSON.parse(String(init.body)), { query: 'Sabrina Carpenter', limit: 5 });
});

test('outcrawlSearch: sends the settings key; no key or HTTP errors throw', async () => {
  const realFetch = globalThis.fetch;
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 200;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    if (status !== 200) return new Response('{"error":"invalid api key"}', { status });
    return new Response(JSON.stringify(fixture('outcrawl-artist.json')), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(outcrawlSearch('Sabrina Carpenter'), /Outcrawl API key not configured/);
    assert.equal(calls.length, 0);

    await settings.update({ search: { apiKey: 'ock_test.secret' } });
    const out = await outcrawlSearch('Sabrina Carpenter');
    assert.equal(out.results.length, 4);
    assert.equal(calls[0].url, 'https://api.outcrawl.ai/v1/search');
    assert.equal(calls[0].headers.Authorization, 'Bearer ock_test.secret');

    status = 401;
    await assert.rejects(outcrawlSearch('Sabrina Carpenter'), /Outcrawl HTTP 401/);
    status = 402;
    await assert.rejects(outcrawlSearch('Sabrina Carpenter'), /Outcrawl HTTP 402/);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ search: originalSearch });
  }
});

test('searchWeb: dispatches to Outcrawl and sends no recency field', async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'outcrawl', apiKey: 'ock_test.secret' } });

  const out = await searchWeb('outcrawl dispatch regression', { recency: 'week' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.outcrawl.ai/v1/search');
  assert.deepEqual(JSON.parse(calls[0].body), { query: 'outcrawl dispatch regression', limit: 5 });
  assert.equal(out.results.length, 4);
});

test('isOutcrawlKey: only an ock_ value counts', () => {
  assert.equal(isOutcrawlKey('ock_abc.def'), true);
  assert.equal(isOutcrawlKey(' ock_abc.def '), true);
  for (const other of ['', 'tvly-abc', 'BSAabc', 'keen_abc', 'fc-abc', 'OCK_abc', 'xock_abc']) {
    assert.equal(isOutcrawlKey(other), false, other);
  }
});

test("another provider's key in the slot is refused before anything is sent", async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'outcrawl', apiKey: 'fc-left-over' } });

  assert.equal(searchReady(), false);
  assert.match(searchKeyProblem() ?? '', /not an Outcrawl key/);
  await assert.rejects(outcrawlSearch('Sabrina Carpenter'), /not an Outcrawl key/);
  await assert.rejects(searchWeb('Sabrina Carpenter'), /not an Outcrawl key/);
  assert.equal(calls.length, 0);
});

test('searchReady follows the key in the slot across both key sources', async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'outcrawl', apiKey: '' } });

  assert.equal(searchReady(), false, 'no key anywhere');

  process.env.SEARCH_API_KEY = 'tvly-left-over';
  assert.equal(searchReady(), false, "another provider's key in env");

  process.env.SEARCH_API_KEY = 'ock_env.secret';
  assert.equal(searchReady(), true);
  await outcrawlSearch('Sabrina Carpenter');
  assert.equal(calls[0].authorization, 'Bearer ock_env.secret');

  await settings.update({ search: { apiKey: 'tvly-saved' } });
  assert.equal(searchReady(), false, 'a saved Tavily key shadows the env ock_ key');

  await settings.update({ search: { apiKey: 'ock_saved.secret' } });
  assert.equal(searchReady(), true);
});

test('doctor says the key on file is the wrong one, and a missing key stays missing', async (t) => {
  const calls = stubSearch(t);

  await settings.update({ search: { provider: 'outcrawl', apiKey: 'tvly-left-over' } });
  const [foreign] = await checkCapabilities(settings.get());
  assert.equal(foreign.status, 'warn');
  assert.equal(foreign.detail, 'outcrawl selected but the key on file is not an Outcrawl key (they start with ock_)');

  await settings.update({ search: { apiKey: '' } });
  const [missing] = await checkCapabilities(settings.get());
  assert.equal(missing.detail, 'outcrawl selected but no API key');

  assert.equal(calls.length, 0);
});
