// The per-track cache in front of the music server's lyrics call
// (music/lyrics-cache.ts): listener polls must not each become a Subsonic
// request, and a server that fails must not be asked again on every poll.
//
// Run: `npm test -- lyrics-cache`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLyricsCache } from '../src/music/lyrics-cache.js';

test('coalesces concurrent requests for one track', async () => {
  const cache = new BoundedLyricsCache<string>();
  let calls = 0;
  const load = async () => { calls++; return 'lyrics'; };
  assert.deepEqual(await Promise.all([cache.get('song', load), cache.get('song', load)]), ['lyrics', 'lyrics']);
  assert.equal(calls, 1);
});

test('caches present lyrics longer than misses', async () => {
  let now = 0;
  const cache = new BoundedLyricsCache<string>({ positiveTtlMs: 30, negativeTtlMs: 10, now: () => now });
  let hits = 0;
  let misses = 0;
  assert.equal(await cache.get('hit', async () => { hits++; return 'lyrics'; }), 'lyrics');
  assert.equal(await cache.get('miss', async () => { misses++; return null; }), null);
  now = 11;
  assert.equal(await cache.get('hit', async () => { hits++; return 'lyrics'; }), 'lyrics');
  assert.equal(await cache.get('miss', async () => { misses++; return null; }), null);
  assert.equal(hits, 1);
  assert.equal(misses, 2);
});

test('briefly caches upstream failures, then asks again', async () => {
  let now = 0;
  const cache = new BoundedLyricsCache<string>({ negativeTtlMs: 10, now: () => now });
  let calls = 0;
  const fail = async () => { calls++; throw new Error('upstream unavailable'); };
  await assert.rejects(() => cache.get('song', fail), /unavailable/);
  await assert.rejects(() => cache.get('song', fail), /unavailable/);
  assert.equal(calls, 1, 'a second poll inside the window is told the same thing');
  now = 11;
  assert.equal(await cache.get('song', async () => { calls++; return 'back'; }), 'back');
  assert.equal(calls, 2, 'past the window the server is asked again, and a recovery is served');
});

test('holds at most maxEntries tracks, dropping the least recently used', async () => {
  const cache = new BoundedLyricsCache<string>({ maxEntries: 2 });
  const loads: string[] = [];
  const load = (key: string) => async () => { loads.push(key); return key; };
  await cache.get('a', load('a'));
  await cache.get('b', load('b'));
  await cache.get('a', load('a')); // a is now the most recent
  await cache.get('c', load('c')); // evicts b
  await cache.get('a', load('a'));
  await cache.get('b', load('b'));
  assert.deepEqual(loads, ['a', 'b', 'c', 'b']);
});

test('a slow lookup is shared for its whole flight, however long past the TTLs', async () => {
  let now = 0;
  const cache = new BoundedLyricsCache<string>({ positiveTtlMs: 30, negativeTtlMs: 10, now: () => now });
  let calls = 0;
  let release!: (v: string) => void;
  const slow = () => { calls++; return new Promise<string>((r) => { release = r; }); };
  const first = cache.get('song', slow);
  await Promise.resolve();
  now = 25; // past the negative TTL, still in flight
  const second = cache.get('song', slow);
  release('lyrics');
  assert.deepEqual(await Promise.all([first, second]), ['lyrics', 'lyrics']);
  assert.equal(calls, 1, 'the second caller joined the flight rather than starting another');
  now = 50; // inside the positive TTL counted from when it settled
  assert.equal(await cache.get('song', slow), 'lyrics');
  assert.equal(calls, 1);
});
