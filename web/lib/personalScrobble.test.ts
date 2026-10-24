// Run: `npm test -- lib/personalScrobble`.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  personalScrobbleEnabled,
  setPersonalScrobbleEnabled,
  subscribePersonalScrobble,
} from './personalScrobble';

function stubWindow(t: TestContext, storageThrows = false) {
  const items = new Map<string, string>();
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const window = {
    localStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('SecurityError');
        return items.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error('SecurityError');
        items.set(key, value);
      },
      removeItem: (key: string) => {
        if (storageThrows) throw new Error('SecurityError');
        items.delete(key);
      },
    },
    addEventListener: (name: string, listener: (event: Event) => void) => {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
    },
    removeEventListener: (name: string, listener: (event: Event) => void) => {
      listeners.get(name)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as Record<string, unknown>).window;
  });
  return { items };
}

test('the preference is off on the server', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(personalScrobbleEnabled(), false);
  assert.doesNotThrow(() => setPersonalScrobbleEnabled(true));
});

test('the preference persists locally and notifies subscribers', t => {
  const { items } = stubWindow(t);
  let calls = 0;
  const unsubscribe = subscribePersonalScrobble(() => { calls += 1; });

  setPersonalScrobbleEnabled(true);
  assert.equal(items.get('subwave-personal-scrobble'), '1');
  assert.equal(personalScrobbleEnabled(), true);
  assert.equal(calls, 1);

  setPersonalScrobbleEnabled(false);
  assert.equal(items.has('subwave-personal-scrobble'), false);
  assert.equal(personalScrobbleEnabled(), false);
  assert.equal(calls, 2);
  unsubscribe();
});

test('blocked local storage still keeps the choice for this tab', t => {
  stubWindow(t, true);
  setPersonalScrobbleEnabled(true);
  assert.equal(personalScrobbleEnabled(), true);
  setPersonalScrobbleEnabled(false);
  assert.equal(personalScrobbleEnabled(), false);
});
