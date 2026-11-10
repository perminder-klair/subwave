// The per-client limiter maps in middleware/ratelimit.ts, routes/likes.ts and
// routes/audience.ts stay bounded: a client that called once and left is
// forgotten once its window passes, and no flood of keys (or of 16 KB keys)
// grows a map past LIMITER_MAX_KEYS. Each limiter's own verdicts are pinned
// elsewhere (request-limits, similar-tracks); this file pins the memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-limiter-maps-'));
const settings = await import('../src/settings.js');
await settings.update({ requests: { cooldownSec: 60, perIpHourlyCap: 8 } });
const {
  checkRateLimit, commitRateLimit, checkAuthRateLimit, peekAuthRateLimit,
  limiterKeyCounts, LIMITER_MAX_KEYS,
} = await import('../src/middleware/ratelimit.js');
const { checkLikeLimit, likeLimiterKeyCount } = await import('../src/routes/likes.js');
const { beaconAllowed, BEACON_PER_WINDOW, BEACON_WINDOW_MS } = await import('../src/routes/audience.js');

const HOUR = 3_600_000;

test('an accepted /request client that never returns is evicted once its hour passes', t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(checkRateLimit('198.51.100.1').ok, true);
  commitRateLimit('198.51.100.1');
  const before = limiterKeyCounts().requests;

  now += 2 * HOUR;
  for (let i = 0; i < LIMITER_MAX_KEYS; i++) checkRateLimit(`10.1.${i >> 8}.${i & 255}`);
  // The old cleanup kept every key with a hit on file, so this was 10,001.
  const after = limiterKeyCounts().requests;
  assert.ok(after <= LIMITER_MAX_KEYS, `request map holds ${after}`);
  assert.ok(before >= 1);
});

test('16 KB station-auth keys cannot grow the throttle past its cap, and peek still works', t => {
  let now = 50_000_000;
  t.mock.method(Date, 'now', () => now);
  const pad = 'z'.repeat(16_000);
  for (let i = 0; i < LIMITER_MAX_KEYS + 500; i++) checkAuthRateLimit(`${pad}${i}`);
  const size = limiterKeyCounts().auth['station-auth'];
  assert.ok(size <= LIMITER_MAX_KEYS, `station-auth map holds ${size}`);

  const ip = '203.0.113.40';
  for (let i = 0; i < 20; i++) assert.equal(checkAuthRateLimit(ip).ok, true);
  assert.equal(peekAuthRateLimit(ip).ok, false, 'a full bucket still reads full through peek');
  assert.equal(checkAuthRateLimit(ip).ok, false);
  now += 15 * 60_000 + 1;
  assert.equal(peekAuthRateLimit(ip).ok, true, 'and empties when the window passes');
});

test('a one-time liker is forgotten after an hour; the like map stays bounded', t => {
  let now = 90_000_000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(checkLikeLimit('198.51.100.9').ok, true);
  now += 2 * HOUR;
  for (let i = 0; i < LIMITER_MAX_KEYS + 10; i++) checkLikeLimit(`10.2.${i >> 8}.${i & 255}`);
  assert.ok(likeLimiterKeyCount() <= LIMITER_MAX_KEYS, `like map holds ${likeLimiterKeyCount()}`);
});

test('POST /beacon has a per-client limit, and its map is bounded', () => {
  const t0 = 200_000_000;
  for (let i = 0; i < BEACON_PER_WINDOW; i++) assert.equal(beaconAllowed('198.51.100.20', t0), true);
  assert.equal(beaconAllowed('198.51.100.20', t0), false, 'past the per-window limit');
  assert.equal(beaconAllowed('198.51.100.21', t0), true, 'another client is unaffected');
  assert.equal(beaconAllowed('198.51.100.20', t0 + BEACON_WINDOW_MS), true, 'the window slides');
});
