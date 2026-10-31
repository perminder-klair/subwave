// Tests for the Firecrawl web-search backend. The parser and request builder
// are pure and pinned directly; firecrawlSearch() runs once against a stubbed
// fetch so the key is checked through the real settings + SEARCH_API_KEY
// resolution. The fixture is a recorded /v2/search response.
// Run: `npm test -- web-search-firecrawl`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-firecrawl-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
after(() => removeTempDir(stateDir));

const settings = await import('../src/settings.js');
const { buildFirecrawlRequest, parseFirecrawlResponse, firecrawlSearch } =
  await import('../src/skills/web-search.js');
await settings.load();

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('parse: recorded response maps web results into title and content', () => {
  const out = parseFirecrawlResponse(fixture('firecrawl-artist.json'));
  assert.equal(out.answer, '');
  assert.equal(out.results.length, 5);
  assert.equal(out.results[0].title, 'Sabrina Carpenter: Home');
  assert.match(out.results[0].content, /Man's Best Friend/);
  assert.doesNotMatch(out.results[3].content, /&#39;/);
  for (const r of out.results) {
    assert.ok(r.title.length > 0);
    assert.ok(r.content.length > 0 && r.content.length <= 300);
  }
});

test('parse: collapses whitespace and caps content at 300 chars', () => {
  const out = parseFirecrawlResponse({
    data: { web: [{ title: ' Tour\n dates ', description: `line one\n\n  line two ${'x'.repeat(400)}` }] },
  });
  assert.equal(out.results[0].title, 'Tour dates');
  assert.match(out.results[0].content, /^line one line two x+$/);
  assert.equal(out.results[0].content.length, 300);
});

test('parse: tolerates malformed input and drops untitled or empty rows', () => {
  assert.deepEqual(parseFirecrawlResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseFirecrawlResponse({ data: 'nope' }), { answer: '', results: [] });
  assert.deepEqual(
    parseFirecrawlResponse({ data: { web: [null, 42, { title: 'no text', description: '' }, { description: 'no title' }] } }),
    { answer: '', results: [] },
  );
});

test('request: posts the query to /v2/search with the key as a Bearer', () => {
  const { url, init } = buildFirecrawlRequest({ query: 'Sabrina Carpenter', apiKey: ' fc-abc ' });
  assert.equal(url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer fc-abc' });
  assert.deepEqual(JSON.parse(String(init.body)), { query: 'Sabrina Carpenter', limit: 5 });
});

test('request: recency becomes a tbs filter', () => {
  const tbs = (recency: 'day' | 'week' | 'month') =>
    JSON.parse(String(buildFirecrawlRequest({ query: 'q', apiKey: 'fc-abc', recency }).init.body)).tbs;
  assert.equal(tbs('day'), 'qdr:d');
  assert.equal(tbs('week'), 'qdr:w');
  assert.equal(tbs('month'), 'qdr:m');
});

test('firecrawlSearch: sends the settings key; no key or HTTP errors throw', async () => {
  const realFetch = globalThis.fetch;
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 200;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    if (status !== 200) return new Response('{"success":false,"error":"Unauthorized"}', { status });
    return new Response(JSON.stringify(fixture('firecrawl-artist.json')), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(firecrawlSearch('Sabrina Carpenter'), /Firecrawl API key not configured/);
    assert.equal(calls.length, 0);

    await settings.update({ search: { apiKey: 'fc-test' } });
    const out = await firecrawlSearch('Sabrina Carpenter');
    assert.equal(out.results.length, 5);
    assert.equal(calls[0].url, 'https://api.firecrawl.dev/v2/search');
    assert.equal(calls[0].headers.Authorization, 'Bearer fc-test');

    status = 401;
    await assert.rejects(firecrawlSearch('Sabrina Carpenter'), /Firecrawl HTTP 401/);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ search: originalSearch });
  }
});
