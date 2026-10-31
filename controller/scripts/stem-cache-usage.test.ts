// The stem cache's STORED size, for the budget field.
//
// Lowering `audio.stemCacheGb` under what the cache holds makes the next
// hourly sweep delete the difference, and the budget field showed no cache
// size at all. The figure it now shows comes from the usage snapshot
// (`stem-cache-usage.json`) and NEVER from a walk: a walk of a large cache on
// a network share takes minutes, and this is read whenever the Settings page
// opens. Pinned here:
// - storedUsage() reports the snapshot and never walks (cacheWalks unchanged);
// - a snapshot older than a day, or with a pass writing, still reports, but
//   says so (`fresh: false` / `passRunning: true`) — the operator sees an old
//   figure with its age rather than nothing;
// - no snapshot, another root, or a malformed one reports null;
// - GET /stem-cache/usage carries it plus the budget in force.
//
// Run: npm test -- stem-cache-usage

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './test-utils/http.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-stem-usage-'));
after(async () => { await removeTempDir(stateDir); });
process.env.STATE_DIR = stateDir;
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;
const stemCache = await import('../src/music/stem-cache.js');
const { router } = await import('../src/routes/stem-cache.js');
const express = (await import('express')).default;

const root = stemCache.stemsRoot();
const snapFile = join(stateDir, 'stem-cache-usage.json');
const GB = 1024 ** 3;
const HOUR = 3600_000;
const writeSnap = (over: Record<string, unknown>) => {
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({ version: 1, root, bytes: 0, dirs: 0, measuredAt: now, updatedAt: now, ...over }));
};

test('a fresh snapshot is reported as is, with no walk', async () => {
  const measuredAt = new Date(Date.now() - HOUR).toISOString();
  writeSnap({ bytes: 778 * GB, dirs: 76_020, measuredAt });
  const walks = stemCache._cacheWalksForTests();
  const u = await stemCache.storedUsage();
  assert.equal(stemCache._cacheWalksForTests(), walks, 'reading the stored size must never walk the cache');
  assert.ok(u);
  assert.equal(u.bytes, 778 * GB);
  assert.equal(u.dirs, 76_020);
  assert.equal(u.measuredAt, measuredAt);
  assert.equal(u.fresh, true);
  assert.equal(u.passRunning, false);
  assert.equal(u.estTrackBytes, stemCache.estimateTrackBytes(778 * GB, 76_020));
});

test('an old snapshot still reports, marked not fresh', async () => {
  writeSnap({ bytes: 5 * GB, dirs: 400, measuredAt: new Date(Date.now() - 30 * HOUR).toISOString() });
  const walks = stemCache._cacheWalksForTests();
  const u = await stemCache.storedUsage();
  assert.equal(stemCache._cacheWalksForTests(), walks);
  assert.equal(u?.bytes, 5 * GB);
  assert.equal(u?.fresh, false);
});

test('a pass writing right now is said, not hidden', async () => {
  writeSnap({ bytes: 5 * GB, dirs: 400, pending: { pid: process.pid, since: new Date().toISOString() } });
  const u = await stemCache.storedUsage();
  assert.equal(u?.passRunning, true);
  assert.equal(u?.fresh, false);
});

test('no snapshot, another root, or a malformed one is null', async () => {
  rmSync(snapFile, { force: true });
  assert.equal(await stemCache.storedUsage(), null);
  writeSnap({ root: '/elsewhere', bytes: GB, dirs: 10 });
  assert.equal(await stemCache.storedUsage(), null);
  writeSnap({ bytes: 'lots', dirs: 10 });
  assert.equal(await stemCache.storedUsage(), null);
  writeFileSync(snapFile, '{not json');
  assert.equal(await stemCache.storedUsage(), null);
});

test('GET /stem-cache/usage: the stored size and the budget in force', async () => {
  writeSnap({ bytes: 3 * GB, dirs: 250 });
  const app = express();
  app.use(router);
  const s = await listen(app);
  s.server.unref();
  const body = await (await fetch(`${s.url}/stem-cache/usage`)).json() as { usage: { bytes: number; dirs: number } | null; budgetBytes: number };
  assert.equal(body.usage?.bytes, 3 * GB);
  assert.equal(body.usage?.dirs, 250);
  assert.equal(body.budgetBytes, stemCache.budgetBytes());
  rmSync(snapFile, { force: true });
  const none = await (await fetch(`${s.url}/stem-cache/usage`)).json() as { usage: unknown };
  assert.equal(none.usage, null);
  await s.close();
});
