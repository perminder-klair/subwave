// The Appearance menu's clock toggle: station time stays the default (the DJ
// speaks the station's time, #418), a saved 'local' survives a reload, every
// reader hears a change, and blocked storage still holds the choice for the
// page. displayTimezone is what PlayerCore hands every skin as `timezone`.
//
// Run: `npm test -- lib/clockZone`.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  displayTimezone,
  getClockZone,
  normalizeClockZone,
  resetClockZoneForTests,
  setClockZone,
  subscribeClockZone,
} from './clockZone';

function fakeStorage(opts: { throws?: boolean; initial?: Record<string, string> } = {}) {
  const items = new Map<string, string>(Object.entries(opts.initial ?? {}));
  return {
    items,
    getItem: (k: string) => {
      if (opts.throws) throw new Error('SecurityError');
      return items.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throws) throw new Error('QuotaExceededError');
      items.set(k, v);
    },
  };
}

function withBrowser(t: TestContext, opts: { throws?: boolean; initial?: Record<string, string> } = {}) {
  const storage = fakeStorage(opts);
  const handlers = new Map<string, (e: unknown) => void>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: storage,
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers.set(type, fn); },
      removeEventListener: (type: string) => { handlers.delete(type); },
    },
  });
  resetClockZoneForTests();
  t.after(() => {
    resetClockZoneForTests();
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete (globalThis as Record<string, unknown>).window;
  });
  return { storage, handlers };
}

test('station time is the default, on the server and in a fresh browser', t => {
  assert.equal(typeof window, 'undefined');
  assert.equal(getClockZone(), 'station');
  withBrowser(t);
  assert.equal(getClockZone(), 'station');
});

test('a saved choice is read back, and junk falls back to station', t => {
  withBrowser(t, { initial: { 'subwave-clock-zone': 'local' } });
  assert.equal(getClockZone(), 'local');
  assert.equal(normalizeClockZone('utc'), 'station');
  assert.equal(normalizeClockZone(null), 'station');
});

test('setClockZone saves the choice and notifies every subscriber', t => {
  const { storage } = withBrowser(t);
  let a = 0;
  let b = 0;
  const offA = subscribeClockZone(() => { a += 1; });
  const offB = subscribeClockZone(() => { b += 1; });
  setClockZone('local');
  assert.equal(getClockZone(), 'local');
  assert.equal(storage.items.get('subwave-clock-zone'), 'local');
  offB();
  setClockZone('station');
  assert.equal(getClockZone(), 'station');
  assert.deepEqual([a, b], [2, 1]);
  offA();
});

test('another tab saving a choice reaches this one', t => {
  const { handlers } = withBrowser(t);
  let calls = 0;
  const off = subscribeClockZone(() => { calls += 1; });
  handlers.get('storage')?.({ key: 'unrelated', newValue: 'x' });
  handlers.get('storage')?.({ key: 'subwave-clock-zone', newValue: 'local' });
  assert.equal(calls, 1);
  assert.equal(getClockZone(), 'local');
  off();
  assert.equal(handlers.has('storage'), false);
});

test('blocked storage still holds the choice for the page', t => {
  withBrowser(t, { throws: true });
  assert.equal(getClockZone(), 'station');
  setClockZone('local');
  assert.equal(getClockZone(), 'local');
});

test('displayTimezone: station passes the station zone through, local names the browser zone', () => {
  assert.equal(displayTimezone('Europe/London', 'station', 'Asia/Kolkata'), 'Europe/London');
  assert.equal(displayTimezone('Europe/London', 'local', 'Asia/Kolkata'), 'Asia/Kolkata');
  // Before the first poll the station zone is null, and every formatter then
  // uses the browser's anyway.
  assert.equal(displayTimezone(null, 'station', 'Asia/Kolkata'), null);
});
