// Pins util/bounded-key-map.ts — the one bound every per-client limiter map
// shares (request cooldown/caps, station-password throttle, likes, admin
// strikes, beacons). Each case is a way a hand-rolled cleanup used to fail.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedKeyMap, boundKey, MAX_KEY_LENGTH } from '../src/util/bounded-key-map.js';

const WINDOW = 1_000;
const hitsMap = (maxKeys: number) => new BoundedKeyMap<number[]>({
  maxKeys,
  isLive: (hits, now) => hits.some(t => now - t < WINDOW),
});

test('a short key is kept verbatim; a long one becomes a short hash', () => {
  assert.equal(boundKey('203.0.113.7'), '203.0.113.7');
  assert.equal(boundKey('2001:db8::1'), '2001:db8::1');
  const long = 'x'.repeat(16_000);
  const bounded = boundKey(long);
  assert.ok(bounded.length <= MAX_KEY_LENGTH, `hashed key is ${bounded.length} chars`);
  assert.equal(boundKey(long), bounded, 'the hash is stable, so the client keeps its bucket');
});

test('two long keys sharing a prefix stay two buckets', () => {
  const prefix = 'y'.repeat(MAX_KEY_LENGTH * 2);
  const m = hitsMap(10);
  m.set(`${prefix}a`, [1], 1);
  m.set(`${prefix}b`, [2], 2);
  assert.equal(m.size, 2);
  assert.deepEqual(m.get(`${prefix}a`), [1]);
  assert.deepEqual(m.get(`${prefix}b`), [2]);
});

test('the key count never exceeds the cap, even when every entry is live', () => {
  const m = hitsMap(100);
  for (let i = 0; i < 1_000; i++) m.set(`k${i}`, [0], 0);
  assert.ok(m.size <= 100, `size ${m.size}`);
  assert.deepEqual(m.get('k999'), [0], 'the entry just written survives');
  assert.equal(m.get('k0'), undefined, 'the least recently written goes first');
});

test('an entry whose only hit is old is spent, even though its hit list is not empty', () => {
  // The old cleanups tested `!hits.length` on a list only its own key ever
  // re-filters, so a client that called once and never returned stayed forever.
  const m = hitsMap(10);
  m.set('one-shot', [0], 0);
  for (let i = 0; i < 10; i++) m.set(`live${i}`, [5_000], 5_000);
  assert.equal(m.get('one-shot'), undefined, 'the expired record is evicted');
});

test('expired entries go before live ones, wherever they sit in the map', () => {
  const m = hitsMap(10);
  m.set('old-live', [4_500], 4_500);         // oldest write, still in its window
  m.set('stale0', [0], 0);                    // newer writes, already spent
  m.set('stale1', [0], 0);
  for (let i = 0; i < 7; i++) m.set(`live${i}`, [5_000], 5_000);
  m.set('trigger', [5_000], 5_000);           // 11th key: over the cap
  assert.equal(m.get('stale0'), undefined);
  assert.equal(m.get('stale1'), undefined);
  assert.deepEqual(m.get('old-live'), [4_500], 'a live counter survives while a spent one can go');
});

test('a re-written key moves to the recent end', () => {
  const m = hitsMap(10);
  for (let i = 0; i < 10; i++) m.set(`k${i}`, [0], 0);
  m.set('k0', [0, 1], 1);                     // the oldest write, touched again
  m.set('k10', [1], 1);                       // over the cap: trim to low water
  assert.deepEqual(m.get('k0'), [0, 1], 'touched recently, so kept');
  assert.equal(m.get('k1'), undefined, 'now the least recently written');
  assert.ok(m.size <= 9, `trimmed to the low-water mark (size ${m.size})`);
});
