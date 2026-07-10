// Unit tests for the pure Brave Search response parser (issue #623). Brave's
// web-search JSON nests results under web.results[] and news.results[], with
// an optional infobox whose `results` has been observed as both an object and
// an array — so we pin the mapping with a recorded-shape fixture rather than
// handwritten objects, mirroring web-search-searxng.test.ts.
// Run: `tsx scripts/web-search-brave.test.ts` (folded into `npm test`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBraveResponse } from '../src/skills/web-search.js';

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
  console.log('parseBraveResponse:');

  await test('populated response yields up to 10 results', () => {
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

  await test('news results lead, web results follow', () => {
    const out = parseBraveResponse(fixture('brave-artist.json'));
    assert.ok(out.results[0].title.includes('world tour'), 'first result should be news');
    assert.ok(
      out.results.some(r => r.title.includes('Wikipedia')),
      'web results should follow news',
    );
  });

  await test('snippets are stripped of tags and entities', () => {
    const out = parseBraveResponse(fixture('brave-artist.json'));
    const tour = out.results[0];
    assert.ok(!tour.content.includes('<strong>'), 'tags should be stripped');
    assert.ok(!tour.content.includes('&#x27;'), 'hex entities should be decoded');
    assert.ok(tour.content.includes("star's"), 'decoded apostrophe should survive');
    const review = out.results[1];
    assert.ok(review.content.includes('& its four new songs'), '&amp; should decode');
  });

  await test('snippet content capped at 300 chars', () => {
    const out = parseBraveResponse(fixture('brave-artist.json'));
    for (const r of out.results) {
      assert.ok(r.content.length <= 300, `content too long: ${r.content.length}`);
    }
  });

  await test('results without a description are skipped', () => {
    const out = parseBraveResponse(fixture('brave-artist.json'));
    assert.ok(
      !out.results.some(r => r.title.includes('empty description')),
      'empty-description result should be dropped',
    );
  });

  await test('infobox long_desc populates answer slot (object form)', () => {
    const out = parseBraveResponse(fixture('brave-artist.json'));
    assert.ok(out.answer.includes('American singer'), 'answer should come from infobox');
  });

  await test('infobox results as an array also populates answer', () => {
    const out = parseBraveResponse({
      infobox: { type: 'graph', results: [{ long_desc: 'From the array form.' }] },
    });
    assert.equal(out.answer, 'From the array form.');
  });

  await test('empty response yields empty results and empty answer', () => {
    const out = parseBraveResponse(fixture('brave-empty.json'));
    assert.deepEqual(out.results, []);
    assert.equal(out.answer, '');
  });

  await test('malformed input returns empty SearchResponse', () => {
    assert.deepEqual(parseBraveResponse(null), { answer: '', results: [] });
    assert.deepEqual(parseBraveResponse('nope'), { answer: '', results: [] });
    assert.deepEqual(parseBraveResponse({ web: { results: 'nope' } }), { answer: '', results: [] });
    assert.deepEqual(
      parseBraveResponse({ web: { results: [null, 42, { title: 'no content' }] } }),
      { answer: '', results: [] },
    );
  });

  await test('malformed numeric entities are left intact, not crashed on', () => {
    const out = parseBraveResponse({
      web: { results: [{ title: 'T', description: 'bad &#zz; entity and huge &#99999999;' }] },
    });
    assert.equal(out.results.length, 1);
    assert.ok(out.results[0].content.includes('&#zz;'), 'non-numeric entity untouched');
    assert.ok(out.results[0].content.includes('&#99999999;'), 'out-of-range entity untouched');
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll Brave parser tests passed.');
}

main();
