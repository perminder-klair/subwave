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
// - stems dropped for a replaced file come off the stored size by what they
//   measured, so the next read needs no walk; a drop that cannot be counted
//   (refused part-way) marks it stale instead;
// - a stale snapshot still reports, flagged (`stale: true`), and the sweep
//   re-measures it rather than trusting it; adjustUsage never moves one;
// - no snapshot, another root, or a malformed one reports null;
// - GET /stem-cache/usage carries it plus the budget in force.
//
// Run: npm test -- stem-cache-usage

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('GET /stem-cache/usage: with pick-time stems on, how far over its budget the cache may run', async () => {
  const settings = await import('../src/settings.js');
  const policy = await import('../src/broadcast/pick-stems-policy.js');
  writeSnap({ bytes: 16 * GB, dirs: 1000 });
  const app = express();
  app.use(router);
  const s = await listen(app);
  s.server.unref();
  type Body = { usage: { bytes: number; estTrackBytes: number } | null; budgetBytes: number; pickTimeOvershootBytes?: number };
  const read = async () => (await (await fetch(`${s.url}/stem-cache/usage`)).json()) as Body;
  try {
    const off = await read();
    assert.equal('pickTimeOvershootBytes' in off, false, 'off: the answer is unchanged');
    await settings.update({ transitions: { pickTimeStems: true } });
    const on = await read();
    assert.equal(on.pickTimeOvershootBytes,
      policy.designedOvershootBytes(on.budgetBytes, on.usage!.estTrackBytes),
      'the allowance plus the one separation admitted under it');
    assert.ok(on.pickTimeOvershootBytes! > 0);
    rmSync(snapFile, { force: true });
    assert.equal('pickTimeOvershootBytes' in (await read()), false, 'nothing measured: nothing to size it by');
  } finally {
    await settings.update({ transitions: { pickTimeStems: false } });
    rmSync(snapFile, { force: true });
    await s.close();
  }
});

test('stems dropped for a replaced file come off the stored size, and the next read needs no walk', async () => {
  // Marked stale instead, one replaced file (an MP3 swapped for a FLAC) cost the
  // next read a walk of every stem dir: minutes on a share, holding an import.
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  mkdirSync(stemCache.dirFor('swapped'), { recursive: true });
  writeFileSync(join(stemCache.dirFor('swapped'), 'head-drums.flac'), 'x'.repeat(1000));

  assert.equal((await stemCache.forgetStems(['swapped'])).removed, 1);

  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 80 * GB - 1000);
  assert.equal(got?.dirs, 3999);
  assert.equal(got?.stale, false);
  assert.equal(got?.fresh, true);
  // In the file, not this process: the walk that drops stems is the tagger's child.
  assert.equal(JSON.parse(readFileSync(snapFile, 'utf8')).bytes, 80 * GB - 1000);
  const walks = stemCache._cacheWalksForTests();
  await stemCache.usage();
  await stemCache.headroomTracks(100 * GB);
  assert.equal(stemCache._cacheWalksForTests(), walks, 'no walk');
});

test('stems that refuse to go part-way keep the figure, flagged, and the next read walks', { skip: process.getuid?.() === 0 && 'root deletes through any mode' }, async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  const dir = stemCache.dirFor('stuck');
  mkdirSync(join(dir, 'locked'), { recursive: true });
  writeFileSync(join(dir, 'locked', 'head-drums.flac'), 'x');
  chmodSync(join(dir, 'locked'), 0o555);
  try {
    assert.equal((await stemCache.forgetStems(['stuck'])).failed, 1);
    const got = await stemCache.storedUsage();
    assert.equal(got?.bytes, 80 * GB, 'what went is unknown, so nothing is taken off');
    assert.equal(got?.stale, true);
    const walks = stemCache._cacheWalksForTests();
    await stemCache.usage();
    assert.equal(stemCache._cacheWalksForTests(), walks + 1, 'the next read re-measures it');
  } finally {
    chmodSync(join(dir, 'locked'), 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adjustUsage moves only a snapshot the next read would use as is', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  assert.equal(await stemCache.adjustUsage({ bytes: 0, dirs: 0 }), 'unchanged');
  assert.equal(await stemCache.adjustUsage({ bytes: -GB, dirs: -10 }), 'adjusted');
  assert.deepEqual([(await stemCache.storedUsage())?.bytes, (await stemCache.storedUsage())?.dirs], [79 * GB, 3990]);
  // A stale one is owed a walk: a delta onto it would launder the flag.
  await stemCache.markUsageStale();
  assert.equal(await stemCache.adjustUsage({ bytes: -GB, dirs: -10 }), 'stale');
  assert.equal((await stemCache.storedUsage())?.bytes, 79 * GB);
  assert.equal((await stemCache.storedUsage())?.stale, true);
  // Nothing stored stays nothing.
  rmSync(snapFile, { force: true });
  assert.equal(await stemCache.adjustUsage({ bytes: -GB, dirs: -10 }), 'unchanged');
  assert.equal(await stemCache.storedUsage(), null);
  // The measuredAt of the last full walk is kept, so the daily walk still comes due.
  const old = new Date(Date.now() - 2 * 24 * HOUR).toISOString();
  writeSnap({ bytes: 80 * GB, dirs: 4000, measuredAt: old });
  assert.equal(await stemCache.adjustUsage({ bytes: -GB, dirs: -1 }), 'stale', 'too old to move');
});

test('a stale snapshot is still reported, flagged, and never walked for', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const walks = stemCache._cacheWalksForTests();
  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 80 * GB);
  assert.equal(got?.fresh, false);
  assert.equal(got?.stale, true);
  assert.equal(stemCache._cacheWalksForTests(), walks);
});

test('nothing stored stays nothing: marking stale invents no figure', async () => {
  rmSync(snapFile, { force: true });
  await stemCache.markUsageStale();
  assert.equal(await stemCache.storedUsage(), null);
});

test('stale is a walk for the sweep and the headroom read, and a live pass still owns its mark', () => {
  const base = { version: 1 as const, root, bytes: GB, dirs: 10, measuredAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  assert.equal(stemCache.snapshotVerdict({ snap: base, root, nowMs: Date.now(), pendingAlive: false }), 'use');
  assert.equal(stemCache.snapshotVerdict({ snap: { ...base, stale: true }, root, nowMs: Date.now(), pendingAlive: false }), 'walk');
  const pending = { pid: process.pid, since: new Date().toISOString() };
  assert.equal(stemCache.snapshotVerdict({ snap: { ...base, stale: true, pending }, root, nowMs: Date.now(), pendingAlive: true }), 'pass-running');
});

test('the sweep re-measures a stale snapshot, and the flag goes with it', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, stemCache.STEMS_MARKER), '{}');
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const walks = stemCache._cacheWalksForTests();
  const swept = await stemCache.sweep(100 * GB);
  assert.equal(swept.skipped, undefined, 'walked: a stale figure is not a reason to skip');
  assert.ok(stemCache._cacheWalksForTests() > walks);
  const got = await stemCache.storedUsage();
  assert.equal(got?.bytes, 0, 're-measured');
  assert.equal(got?.fresh, true);
  assert.equal(got?.stale, false);
});

test('a pass settling onto a stale snapshot takes the walk, and cannot launder the flag', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  assert.equal(await stemCache.markPassPending(), true);
  await stemCache.markUsageStale();
  assert.equal(await stemCache.settlePassWrites([]), null);
  assert.equal((await stemCache.storedUsage())?.stale, true);
  // Clear what the refused settlement left for the rest of the file.
  await stemCache.sweep(100 * GB, { force: true });
});

test('GET /stem-cache/usage carries the stale flag to the budget field', async () => {
  writeSnap({ bytes: 80 * GB, dirs: 4000 });
  await stemCache.markUsageStale();
  const app = express();
  app.use(router);
  const { server, url } = await listen(app);
  server.unref();
  const body = await (await fetch(`${url}/stem-cache/usage`)).json() as { usage: { bytes: number; stale: boolean } };
  assert.equal(body.usage.bytes, 80 * GB);
  assert.equal(body.usage.stale, true);
  await new Promise(r => server.close(r));
});
