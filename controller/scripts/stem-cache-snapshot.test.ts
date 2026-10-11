// Tests for the stem cache usage snapshot (music/stem-cache.ts).
//
// A full walk stats every file of every track dir. On a 63k-dir cache that is
// hundreds of thousands of metadata reads: a sleeping disk woken every hour by
// the sweep, and ~12 minutes per walk on a network share, twice per analysis
// pass. The snapshot keeps the last walk's totals and lets the hourly sweep,
// the pass's headroom read and the doctor reuse them while nothing can have
// changed. What it must never do is let the cache grow past its budget
// unseen, so these tests pin when it is NOT trusted:
// - older than a day (catches dirs added or removed by hand);
// - another root (relocated cache, other station);
// - a pass marked pending that is no longer alive (its dirs were never added).
//
// Runs against a temp STATE_DIR set before stem-cache is imported.
// Run: `tsx scripts/stem-cache-snapshot.test.ts` (auto-discovered by npm test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stem-snapshot-'));
process.env.STATE_DIR = stateDir;
const stemCache = await import('../src/music/stem-cache.js');
const root = stemCache.stemsRoot();
const snapFile = join(stateDir, 'stem-cache-usage.json');
const MB = 1024 ** 2;
const HOUR = 3600_000;

const readSnap = () => JSON.parse(readFileSync(snapFile, 'utf8'));
const writeSnap = (over: Record<string, unknown>) => {
  const now = new Date().toISOString();
  writeFileSync(snapFile, JSON.stringify({ version: 1, root, bytes: 0, dirs: 0, measuredAt: now, updatedAt: now, ...over }));
};
const makeDir = (id: string, bytes: number) => {
  const dir = stemCache.dirFor(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'head-drums.flac'), Buffer.alloc(bytes));
};
const reset = () => {
  rmSync(root, { recursive: true, force: true });
  rmSync(snapFile, { force: true });
};

// ---- snapshotVerdict (pure) ----------------------------------------------
const now = Date.parse('2026-10-06T12:00:00Z');
const snapAt = (ageMs: number, extra: Record<string, unknown> = {}) => ({
  version: 1 as const, root, bytes: 10, dirs: 1,
  measuredAt: new Date(now - ageMs).toISOString(), updatedAt: new Date(now).toISOString(), ...extra,
});

test('verdict: a fresh snapshot of this root is used', () => {
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(HOUR), root, nowMs: now, pendingAlive: false }), 'use');
});

test('verdict: none, another root, or older than a day means walk', () => {
  assert.equal(stemCache.snapshotVerdict({ snap: null, root, nowMs: now, pendingAlive: false }), 'walk');
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(HOUR), root: '/elsewhere', nowMs: now, pendingAlive: false }), 'walk');
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(25 * HOUR), root, nowMs: now, pendingAlive: false }), 'walk');
});

test('verdict: a live pass owns the cache, a dead one forces a walk', () => {
  const pending = { pending: { pid: 4242, since: new Date(now - HOUR).toISOString() } };
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(HOUR, pending), root, nowMs: now, pendingAlive: true }), 'pass-running');
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(HOUR, pending), root, nowMs: now, pendingAlive: false }), 'walk');
  const ancient = { pending: { pid: 4242, since: new Date(now - 49 * HOUR).toISOString() } };
  assert.equal(stemCache.snapshotVerdict({ snap: snapAt(HOUR, ancient), root, nowMs: now, pendingAlive: true }), 'walk');
});

// ---- usage / sweep against the disk --------------------------------------

test('first usage() walks and records a snapshot; the next one reuses it', async () => {
  reset();
  makeDir('a', 2 * MB);
  assert.equal((await stemCache.usage()).bytes, 2 * MB);
  assert.equal(readSnap().bytes, 2 * MB);
  makeDir('b', 3 * MB); // by hand: invisible until the next full walk
  assert.equal((await stemCache.usage()).bytes, 2 * MB, 'served from the snapshot');
});

test('a day-old snapshot is walked again, which picks up hand-made changes', async () => {
  writeSnap({ bytes: 2 * MB, dirs: 1, measuredAt: new Date(Date.now() - 25 * HOUR).toISOString() });
  const u = await stemCache.usage();
  assert.equal(u.bytes, 5 * MB);
  assert.equal(u.dirs, 2);
});

test('the hourly sweep walks nothing while the snapshot is inside the budget', async () => {
  const r = await stemCache.sweep(100 * MB);
  assert.equal(r.skipped, 'snapshot');
  assert.equal(r.removed, 0);
});

test('a budget below the snapshot walks and evicts, and the snapshot follows', async () => {
  const r = await stemCache.sweep(4 * MB);
  assert.equal(r.skipped, undefined);
  assert.ok(r.removed >= 1);
  assert.ok(readSnap().bytes <= 4 * MB, 'snapshot rewritten from the eviction');
});

test('while another live pass is writing, the hourly sweep leaves the cache to it', async () => {
  // process.ppid is a live process that is not this one.
  writeSnap({ bytes: 3 * MB, dirs: 1, pending: { pid: process.ppid, since: new Date().toISOString() } });
  const r = await stemCache.sweep(1);
  assert.equal(r.skipped, 'pass-running');
  assert.equal(r.removed, 0);
});

test('a pass that died before settling forces a walk', async () => {
  writeSnap({ bytes: 1, dirs: 1, pending: { pid: 2 ** 22 + 12345, since: new Date().toISOString() } });
  const u = await stemCache.usage();
  assert.ok(u.bytes > 1, 'measured from disk, not from the dead pass\'s snapshot');
  assert.equal(readSnap().pending, undefined, 'the walk clears the dead mark');
});

test('a pass: mark pending, then settle adds only its new dirs and clears the mark', async () => {
  reset();
  makeDir('old', 2 * MB);
  await stemCache.usage(); // the pass's headroom read (walks: no snapshot yet)
  await stemCache.markPassPending();
  assert.equal(readSnap().pending.pid, process.pid);
  makeDir('new1', 3 * MB);
  makeDir('new2', 1 * MB);
  const settled = await stemCache.settlePassWrites(['new1', 'new2', 'never-written'], 100 * MB);
  assert.deepEqual(settled, { bytes: 6 * MB, dirs: 3, withinBudget: true });
  const snap = readSnap();
  assert.equal(snap.pending, undefined);
  assert.equal(snap.bytes, 6 * MB);
});

test('settle reports a pass that went over budget (the caller then sweeps with a walk)', async () => {
  await stemCache.markPassPending();
  makeDir('new3', 5 * MB);
  const settled = await stemCache.settlePassWrites(['new3'], 8 * MB);
  assert.equal(settled?.withinBudget, false);
  const r = await stemCache.sweep(8 * MB);
  assert.equal(r.skipped, undefined, 'over budget: walked');
  assert.ok(r.removed >= 1);
});

test('settle without a pending mark of its own changes nothing', async () => {
  writeSnap({ bytes: 7, dirs: 1 });
  assert.equal(await stemCache.settlePassWrites(['x']), null);
  assert.equal(readSnap().bytes, 7);
});

test.after(() => rmSync(stateDir, { recursive: true, force: true }));
