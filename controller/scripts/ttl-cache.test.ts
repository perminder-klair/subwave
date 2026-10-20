// Unit tests for util/ttl-cache.ts — the TTL + single-flight wrapper behind
// the cached Liquidsoap on-air status (issue #1300, bug 16b).
//
// The bug: GET /settings called streamStatus(), which opens a FRESH telnet
// connection, and the admin UI polls that endpoint every 3s. radio.liq logs a
// `New client` / `Client disconnected` pair per connection, so the mixer log
// filled with them forever for anyone with an admin tab open — indistinguishable
// from a real client churning. (The frequency had teeth beyond noise:
// restartLiquidsoap already carries a comment about a restart command racing "a
// concurrent stream_status poll".)
//
// What must hold: reads inside the window cost nothing, concurrent reads share
// ONE take, an operator action that changes the answer invalidates immediately,
// and a failed take is never cached or served stale.
//
// Run: `npm test -- ttl-cache`.

import assert from 'node:assert/strict';
import { cachedAsync } from '../src/util/ttl-cache.js';

// Injectable clock — no timers, no sleeps.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

// ── the reported bug: repeat polls inside the window take ONE reading ────────

{
  const clock = fakeClock();
  let takes = 0;
  const cache = cachedAsync(async () => { takes++; return true; }, { ttlMs: 10_000, now: clock.now });

  // The admin UI's 3s cadence over 30s: 11 polls.
  for (let i = 0; i < 11; i++) {
    assert.equal(await cache.get(), true);
    clock.advance(3_000);
  }
  assert.equal(takes, 3, '11 polls across 30s at a 10s TTL take 3 readings, not 11');
}

// A reading is served until the TTL expires, then re-taken exactly once.
{
  const clock = fakeClock();
  let takes = 0;
  const cache = cachedAsync(async () => ++takes, { ttlMs: 10_000, now: clock.now });

  assert.equal(await cache.get(), 1);
  clock.advance(9_999);
  assert.equal(await cache.get(), 1, 'still fresh at ttl-1ms');
  clock.advance(1);
  assert.equal(await cache.get(), 2, 're-taken at exactly ttl');
  assert.equal(takes, 2);
}

// ── single flight: concurrent callers share one take ─────────────────────────

{
  const clock = fakeClock();
  let takes = 0;
  let release: (v: string) => void = () => {};
  const cache = cachedAsync(
    () => { takes++; return new Promise<string>(res => { release = res; }); },
    { ttlMs: 10_000, now: clock.now },
  );

  const all = Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(takes, 1, 'three concurrent callers open ONE connection');
  release('on');
  assert.deepEqual(await all, ['on', 'on', 'on'], 'every waiter gets the shared result');
  assert.equal(await cache.get(), 'on', 'and it lands in the cache');
  assert.equal(takes, 1);
}

// ── invalidate: an operator toggle is visible immediately ────────────────────

{
  const clock = fakeClock();
  let onAir = true;
  let takes = 0;
  const cache = cachedAsync(async () => { takes++; return onAir; }, { ttlMs: 10_000, now: clock.now });

  assert.equal(await cache.get(), true);
  onAir = false;                       // stopStream() lands
  assert.equal(await cache.get(), true, 'still cached without an invalidate');
  cache.invalidate();                  // ...which is why stopStream() calls this
  assert.equal(await cache.get(), false, 'the toggle shows up at once, not after the TTL');
  assert.equal(takes, 2);
}

// A take that was already in flight when invalidate() ran predates the change,
// so it must not become the cached entry.
{
  const clock = fakeClock();
  let release: (v: string) => void = () => {};
  let takes = 0;
  const cache = cachedAsync(
    () => { takes++; return new Promise<string>(res => { release = res; }); },
    { ttlMs: 10_000, now: clock.now },
  );

  const pending = cache.get();
  cache.invalidate();
  release('stale');
  assert.equal(await pending, 'stale', 'the in-flight caller still gets its answer');
  assert.equal(cache.peek(), null, 'but it is not published to the cache');
  void cache.get();
  assert.equal(takes, 2, 'the next reader takes a fresh reading');
}

// invalidate() + get() is a LIVE read — the guarantee streamStatusFresh() rests
// on. Invalidating drops the in-flight slot as well as the entry, so the get()
// that follows opens its own connection instead of being handed a poll that was
// already running. Without that, Doctor could "prove the mixer is reachable"
// off a take started before the operator hit Run diagnostics.
{
  const clock = fakeClock();
  const releases: ((v: string) => void)[] = [];
  let takes = 0;
  const cache = cachedAsync(
    () => { takes++; return new Promise<string>(res => { releases.push(res); }); },
    { ttlMs: 10_000, now: clock.now },
  );

  const poll = cache.get();           // a /settings poll, still in flight
  assert.equal(takes, 1);

  cache.invalidate();                 // ...then Doctor asks for a live reading
  const fresh = cache.get();
  assert.equal(takes, 2, 'the fresh read opens its OWN take, not the in-flight one');
  assert.notEqual(poll, fresh, 'and is not handed the in-flight promise');

  releases[0]('on');                  // the older take answers first...
  releases[1]('off');                 // ...but the mixer has since gone off air
  assert.equal(await fresh, 'off', 'the live reading is the one the caller gets');
  assert.deepEqual(cache.peek(), { value: 'off', at: clock.now() }, 'and the one that lands in the cache');
}

// ── failures are never cached, and never masked by a stale value ─────────────

{
  const clock = fakeClock();
  let fail = true;
  let takes = 0;
  const cache = cachedAsync(
    async () => { takes++; if (fail) throw new Error('liquidsoap telnet timeout'); return 'on'; },
    { ttlMs: 10_000, now: clock.now },
  );

  await assert.rejects(() => cache.get(), /telnet timeout/);
  await assert.rejects(() => cache.get(), /telnet timeout/, 'a rejection is not cached — the next call retries');
  assert.equal(takes, 2);
  fail = false;
  assert.equal(await cache.get(), 'on', 'recovers as soon as the mixer answers');
}

// A cached value does NOT paper over a later failure: the caller decides what an
// unreachable mixer means (routes/settings reports streamOnAir: null).
{
  const clock = fakeClock();
  let fail = false;
  const cache = cachedAsync(
    async () => { if (fail) throw new Error('down'); return 'on'; },
    { ttlMs: 10_000, now: clock.now },
  );

  assert.equal(await cache.get(), 'on');
  clock.advance(10_000);
  fail = true;
  await assert.rejects(() => cache.get(), /down/, 'stale values are not served in place of an error');
}

// Concurrent callers on a failing take all see the error, and the in-flight slot
// is released rather than wedged.
{
  const clock = fakeClock();
  let takes = 0;
  let boom: (e: Error) => void = () => {};
  const cache = cachedAsync(
    () => { takes++; return new Promise<string>((_res, rej) => { boom = rej; }); },
    { ttlMs: 10_000, now: clock.now },
  );

  const a = cache.get();
  const b = cache.get();
  assert.equal(takes, 1);
  boom(new Error('ECONNRESET'));
  await assert.rejects(() => a, /ECONNRESET/);
  await assert.rejects(() => b, /ECONNRESET/);
  void cache.get().catch(() => {});
  assert.equal(takes, 2, 'not wedged — a later caller starts a new take');
}

// peek() never takes a reading.
{
  const clock = fakeClock();
  let takes = 0;
  const cache = cachedAsync(async () => { takes++; return 1; }, { ttlMs: 10_000, now: clock.now });
  assert.equal(cache.peek(), null);
  assert.equal(takes, 0);
  await cache.get();
  assert.deepEqual(cache.peek(), { value: 1, at: clock.now() });
  assert.equal(takes, 1);
}

console.log('ttl-cache.test.ts — all assertions passed');
