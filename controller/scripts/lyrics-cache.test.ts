import assert from 'node:assert/strict';
import { BoundedLyricsCache } from '../src/music/lyrics-cache.js';

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}

console.log('public lyrics cache:');

await test('coalesces concurrent requests for one track', async () => {
  const cache = new BoundedLyricsCache<string>();
  let calls = 0;
  const load = async () => { calls++; return 'lyrics'; };
  assert.deepEqual(await Promise.all([cache.get('song', load), cache.get('song', load)]), ['lyrics', 'lyrics']);
  assert.equal(calls, 1);
});

await test('caches present lyrics longer than misses', async () => {
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

await test('briefly caches upstream failures to avoid a retry storm', async () => {
  let now = 0;
  const cache = new BoundedLyricsCache<string>({ negativeTtlMs: 10, now: () => now });
  let calls = 0;
  const fail = async () => { calls++; throw new Error('upstream unavailable'); };
  await assert.rejects(() => cache.get('song', fail), /unavailable/);
  await assert.rejects(() => cache.get('song', fail), /unavailable/);
  assert.equal(calls, 1);
  now = 11;
  await assert.rejects(() => cache.get('song', fail), /unavailable/);
  assert.equal(calls, 2);
});

if (failures) process.exit(1);
console.log('✓ public lyrics cache checks passed');
