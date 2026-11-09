// The Hotline's browser-side device id (lib/hotlineCall.ts): kept once, reused,
// and always in the shape the controller's schema accepts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hotlineDeviceId } from './hotlineCall';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

test('a device id is minted once and reused', () => {
  store.clear();
  const first = hotlineDeviceId();
  assert.match(first, SHAPE);
  assert.equal(hotlineDeviceId(), first);
});

test('a hand-edited id that the controller would refuse is replaced', () => {
  store.set('subwave:hotline-device', 'bad id!');
  const id = hotlineDeviceId();
  assert.match(id, SHAPE);
  assert.notEqual(id, 'bad id!');
});
