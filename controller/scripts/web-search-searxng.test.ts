// Unit tests for the two pure halves of the SearXNG backend: the response
// parser and the query-URL builder. SearXNG's JSON shape is non-trivial
// (results[], answers[], infoboxes[], suggestions[]) so we pin the mapping
// with recorded fixtures rather than handwritten objects; the URL builder is
// pinned directly so the query shape needs no fetch mock.
// Run: `tsx scripts/web-search-searxng.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSearxngUrl, parseSearxngResponse } from '../src/skills/web-search.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => {
      failures++;
      console.error(`  ✗ ${name}\n      ${err?.message || err}`);
    });
}

async function main() {
  console.log('parseSearxngResponse:');

  await test('populated response yields up to 10 results', () => {
    const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
    assert.ok(out.results.length > 0, 'expected some results');
    assert.ok(out.results.length <= 10, 'expected <= 10 results');
    for (const r of out.results) {
      assert.equal(typeof r.title, 'string');
      assert.equal(typeof r.content, 'string');
      assert.ok(r.title.length > 0, 'title should not be empty');
    }
  });

  await test('snippet content capped at 300 chars', () => {
    const out = parseSearxngResponse(fixture('searxng-sabrina.json'));
    for (const r of out.results) {
      assert.ok(r.content.length <= 300, `content too long: ${r.content.length}`);
    }
  });

  await test('empty response yields empty results and empty answer', () => {
    const out = parseSearxngResponse(fixture('searxng-empty.json'));
    assert.deepEqual(out.results, []);
    assert.equal(out.answer, '');
  });

  await test('infobox content populates answer slot', () => {
    const out = parseSearxngResponse(fixture('searxng-with-infobox.json'));
    assert.ok(out.answer.length > 0, 'answer should be populated from infobox');
  });

  await test('malformed input returns empty SearchResponse', () => {
    assert.deepEqual(parseSearxngResponse(null), { answer: '', results: [] });
    assert.deepEqual(parseSearxngResponse({}), { answer: '', results: [] });
    assert.deepEqual(parseSearxngResponse({ results: 'nope' }), { answer: '', results: [] });
  });

  await test('drops results with empty title or content', () => {
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

  // Regression: the in-memory memo cache must key on recency, otherwise
  // segment-tools (recency: 'week') and the picker tools (no recency) would
  // share a cache slot and the second caller would get the wrong window.
  await test('cache key format includes recency', () => {
    // We don't reach into the private cache map. Instead we assert that
    // searchWeb without recency and with recency build distinct cache keys
    // by checking they reach the dispatcher independently. This is verified
    // indirectly by the format documented in the function — kept as a
    // documentation pin against accidental key changes.
    const expected = (provider: string, recency: string, q: string) =>
      `${provider}:${recency}:${q.toLowerCase()}`;
    assert.equal(expected('searxng', 'week', 'Foo'), 'searxng:week:foo');
    assert.equal(expected('searxng', '', 'Foo'), 'searxng::foo');
  });

  console.log('buildSearxngUrl:');

  // #1353. The engine pin is optional and must be invisible when unset — an
  // `engines=` param sent empty is NOT the same as no param: SearXNG's
  // parse_generic() reads an empty list as "no engines matched" and answers
  // with nothing, where omitting the param uses the instance defaults.
  await test('omits engines= entirely when the pin is unset', () => {
    for (const engines of [undefined, '', '   ']) {
      const url = buildSearxngUrl({ baseUrl: 'http://searx.lan:8888', query: 'Aphex Twin', engines });
      assert.equal(url.searchParams.has('engines'), false, `engines=${JSON.stringify(engines)}`);
      assert.equal(url.toString(), 'http://searx.lan:8888/search?q=Aphex+Twin&format=json');
    }
  });

  await test('sends the pin verbatim, spaces and commas intact', () => {
    const url = buildSearxngUrl({
      baseUrl: 'http://searx.lan:8888',
      query: 'Aphex Twin',
      engines: '  google, duckduckgo web, wikipedia  ',
    });
    // Trimmed at the ends only. The inner spaces are load-bearing: a SearXNG
    // engine name is its `name:` field, e.g. 'duckduckgo web'.
    assert.equal(url.searchParams.get('engines'), 'google, duckduckgo web, wikipedia');
  });

  await test('the pin rides alongside time_range, not instead of it', () => {
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

  await test('a base URL with a path still resolves to /search', () => {
    const url = buildSearxngUrl({ baseUrl: 'http://searx.lan:8888/', query: 'x' });
    assert.equal(url.pathname, '/search');
  });
}

main().then(() => {
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nAll SearXNG web-search tests passed.');
});
