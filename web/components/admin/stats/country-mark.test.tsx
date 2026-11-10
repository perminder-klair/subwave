// Top countries on Stats › Who's listening: a country shows its flag, with the
// name and code on hover, and a code with no flag keeps the boxed code.
//
// Run: npm test -- country-mark

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CountryMark from './CountryMark';

test('a country code shows its flag, hidden from screen readers, with the code on hover', () => {
  const html = renderToStaticMarkup(createElement(CountryMark, { code: 'GR' }));
  assert.ok(html.includes('\u{1F1EC}\u{1F1F7}'), html);
  assert.match(html, /<span aria-hidden="true">/);
  assert.match(html, /title="[^"]*\(GR\)"/);
  assert.doesNotMatch(html, /border-ink/);
  assert.doesNotMatch(html, />GR</);
});

test('a code with no flag keeps the boxed code', () => {
  for (const code of ['T1', 'gr', '']) {
    const html = renderToStaticMarkup(createElement(CountryMark, { code }));
    assert.match(html, /border-ink/, code);
    assert.ok(html.includes(`>${code}</span>`), html);
  }
});
