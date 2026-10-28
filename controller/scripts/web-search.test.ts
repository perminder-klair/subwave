// Brave response fixtures (#623), SearXNG response fixtures and URL pins
// (#1353). Recorded JSON keeps parser coverage tied to real provider shapes.
// The dispatcher memo must separate recency windows for segment and picker tools.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-web-search-'));
const { parseBraveResponse, buildSearxngUrl, parseSearxngResponse, searchWeb, searchCacheSize, isWebSearchProviderError } =
  await import('../src/skills/web-search.js');
const settings = await import('../src/settings.js');
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));



test('populated response yields up to 10 results', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  assert.ok(out.results.length > 0, 'expected some results');
  assert.ok(out.results.length <= 10, 'expected <= 10 results');
  for (const r of out.results) {
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.content, 'string');
    assert.ok(r.title.length > 0, 'title should not be empty');
    assert.ok(r.content.length > 0, 'content should not be empty');
  }
});

test('news results lead, web results follow', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  assert.ok(out.results[0].title.includes('world tour'), 'first result should be news');
  assert.ok(
    out.results.some(r => r.title.includes('Wikipedia')),
    'web results should follow news',
  );
});

test('snippets are stripped of tags and entities', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  const tour = out.results[0];
  assert.ok(!tour.content.includes('<strong>'), 'tags should be stripped');
  assert.ok(!tour.content.includes('&#x27;'), 'hex entities should be decoded');
  assert.ok(tour.content.includes("star's"), 'decoded apostrophe should survive');
  const review = out.results[1];
  assert.ok(review.content.includes('& its four new songs'), '&amp; should decode');
});

test('snippet content capped at 300 chars', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  for (const r of out.results) {
    assert.ok(r.content.length <= 300, `content too long: ${r.content.length}`);
  }
});

test('results without a description are skipped', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  assert.ok(
    !out.results.some(r => r.title.includes('empty description')),
    'empty-description result should be dropped',
  );
});

test('infobox long_desc populates answer slot (object form)', () => {
  const out = parseBraveResponse(fixture('brave-artist.json'));
  assert.ok(out.answer.includes('American singer'), 'answer should come from infobox');
});

test('infobox results as an array also populates answer', () => {
  const out = parseBraveResponse({
    infobox: { type: 'graph', results: [{ long_desc: 'From the array form.' }] },
  });
  assert.equal(out.answer, 'From the array form.');
});

test('empty response yields empty results and empty answer', () => {
  const out = parseBraveResponse(fixture('brave-empty.json'));
  assert.deepEqual(out.results, []);
  assert.equal(out.answer, '');
});

test('malformed input returns empty SearchResponse', () => {
  assert.deepEqual(parseBraveResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseBraveResponse('nope'), { answer: '', results: [] });
  assert.deepEqual(parseBraveResponse({ web: { results: 'nope' } }), { answer: '', results: [] });
  assert.deepEqual(
    parseBraveResponse({ web: { results: [null, 42, { title: 'no content' }] } }),
    { answer: '', results: [] },
  );
});

test('malformed numeric entities are left intact, not crashed on', () => {
  const out = parseBraveResponse({
    web: { results: [{ title: 'T', description: 'bad &#zz; entity and huge &#99999999;' }] },
  });
  assert.equal(out.results.length, 1);
  assert.ok(out.results[0].content.includes('&#zz;'), 'non-numeric entity untouched');
  assert.ok(out.results[0].content.includes('&#99999999;'), 'out-of-range entity untouched');
});


test('populated response yields up to 10 results', () => {
  const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
  assert.ok(out.results.length > 0, 'expected some results');
  assert.ok(out.results.length <= 10, 'expected <= 10 results');
  for (const r of out.results) {
    assert.equal(typeof r.title, 'string');
    assert.equal(typeof r.content, 'string');
    assert.ok(r.title.length > 0, 'title should not be empty');
  }
});

test('snippet content capped at 300 chars', () => {
  const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
  for (const r of out.results) {
    assert.ok(r.content.length <= 300, `content too long: ${r.content.length}`);
  }
});

test('empty response yields empty results and empty answer', () => {
  const out = parseSearxngResponse(fixture('searxng-empty.json'));
  assert.deepEqual(out.results, []);
  assert.equal(out.answer, '');
});

test('infobox content populates answer slot', () => {
  const out = parseSearxngResponse(fixture('searxng-with-infobox.json'));
  assert.ok(out.answer.length > 0, 'answer should be populated from infobox');
});

test('malformed input returns empty SearchResponse', () => {
  assert.deepEqual(parseSearxngResponse(null), { answer: '', results: [] });
  assert.deepEqual(parseSearxngResponse({}), { answer: '', results: [] });
  assert.deepEqual(parseSearxngResponse({ results: 'nope' }), { answer: '', results: [] });
});

test('drops results with empty title or content', () => {
  const out = parseSearxngResponse({
    results: [
      { title: '', content: 'orphan content' },
      { title: 'orphan title', content: '' },
      { title: 'real', content: 'real snippet' },
    ],
  });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, 'real');
});



// #1353. The engine pin is optional and must be invisible when unset — an
// `engines=` param sent empty is NOT the same as no param: SearXNG's
// parse_generic() reads an empty list as "no engines matched" and answers
// with nothing, where omitting the param uses the instance defaults.
test('omits engines= entirely when the pin is unset', () => {
  for (const engines of [undefined, '', '   ']) {
    const url = buildSearxngUrl({ baseUrl: 'http://searx.lan:8888', query: 'Aphex Twin', engines });
    assert.equal(url.searchParams.has('engines'), false, `engines=${JSON.stringify(engines)}`);
    assert.equal(url.toString(), 'http://searx.lan:8888/search?q=Aphex+Twin&format=json');
  }
});

test('sends the pin verbatim, spaces and commas intact', () => {
  const url = buildSearxngUrl({
    baseUrl: 'http://searx.lan:8888',
    query: 'Aphex Twin',
    engines: '  google, duckduckgo web, wikipedia  ',
  });
  // Trimmed at the ends only. The inner spaces are load-bearing: a SearXNG
  // engine name is its `name:` field, e.g. 'duckduckgo web'.
  assert.equal(url.searchParams.get('engines'), 'google, duckduckgo web, wikipedia');
});

test('the pin rides alongside time_range, not instead of it', () => {
  const url = buildSearxngUrl({
    baseUrl: 'http://searx.lan:8888',
    query: 'Aphex Twin',
    recency: 'week',
    engines: 'wikipedia',
  });
  assert.equal(url.searchParams.get('time_range'), 'week');
  assert.equal(url.searchParams.get('engines'), 'wikipedia');
  assert.equal(url.searchParams.get('format'), 'json');
});

test('a base URL with a path still resolves to /search', () => {
  const url = buildSearxngUrl({ baseUrl: 'http://searx.lan:8888/', query: 'x' });
  assert.equal(url.pathname, '/search');
});

test('dispatcher cache separates recency windows and reuses each answer', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://search.test' } });
  const windows: Array<string | null> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    windows.push(url.searchParams.get('time_range'));
    return new Response(JSON.stringify({ results: [{ title: 'Foo', content: `window ${windows.at(-1)}` }] }));
  });
  const all = await searchWeb('recency-cache-regression');
  const week = await searchWeb('recency-cache-regression', { recency: 'week' });
  assert.deepEqual(windows, [null, 'week']);
  assert.notDeepEqual(all, week, 'the two windows have their own data');
  assert.deepEqual(await searchWeb('RECENCY-CACHE-REGRESSION'), all);
  assert.deepEqual(await searchWeb('RECENCY-CACHE-REGRESSION', { recency: 'week' }), week);
  assert.equal(windows.length, 2, 'repeats of both windows use their cached answers');
});

test('empty provider responses are retried instead of cached for the full TTL', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://empty-search.test' } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ results: [] }));
  });
  const query = `empty-cache-regression-${Date.now()}`;
  assert.deepEqual(await searchWeb(query), { answer: '', results: [] });
  assert.deepEqual(await searchWeb(query), { answer: '', results: [] });
  assert.equal(calls, 2, 'an empty result must not be reused from the long-lived cache');
  assert.ok(searchCacheSize() >= 0);
});

test('dispatcher cache is isolated by SearXNG base URL and engine selection', async t => {
  await settings.load();
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url.toString());
    return Response.json({ results: [{ title: url.host, content: url.searchParams.get('engines') || 'default' }] });
  });
  const query = `provider-config-cache-${Date.now()}`;

  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://first.test', searxngEngines: 'google' } });
  const first = await searchWeb(query);
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://second.test', searxngEngines: 'wikipedia' } });
  const second = await searchWeb(query);

  assert.equal(calls.length, 2, 'each provider configuration gets its own cache entry');
  assert.notDeepEqual(first, second);
  assert.match(calls[0], /first\.test/);
  assert.match(calls[0], /engines=google/);
  assert.match(calls[1], /second\.test/);
  assert.match(calls[1], /engines=wikipedia/);
});

test('concurrent identical searches share one provider request', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://dedupe.test', searxngEngines: '' } });
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    await blocked;
    return Response.json({ results: [{ title: 'Shared', content: 'one result' }] });
  });
  const query = `concurrent-search-${Date.now()}`;
  const first = searchWeb(query);
  const second = searchWeb(query);
  await new Promise(resolve => setImmediate(resolve));
  const callsWhilePending = calls;
  release();
  assert.deepEqual(await first, await second);
  assert.equal(callsWhilePending, 1);
  assert.equal(calls, 1);
});

test('aborting the last waiting caller aborts the shared provider fetch', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://abort.test', searxngEngines: '' } });
  let providerSignal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    providerSignal = init?.signal as AbortSignal | undefined;
    await new Promise<never>((_, reject) => {
      providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
    });
    throw new Error('unreachable');
  });
  const controller = new AbortController();
  const request = searchWeb(`abort-search-${Date.now()}`, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(providerSignal, 'provider should receive the resolver signal');
  controller.abort(new Error('cancelled'));
  await assert.rejects(request, /cancelled/);
  assert.equal(providerSignal.aborted, true);
});

test('one aborted caller does not cancel a shared search still needed by another', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://shared-abort.test', searxngEngines: '' } });
  let providerSignal: AbortSignal | undefined;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    providerSignal = init?.signal as AbortSignal | undefined;
    await blocked;
    return Response.json({ results: [{ title: 'Shared', content: 'evidence' }] });
  });
  const firstController = new AbortController();
  const query = `shared-abort-${Date.now()}`;
  const first = searchWeb(query, { signal: firstController.signal });
  const second = searchWeb(query);
  await new Promise(resolve => setImmediate(resolve));
  firstController.abort(new Error('first caller cancelled'));
  await assert.rejects(first, /first caller cancelled/);
  assert.equal(providerSignal?.aborted, false);
  release();
  assert.equal((await second).results[0]?.title, 'Shared');
});

test('rate limits become typed provider failures and are never cached', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://rate-limit.test', searxngEngines: '' } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('slow down', { status: 429 });
  });
  const query = `rate-limit-${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(searchWeb(query), error => {
      assert.ok(isWebSearchProviderError(error));
      assert.equal(error.provider, 'searxng');
      assert.equal(error.reason, 'rate-limit');
      return true;
    });
  }
  assert.equal(calls, 2);
});

test('malformed provider data becomes a typed failure and is never cached', async t => {
  await settings.load();
  await settings.update({ search: { provider: 'searxng', baseUrl: 'https://malformed.test', searxngEngines: '' } });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const query = `malformed-${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(searchWeb(query), error => {
      assert.ok(isWebSearchProviderError(error));
      assert.equal(error.provider, 'searxng');
      assert.equal(error.reason, 'malformed');
      return true;
    });
  }
  assert.equal(calls, 2);
});

test('dispatcher honors every configured search provider without cross-provider fallback', async t => {
  await settings.load();
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(`${url.origin}${url.pathname}`);
    if (url.origin === 'https://api.tavily.com') {
      return Response.json({ answer: 'Tavily answer', results: [{ title: 'Tavily', content: 'evidence' }] });
    }
    if (url.origin === 'https://api.search.brave.com') {
      return Response.json({ web: { results: [{ title: 'Brave', description: 'evidence' }] } });
    }
    if (url.origin === 'https://api.duckduckgo.com') {
      return Response.json({ AbstractText: 'DDG answer', RelatedTopics: [{ Text: 'evidence', FirstURL: 'https://example.test' }] });
    }
    // The real endpoints are intentionally replaced by the fixture response;
    // the request shape still proves the selected dispatcher branch.
    if (init?.method === 'POST') return Response.json({ answer: 'Tavily answer', results: [] });
    return Response.json({ web: { results: [{ title: 'Brave', description: 'evidence' }] } });
  });

  await settings.update({ search: { provider: 'tavily', apiKey: 'fixture-key' } });
  const tavily = await searchWeb(`provider-tavily-${Date.now()}`);
  await settings.update({ search: { provider: 'brave', apiKey: 'fixture-key' } });
  const brave = await searchWeb(`provider-brave-${Date.now()}`);
  await settings.update({ search: { provider: 'duckduckgo' } });
  const duck = await searchWeb(`provider-duck-${Date.now()}`);

  assert.equal(tavily.answer, 'Tavily answer');
  assert.equal(brave.results[0]?.title, 'Brave');
  assert.equal(duck.answer, 'DDG answer');
  assert.deepEqual(calls, [
    'https://api.tavily.com/search',
    'https://api.search.brave.com/res/v1/web/search',
    'https://api.duckduckgo.com/',
  ]);
});
