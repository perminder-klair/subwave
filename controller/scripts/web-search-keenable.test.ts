// Tests for the Keenable web-search backend. The parser and request builder
// are pure and pinned directly; keenableSearch() runs once against a stubbed
// fetch so the keyless/keyed endpoint choice is checked through the real
// settings + SEARCH_API_KEY resolution. The fixture is a recorded keyless
// response: `description` is empty and the page text sits in `snippet`, which
// is the shape every real result has.
// Run: `npm test -- web-search-keenable`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-keenable-'));
process.env.STATE_DIR = stateDir;
delete process.env.SEARCH_API_KEY;
after(() => removeTempDir(stateDir));

const settings = await import('../src/settings.js');
const { buildKeenableRequest, parseKeenableResponse, keenableSearch } =
  await import('../src/skills/web-search.js');
await settings.load();

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('parse: recorded response maps snippet text into content', () => {
  const out = parseKeenableResponse(fixture('keenable-artist.json'));
  assert.equal(out.answer, '');
  assert.equal(out.results.length, 5);
  assert.equal(out.results[0].title, 'Sabrina Carpenter Online');
  assert.match(out.results[0].content, /^Sabrina has just released a music video/);
  for (const r of out.results) {
    assert.ok(r.title.length > 0);
    assert.ok(r.content.length > 0 && r.content.length <= 300);
  }
});

test('parse: empty snippet falls back to description, on emptiness', () => {
  const out = parseKeenableResponse({
    results: [
      { title: 'A', url: 'https://a.example', description: 'From description', snippet: '' },
      { title: 'B', url: 'https://b.example', description: '', snippet: 'From snippet' },
    ],
  });
  assert.deepEqual(out.results.map(r => r.content), ['From description', 'From snippet']);
});

test('parse: collapses whitespace and caps content at 300 chars', () => {
  const out = parseKeenableResponse({
    results: [{ title: ' Tour\n dates ', description: '', snippet: `line one\n\n  line two ${'x'.repeat(400)}` }],
  });
  assert.equal(out.results[0].title, 'Tour dates');
  assert.match(out.results[0].content, /^line one line two x+$/);
  assert.equal(out.results[0].content.length, 300);
});

test('parse: tolerates malformed input and drops untitled or empty rows', () => {
  assert.deepEqual(parseKeenableResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseKeenableResponse({ results: 'nope' }), { answer: '', results: [] });
  assert.deepEqual(
    parseKeenableResponse({ results: [null, 42, { title: 'no text', description: '', snippet: '' }, { snippet: 'no title' }] }),
    { answer: '', results: [] },
  );
});

test('request: no key goes to the public endpoint with the app title', () => {
  const { url, init } = buildKeenableRequest({ query: 'Sabrina Carpenter' });
  assert.equal(url, 'https://api.keenable.ai/v1/search/public');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'X-Keenable-Title': 'subwave' });
  assert.deepEqual(JSON.parse(String(init.body)), {
    query: 'Sabrina Carpenter',
    max_results: 5,
    snippet_max_length: 300,
  });
});

test('request: a keen_ key goes to the keyed endpoint', () => {
  const { url, init } = buildKeenableRequest({ query: 'q', apiKey: ' keen_abc ' });
  assert.equal(url, 'https://api.keenable.ai/v1/search');
  assert.deepEqual(init.headers, {
    'Content-Type': 'application/json',
    'X-Keenable-Title': 'subwave',
    'X-API-Key': 'keen_abc',
  });
});

test('request: another provider\'s key in the shared slot stays keyless', () => {
  const { url, init } = buildKeenableRequest({ query: 'q', apiKey: 'tvly-abc' });
  assert.equal(url, 'https://api.keenable.ai/v1/search/public');
  assert.equal((init.headers as Record<string, string>)['X-API-Key'], undefined);
});

test('request: recency becomes a published_after date', () => {
  const now = new Date('2026-10-13T12:00:00Z');
  const body = (recency: 'day' | 'week' | 'month') =>
    JSON.parse(String(buildKeenableRequest({ query: 'q', recency, now }).init.body));
  assert.equal(body('day').published_after, '2026-10-12');
  assert.equal(body('week').published_after, '2026-10-06');
  assert.equal(body('month').published_after, '2026-09-13');
});

test('keenableSearch: settings key picks the endpoint; HTTP errors throw', async () => {
  const realFetch = globalThis.fetch;
  const originalSearch = structuredClone(settings.get().search);
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 200;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    if (status !== 200) return new Response('{"error":"Rate limit exceeded"}', { status });
    return new Response(JSON.stringify(fixture('keenable-artist.json')), { status: 200 });
  }) as typeof fetch;
  try {
    const keyless = await keenableSearch('Sabrina Carpenter');
    assert.equal(keyless.results.length, 5);
    assert.equal(calls[0].url, 'https://api.keenable.ai/v1/search/public');

    await settings.update({ search: { apiKey: 'keen_test' } });
    await keenableSearch('Sabrina Carpenter');
    assert.equal(calls[1].url, 'https://api.keenable.ai/v1/search');
    assert.equal(calls[1].headers['X-API-Key'], 'keen_test');

    status = 429;
    await assert.rejects(keenableSearch('Sabrina Carpenter'), /Keenable HTTP 429/);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ search: originalSearch });
  }
});
