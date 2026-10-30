// The keyword tokens (--texture, --finish) reach the stylesheet as data
// attributes on <html>, because CSS cannot branch on a custom property's value.
// Two writers set them — applyTheme at runtime and THEME_INIT_SCRIPT before
// paint — so this pins that both mirror them and that a switch to a theme
// without them clears what the last one left.
//
// Run: `npm test -- lib/theme`.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { applyAppearance, applyTheme, THEME_INIT_SCRIPT, type Theme } from './theme';

function fakeHtml() {
  const style = new Map<string, string>();
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  return {
    style: {
      setProperty: (k: string, v: string) => { style.set(k, v); },
      removeProperty: (k: string) => { style.delete(k); },
      getPropertyValue: (k: string) => style.get(k) ?? '',
    },
    setAttribute: (k: string, v: string) => { attrs.set(k, String(v)); },
    removeAttribute: (k: string) => { attrs.delete(k); },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    classList: {
      toggle: (c: string, on?: boolean) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
}

function withDocument(t: TestContext) {
  const html = fakeHtml();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: html } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as { document?: unknown }).document;
  });
  return html;
}

const PHOSPHOR: Theme = {
  id: 'phosphor',
  name: 'Phosphor',
  mode: 'dark',
  tokens: {
    '--bg': '#04110a',
    '--ink': '#8cffb2',
    '--display-font': 'vt323',
    '--texture': 'scanline',
    '--finish': 'bloom',
  },
};

const PLAIN: Theme = {
  id: 'plain',
  name: 'Plain',
  mode: 'light',
  tokens: { '--bg': '#ffffff', '--ink': '#000000' },
};

test('applyTheme mirrors texture + finish onto <html> and resolves the font id', (t) => {
  const html = withDocument(t);
  applyTheme(PHOSPHOR);
  assert.equal(html.getAttribute('data-texture'), 'scanline');
  assert.equal(html.getAttribute('data-finish'), 'bloom');
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.match(html.style.getPropertyValue('--display-font'), /^var\(--font-vt323\)/);
});

test('switching to a theme without them clears both attributes', (t) => {
  const html = withDocument(t);
  applyTheme(PHOSPHOR);
  applyTheme(PLAIN);
  assert.equal(html.getAttribute('data-texture'), null);
  assert.equal(html.getAttribute('data-finish'), null);
  assert.equal(html.style.getPropertyValue('--texture'), '');
});

test('the built-in base (empty registry) clears them too', (t) => {
  const html = withDocument(t);
  applyTheme(PHOSPHOR);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as { window?: unknown }).window;
  });
  applyAppearance({ theme: null });
  assert.equal(html.getAttribute('data-texture'), null);
  assert.equal(html.getAttribute('data-finish'), null);
});

test('the pre-paint script sets the same attributes from the cached theme', () => {
  const html = fakeHtml();
  const storage = { getItem: (k: string) => (k === 'subwave-theme-tokens' ? JSON.stringify(PHOSPHOR) : null) };
  const win = { matchMedia: () => ({ matches: false }) };
  new Function('document', 'localStorage', 'window', THEME_INIT_SCRIPT)({ documentElement: html }, storage, win);
  assert.equal(html.getAttribute('data-texture'), 'scanline');
  assert.equal(html.getAttribute('data-finish'), 'bloom');
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.match(html.style.getPropertyValue('--display-font'), /^var\(--font-vt323\)/);
});

// The registry poll re-resolves every 30 s. Rewriting identical tokens on <html>
// still invalidates style for the whole document, and on WebKit repaints every
// layer and re-rasterises every canvas watching the theme, so an unchanged
// appearance must reach the DOM not at all.
test('applyAppearance skips a theme the document already shows', (t) => {
  const html = withDocument(t);
  let writes = 0;
  const setProperty = html.style.setProperty;
  html.style.setProperty = (k: string, v: string) => { writes += 1; setProperty(k, v); };

  assert.equal(applyAppearance({ theme: PLAIN }), true);
  const first = writes;
  assert.ok(first > 0);

  assert.equal(applyAppearance({ theme: { ...PLAIN, tokens: { ...PLAIN.tokens } } }), false);
  assert.equal(writes, first, 'an identical theme writes nothing');

  assert.equal(applyAppearance({ theme: PHOSPHOR }), true);
  assert.equal(html.getAttribute('data-finish'), 'bloom');
});

test('a direct applyTheme (the admin builder) counts as what is painted', (t) => {
  withDocument(t);
  applyTheme(PHOSPHOR);
  assert.equal(applyAppearance({ theme: PHOSPHOR }), false);
  applyTheme(PLAIN);
  assert.equal(applyAppearance({ theme: PHOSPHOR }), true, 'the poll restores the station theme after a preview');
});
