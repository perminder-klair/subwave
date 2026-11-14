// Tests for the SpecStream web-search backend. The parser and request builder
// are pure and pinned directly; specstreamSearch() and searchWeb() run against a
// stubbed fetch, so nothing reaches SpecStream and the key is checked through the
// real settings + SEARCH_API_KEY resolution, including the refusal of a key that
// isn't an ss_ one. Which key fits is pinned in web-search-key-fit with every
// other provider's. The fixture is a recorded /v1/web-search response.
// Run: `npm test -- web-search-specstream`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-specstream-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
after(() => removeTempDir(stateDir));

const settings = await import('../src/settings.js');
const {
  buildSpecStreamRequest, parseSpecStreamResponse, specstreamSearch,
  searchKeyProblem, searchReady, searchWeb,
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
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  t.mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return new Response(JSON.stringify(fixture('specstream-artist.json')), { status: 200 });
  }) as typeof fetch);
  t.after(async () => {
    delete process.env.SEARCH_API_KEY;
    await settings.update({ search: originalSearch });
  });
  return calls;
}

test('parse: recorded response maps sources into title and content', () => {
  const out = parseSpecStreamResponse(fixture('specstream-artist.json'));
  assert.equal(out.answer, '');
  // The third recorded source has an empty snippet, so it is dropped.
  assert.equal(out.results.length, 4);
  assert.equal(out.results[0].title, 'Phoebe Bridgers');
  assert.equal(out.results[3].title, 'Phoebe Bridgers - Albums, Songs, and News | Pitchfork');
  for (const r of out.results) {
    assert.ok(r.title.length > 0);
    assert.ok(r.content.length > 0 && r.content.length <= 300);
  }
});

test('parse: collapses whitespace, decodes entities and caps content at 300 chars', () => {
  const out = parseSpecStreamResponse({
    data: { sources: [{ title: ' Tour\n dates ', snippet: `line one &amp;\n\n  line two ${'x'.repeat(400)}`, url: 'https://example.com' }] },
  });
  assert.equal(out.results[0].title, 'Tour dates');
  assert.match(out.results[0].content, /^line one & line two x+$/);
  assert.equal(out.results[0].content.length, 300);
});

test('parse: tolerates malformed input and drops untitled or empty rows', () => {
  assert.deepEqual(parseSpecStreamResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseSpecStreamResponse({ data: 'nope' }), { answer: '', results: [] });
  assert.deepEqual(parseSpecStreamResponse({ sources: [{ title: 'top level', snippet: 'not under data' }] }), { answer: '', results: [] });
  assert.deepEqual(
    parseSpecStreamResponse({ data: { sources: [null, 42, { title: 'no text', snippet: '' }, { snippet: 'no title' }] } }),
    { answer: '', results: [] },
  );
});

test('request: GETs /v1/web-search with q, num and speed=fast and the key as a Bearer', () => {
  const { url, init } = buildSpecStreamRequest({ query: 'Phoebe Bridgers', apiKey: ' ss_live_abc ' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://api.specstream.ai/v1/web-search');
  assert.equal(parsed.searchParams.get('q'), 'Phoebe Bridgers');
  assert.equal(parsed.searchParams.get('num'), '5');
  assert.equal(parsed.searchParams.get('speed'), 'fast');
  assert.equal(init.method, 'GET');
  assert.deepEqual(init.headers, { Accept: 'application/json', Authorization: 'Bearer ss_live_abc' });
  // The Test key probe asks for one result.
  const probe = buildSpecStreamRequest({ query: 'test', apiKey: 'ss_live_abc', limit: 1 });
  assert.equal(new URL(probe.url).searchParams.get('num'), '1');
});

test('specstreamSearch: sends the settings key; no key or HTTP errors throw', async () => {
  const realFetch = globalThis.fetch;
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 200;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    if (status !== 200) return new Response('{"error":{"code":"invalid_token","message":"bad key"}}', { status });
    return new Response(JSON.stringify(fixture('specstream-artist.json')), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(specstreamSearch('Phoebe Bridgers'), /SpecStream API key not configured/);
    assert.equal(calls.length, 0);

    await settings.update({ search: { apiKey: 'ss_live_test' } });
    const out = await specstreamSearch('Phoebe Bridgers');
    assert.equal(out.results.length, 4);
    assert.match(calls[0].url, /^https:\/\/api\.specstream\.ai\/v1\/web-search\?/);
    assert.equal(calls[0].headers.Authorization, 'Bearer ss_live_test');

    status = 401;
    await assert.rejects(specstreamSearch('Phoebe Bridgers'), /SpecStream HTTP 401/);
    status = 402;
    await assert.rejects(specstreamSearch('Phoebe Bridgers'), /SpecStream HTTP 402/);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ search: originalSearch });
  }
});

test('searchWeb: dispatches to SpecStream and sends no recency field', async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'specstream', apiKey: 'ss_live_test' } });

  const out = await searchWeb('specstream dispatch regression', { recency: 'week' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  const sent = new URL(calls[0].url);
  assert.equal(sent.searchParams.get('q'), 'specstream dispatch regression');
  assert.deepEqual([...sent.searchParams.keys()].sort(), ['num', 'q', 'speed']);
  assert.equal(out.results.length, 4);
});

test("another provider's key in the slot is refused before anything is sent", async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'specstream', apiKey: 'ock_left.over' } });

  assert.equal(searchReady(), false);
  assert.match(searchKeyProblem() ?? '', /not a SpecStream key/);
  await assert.rejects(specstreamSearch('Phoebe Bridgers'), /not a SpecStream key/);
  await assert.rejects(searchWeb('Phoebe Bridgers'), /not a SpecStream key/);
  assert.equal(calls.length, 0);
});

test('searchReady follows the key in the slot across both key sources', async (t) => {
  const calls = stubSearch(t);
  await settings.update({ search: { provider: 'specstream', apiKey: '' } });

  assert.equal(searchReady(), false, 'no key anywhere');

  process.env.SEARCH_API_KEY = 'tvly-left-over';
  assert.equal(searchReady(), false, "another provider's key in env");

  process.env.SEARCH_API_KEY = 'ss_test_env';
  assert.equal(searchReady(), true);
  await specstreamSearch('Phoebe Bridgers');
  assert.equal(calls[0].authorization, 'Bearer ss_test_env');

  await settings.update({ search: { apiKey: 'tvly-saved' } });
  assert.equal(searchReady(), false, 'a saved Tavily key shadows the env ss_ key');

  await settings.update({ search: { apiKey: 'ss_live_saved' } });
  assert.equal(searchReady(), true);
});

test('doctor says the key on file is the wrong one, and a missing key stays missing', async (t) => {
  const calls = stubSearch(t);

  await settings.update({ search: { provider: 'specstream', apiKey: 'tvly-left-over' } });
  const [foreign] = await checkCapabilities(settings.get());
  assert.equal(foreign.status, 'warn');
  assert.equal(foreign.detail, 'specstream selected but the key on file is not a SpecStream key (they start with ss_)');

  await settings.update({ search: { apiKey: '' } });
  const [missing] = await checkCapabilities(settings.get());
  assert.equal(missing.detail, 'specstream selected but no API key');

  assert.equal(calls.length, 0);
});
