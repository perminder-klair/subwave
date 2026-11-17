// Top countries on Stats › Who's listening: a country shows its flag, with the
// name and code on hover, and a code with no flag keeps the boxed code.
//
// The name column beside the cell is what a screen reader announces, so the
// cell is hidden from it as a whole: the glyph or boxed code and the hover
// title alike. A title on an element a screen reader can still reach is read
// as its description, which says the country a second time.
//
// Run: npm test -- country-mark

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CountryMark from './CountryMark';

const render = (code: string) => renderToStaticMarkup(createElement(CountryMark, { code }));

// Every element in the markup must be aria-hidden itself or sit inside one that
// is. The cell is a flat span or a span of spans, so checking that the outermost
// element is hidden covers everything inside it.
function assertHiddenFromScreenReaders(html: string) {
  assert.match(html, /^<span aria-hidden="true"[^>]*>/, html);
  // The title sits on that hidden element, never on one outside it.
  const outer = html.match(/^<span[^>]*>/)?.[0] ?? '';
  const titles = html.match(/title="/g) ?? [];
  assert.equal(titles.length, outer.includes('title="') ? 1 : 0, html);
}

test('a country code shows its flag, with the name and code on hover', () => {
  const html = render('GR');
  assert.ok(html.includes('\u{1F1EC}\u{1F1F7}'), html);
  assert.match(html, /title="[^"]*\(GR\)"/);
  assert.doesNotMatch(html, /border-ink/);
  assert.doesNotMatch(html, />GR</);
});

test('the flag cell, hover title included, is hidden from screen readers', () => {
  const html = render('GR');
  assertHiddenFromScreenReaders(html);
  // The hover is still there for a mouse, on the hidden element itself.
  assert.match(html, /^<span aria-hidden="true"[^>]*title="[^"]*\(GR\)"/, html);
});

test('a code with no flag keeps the boxed code', () => {
  for (const code of ['T1', 'gr', '']) {
    const html = render(code);
    assert.match(html, /border-ink/, code);
    assert.ok(html.includes(`>${code}</span>`), html);
  }
});

test('the boxed code is hidden from screen readers too, since the name column prints it', () => {
  for (const code of ['T1', 'gr', '']) assertHiddenFromScreenReaders(render(code));
  assert.match(render('T1'), /^<span aria-hidden="true"[^>]*title="[^"]*\(T1\)"/);
});
