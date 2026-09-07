// Pins for the feed parser (src/skills/feed.ts). The feed URL is operator
// input — anything typed into ANY skill's `feed:` field — and a feed that
// doesn't parse fails SILENTLY (no items, the beat just never airs), so the
// dialects below are the contract. The generated tool that consumes them is
// pinned separately, in scripts/skill-feed-tool.test.ts.
//
// Written against node:test, so `npm test -- feed-parse` reports per-assertion
// rather than as one pass/fail for the whole file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, hashHeadline } from '../src/skills/feed.js';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Station News</title>
  <description>The channel blurb, which is NOT a headline</description>
  <item><title>First story</title><description>First blurb</description></item>
  <item><title><![CDATA[Second & <b>bold</b>]]></title><description><![CDATA[<p>Second blurb</p>]]></description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Station News</title>
  <entry><title type="html">Atom &amp; one</title><summary>Sum one</summary></entry>
  <entry><title>Atom two</title><content type="html"><![CDATA[<p>Body two</p>]]></content></entry>
</feed>`;

// RSS 1.0 / RDF — items sit at the document root, siblings of <channel>, and
// the root tag carries a namespace prefix.
const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel><title>Station News</title></channel>
  <item><title>RDF one</title><description>RDF blurb</description></item>
</rdf:RDF>`;

test('RSS 2.0 — the shape the old regex scanner handled', () => {
  const items = parseFeed(RSS2, 10);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'First story', description: 'First blurb' });
});

test('the channel title is not mistaken for a headline', () => {
  const titles = parseFeed(RSS2, 10).map((i) => i.title);
  assert.ok(!titles.includes('Station News'), `channel title leaked: ${titles.join(', ')}`);
});

test('CDATA is unwrapped and markup stripped', () => {
  const [, second] = parseFeed(RSS2, 10);
  assert.equal(second.title, 'Second & bold');
  assert.equal(second.description, 'Second blurb');
});

test('Atom entries parse — the old scanner returned zero here', () => {
  const items = parseFeed(ATOM, 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Atom & one');
  assert.equal(items[0].description, 'Sum one');
});

test('Atom falls back from summary to content for the blurb', () => {
  const [, second] = parseFeed(ATOM, 10);
  assert.equal(second.title, 'Atom two');
  assert.equal(second.description, 'Body two');
});

test('RDF / RSS 1.0 parses — items at the root, prefixed root tag', () => {
  const items = parseFeed(RDF, 10);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], { title: 'RDF one', description: 'RDF blurb' });
});

test('a single item is not dropped for being unwrapped', () => {
  const one = `<rss><channel><item><title>Only one</title></item></channel></rss>`;
  const items = parseFeed(one, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Only one');
  assert.equal(items[0].description, '');
});

test('a numeric-looking headline stays a string', () => {
  const feed = `<rss><channel><item><title>2026</title><description>1.2.3</description></item></channel></rss>`;
  const [item] = parseFeed(feed, 10);
  assert.equal(item.title, '2026');
  assert.equal(item.description, '1.2.3');
  // hashHeadline indexes by string; a number here would throw on .length/.charCodeAt.
  assert.equal(typeof hashHeadline(item.title), 'string');
});

test('entries with no title are dropped, not aired blank', () => {
  const feed = `<rss><channel>
    <item><description>orphan blurb</description></item>
    <item><title>Real one</title></item>
  </channel></rss>`;
  const items = parseFeed(feed, 10);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Real one');
});

test('the cap is honoured', () => {
  assert.equal(parseFeed(RSS2, 1).length, 1);
  assert.equal(parseFeed(RSS2, 0).length, 0);
});

test('junk never throws into the segment director', () => {
  for (const junk of ['', 'not xml at all', '<rss><channel>', '{"json":true}', '<html><body><p>hi</p></body></html>']) {
    assert.deepEqual(parseFeed(junk, 5), [], `expected [] for ${JSON.stringify(junk)}`);
  }
});

test('hashHeadline is stable and title-sensitive', () => {
  assert.equal(hashHeadline('First story'), hashHeadline('First story'));
  assert.notEqual(hashHeadline('First story'), hashHeadline('Second story'));
});
