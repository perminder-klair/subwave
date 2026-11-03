// The key banner under Settings → Web search. Tavily, Brave and Firecrawl
// searches refuse a key left in the shared slot by another provider, so it has
// to read as missing, not as "ready to use". The controller says which providers
// refuse the key on file (keyRefusedBy). The banner is rendered to static
// markup, because web has no DOM harness.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { searchKeyIsForeign } from './SearchSection';
import { KeyStatus } from './shared';

test('a key on file is foreign to exactly the providers that refuse it', () => {
  // A Firecrawl key: Tavily and Brave refuse it.
  const fc = ['tavily', 'brave'];
  assert.equal(searchKeyIsForeign('tavily', true, fc), true);
  assert.equal(searchKeyIsForeign('brave', true, fc), true);
  assert.equal(searchKeyIsForeign('firecrawl', true, fc), false);
  // A Tavily key: Brave and Firecrawl refuse it.
  assert.equal(searchKeyIsForeign('firecrawl', true, ['brave', 'firecrawl']), true);
  assert.equal(searchKeyIsForeign('tavily', true, ['brave', 'firecrawl']), false);
  assert.equal(searchKeyIsForeign('tavily', true, []), false);
});

test('no key on file is plain missing, never foreign', () => {
  assert.equal(searchKeyIsForeign('firecrawl', false, ['firecrawl']), false);
  assert.equal(searchKeyIsForeign('tavily', false, ['tavily']), false);
});

test('a controller that does not send the field never shows the warning', () => {
  assert.equal(searchKeyIsForeign('firecrawl', true, undefined), false);
  assert.equal(searchKeyIsForeign('tavily', true, undefined), false);
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
