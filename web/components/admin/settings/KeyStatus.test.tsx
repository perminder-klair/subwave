// The key banner under Settings → Web search. Firecrawl searches refuse any key
// that isn't an fc- one, so a key left in the shared slot by another provider
// has to read as missing, not as "ready to use". The banner is rendered to
// static markup, because web has no DOM harness.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { firecrawlKeyIsForeign } from './SearchSection';
import { KeyStatus } from './shared';

test('a key on file that is not an fc- one counts as foreign, only for Firecrawl', () => {
  assert.equal(firecrawlKeyIsForeign('firecrawl', true, null), true);
  assert.equal(firecrawlKeyIsForeign('firecrawl', true, 'settings'), false);
  assert.equal(firecrawlKeyIsForeign('firecrawl', true, 'env'), false);
  assert.equal(firecrawlKeyIsForeign('firecrawl', false, null), false, 'no key is plain missing');
  assert.equal(firecrawlKeyIsForeign('tavily', true, null), false);
});

test('a controller that does not send the field never shows the warning', () => {
  assert.equal(firecrawlKeyIsForeign('firecrawl', true, undefined), false);
});

test('KeyStatus keeps its stock sentences without a detail', () => {
  const found = renderToStaticMarkup(createElement(KeyStatus, { envVar: 'SEARCH_API_KEY', present: true }));
  assert.match(found, /API key found in environment/);
  assert.match(found, /ready to use/);
  const missing = renderToStaticMarkup(createElement(KeyStatus, { envVar: 'SEARCH_API_KEY', present: false }));
  assert.match(missing, /API key missing/);
  assert.match(missing, /is not set/);
});

test('a detail replaces the missing-key sentence too', () => {
  const html = renderToStaticMarkup(createElement(KeyStatus, {
    envVar: 'SEARCH_API_KEY',
    present: false,
    detail: 'The key on file is not a Firecrawl key',
  }));
  assert.match(html, /API key missing/);
  assert.match(html, /The key on file is not a Firecrawl key/);
  assert.doesNotMatch(html, /is not set/);
  assert.doesNotMatch(html, /ready to use/);
});
