// The Appearance menu's lite toggle has to reach every useLiteMode reader, not
// just the menu: CSS follows the <html> class by itself, but a skin's rAF loop
// only stops when its own hook re-renders. This pins that setLite flips the
// class, saves the choice and notifies every subscriber, and that the class
// LITE_INIT_SCRIPT sets before paint is what isLite reads back.
//
// Run: `npm test -- lib/lite`.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { isLite, LITE_INIT_SCRIPT, setLite, subscribeLite } from './lite';

function fakeHtml() {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add: (c: string) => { classes.add(c); },
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on?: boolean) => { if (on) classes.add(c); else classes.delete(c); },
    },
  };
}

function fakeStorage(opts: { throws?: boolean } = {}) {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error('QuotaExceededError');
      items.set(k, v);
    },
  };
}

function stubGlobal(t: TestContext, name: 'document' | 'window', value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete (globalThis as Record<string, unknown>)[name];
  });
}

function withBrowser(t: TestContext, opts: { storageThrows?: boolean } = {}) {
  const html = fakeHtml();
  const storage = fakeStorage({ throws: opts.storageThrows });
  stubGlobal(t, 'document', { documentElement: html });
  stubGlobal(t, 'window', { localStorage: storage });
  return { html, storage };
}

test('setLite flips the class, saves the choice and notifies every subscriber', t => {
  const { html, storage } = withBrowser(t);
  let a = 0;
  let b = 0;
  const offA = subscribeLite(() => { a += 1; });
  const offB = subscribeLite(() => { b += 1; });
  t.after(() => { offA(); offB(); });

  setLite(true);
  assert.equal(html.classes.has('lite'), true);
  assert.equal(storage.items.get('subwave-lite'), '1');
  assert.equal(isLite(), true);
  assert.deepEqual([a, b], [1, 1]);

  setLite(false);
  assert.equal(html.classes.has('lite'), false);
  assert.equal(storage.items.get('subwave-lite'), '0');
  assert.equal(isLite(), false);
  assert.deepEqual([a, b], [2, 2]);
});

test('an unsubscribed reader hears nothing more', t => {
  withBrowser(t);
  let calls = 0;
  const off = subscribeLite(() => { calls += 1; });
  setLite(true);
  off();
  setLite(false);
  assert.equal(calls, 1);
});

test('blocked storage still flips the class for the session', t => {
  const { html } = withBrowser(t, { storageThrows: true });
  setLite(true);
  assert.equal(html.classes.has('lite'), true);
  assert.equal(isLite(), true);
});

test('isLite is off on the server and setLite does nothing there', () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(isLite(), false);
  assert.doesNotThrow(() => setLite(true));
});

test('isLite reads the class the pre-paint script set from ?lite=1', t => {
  const { html, storage } = withBrowser(t);
  new Function('document', 'localStorage', 'location', LITE_INIT_SCRIPT)(
    { documentElement: html },
    storage,
    { search: '?lite=1' },
  );
  assert.equal(isLite(), true);
  assert.equal(storage.items.get('subwave-lite'), '1');
});
