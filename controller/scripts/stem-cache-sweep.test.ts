// Tests for the stem-cache budget enforcement seams (music/stem-cache.ts):
// the LRU sweep's failure/shortfall reporting, the measured per-track size
// estimate, and the per-track write decision the analysis pass gates
// ride-along stems on.
//
// Pins the fixes for discussion #1257 ("stems cache feedback from a power
// user"): a 500 GB budget stood at 674 GB for a week because (1) stems rode
// along with every analysis without ever consulting the budget, and (2) the
// sweep swallowed per-dir delete failures and returned {removed: 0}, which
// both call sites read as "nothing to do" — so a sweep that could not evict
// was indistinguishable from a cache that fit. Neither may regress silently.
//
// Runs against a temp STATE_DIR, so STATE_DIR is set before stem-cache is
// imported (dynamic import below), matching scripts/stem-backfill.test.ts.
// Run: `tsx scripts/stem-cache-sweep.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

const MB = 1024 ** 2;

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stem-sweep-'));
  process.env.STATE_DIR = stateDir;

  const stemCache = await import('../src/music/stem-cache.js');
  const stemsRoot = join(stateDir, 'stems');

  // Dirs made by hand, not by an analysis pass: the usage snapshot only learns
  // about them at its next full walk, so every change here drops it
  // (stem-cache.ts; the snapshot itself is pinned by stem-cache-snapshot.test.ts).
  const forgetSnapshot = () => rmSync(join(stateDir, 'stem-cache-usage.json'), { force: true });
  const resetCache = () => { rmSync(stemsRoot, { recursive: true, force: true }); forgetSnapshot(); };
  // One track dir with a single payload file at a controlled size + mtime.
  // ageSec orders the LRU: bigger = older = evicted first.
  const makeDir = (id: string, bytes: number, ageSec: number) => {
    const dir = stemCache.dirFor(id);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'head-drums.flac');
    writeFileSync(f, Buffer.alloc(bytes));
    const t = (Date.now() - ageSec * 1000) / 1000;
    utimesSync(f, t, t);
    forgetSnapshot();
    return dir;
  };

  console.log('estimateTrackBytes (measured average vs cold-start guess):');

  await test('below MEASURED_MIN_DIRS the fixed guess wins', () => {
    // A handful of dirs is not a sample — a couple of outliers must not
    // swing the backfill sizing.
    assert.equal(stemCache.estimateTrackBytes(0, 0), stemCache.APPROX_TRACK_BYTES);
    assert.equal(
      stemCache.estimateTrackBytes(100 * MB, stemCache.MEASURED_MIN_DIRS - 1),
      stemCache.APPROX_TRACK_BYTES,
    );
  });

  await test('at MEASURED_MIN_DIRS the cache’s own average takes over', () => {
    // The #1257 field report: ~13 MB/track over 53k dirs, roughly half the
    // 25 MB guess — the estimate must follow the disk, not the constant.
    const dirs = stemCache.MEASURED_MIN_DIRS;
    assert.equal(stemCache.estimateTrackBytes(dirs * 13 * MB, dirs), 13 * MB);
  });

  await test('the measured average is floored so empty dirs can’t explode headroom', () => {
    // 8 MB mirrors MIN_TRACK_BYTES in stem-cache.ts: a cache polluted by
    // failed/near-empty dirs must not report a tiny per-track cost and size
    // a backfill far past what the budget really holds.
    assert.equal(stemCache.estimateTrackBytes(50 * 1024, 50), 8 * MB);
  });

  console.log('stemWriteDecision (per-track ride-along gate):');

  await test('cache off → never wants stems', () => {
    assert.deepEqual(
      stemCache.stemWriteDecision({ cacheOn: false, slotsLeft: 100, hasExistingDir: false }),
      { want: false, consumesSlot: false },
    );
  });

  await test('a net-new dir spends a slot; exhausted slots refuse it', () => {
    assert.deepEqual(
      stemCache.stemWriteDecision({ cacheOn: true, slotsLeft: 1, hasExistingDir: false }),
      { want: true, consumesSlot: true },
    );
    // This is the #1257 overshoot path: before the gate, a ride-along here
    // wrote a fresh dir no matter what the budget said.
    assert.deepEqual(
      stemCache.stemWriteDecision({ cacheOn: true, slotsLeft: 0, hasExistingDir: false }),
      { want: false, consumesSlot: false },
    );
  });

  await test('a rewrite of an existing dir is free, even at zero slots', () => {
    // Re-analysis rewrites in place — no net-new bytes, so blocking it would
    // just lose stems the separation already paid for.
    assert.deepEqual(
      stemCache.stemWriteDecision({ cacheOn: true, slotsLeft: 0, hasExistingDir: true }),
      { want: true, consumesSlot: false },
    );
  });

  console.log('sweep (LRU eviction + shortfall reporting):');

  await test('evicts oldest-first down to the budget and reports a clean bill', async () => {
    resetCache();
    makeDir('old', 10 * MB, 3000);
    makeDir('mid', 10 * MB, 2000);
    makeDir('new', 10 * MB, 1000);
    // Budget fits two dirs — only the oldest should go.
    const res = await stemCache.sweep(25 * MB);
    assert.equal(res.removed, 1);
    assert.equal(res.freedBytes, 10 * MB);
    assert.equal(res.failedDirs, 0);
    assert.equal(res.overBudgetBytes, 0);
    assert.deepEqual([...(await stemCache.cachedTrackIdSet())].sort(), ['mid', 'new']);
  });

  await test('a cache inside its budget is a no-op', async () => {
    const res = await stemCache.sweep(25 * MB);
    // The previous sweep's walk left a usage snapshot inside this budget, so
    // nothing is walked either.
    assert.deepEqual(res, { removed: 0, freedBytes: 0, failedDirs: 0, overBudgetBytes: 0, skipped: 'snapshot' });
  });

  await test('failed deletes are counted and the shortfall reported, not swallowed', async () => {
    // Root ignores directory permissions, so this scenario can't be staged
    // under it (CI containers sometimes run as root) — the pure accounting
    // above still runs everywhere.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('    (skipped: running as root, rm cannot be made to fail via permissions)');
      return;
    }
    resetCache();
    makeDir('stuck-a', 10 * MB, 3000);
    makeDir('stuck-b', 10 * MB, 2000);
    // Read-only stems root: rm of any child dir now fails — the shape of a
    // relocated stems mount the controller container can't delete under.
    chmodSync(stemsRoot, 0o555);
    try {
      const res = await stemCache.sweep(5 * MB);
      assert.equal(res.removed, 0, 'nothing could actually be deleted');
      assert.equal(res.failedDirs, 2, 'every attempted delete failed');
      assert.equal(res.overBudgetBytes, 15 * MB, 'still 15 MB over the 5 MB budget');
    } finally {
      chmodSync(stemsRoot, 0o755);
    }
  });

  console.log('usage + headroom (single-scan accounting):');

  await test('usage reports bytes, dirs and the implied per-track estimate together', async () => {
    resetCache();
    makeDir('u1', 4 * MB, 100);
    makeDir('u2', 6 * MB, 200);
    const u = await stemCache.usage();
    assert.equal(u.bytes, 10 * MB);
    assert.equal(u.dirs, 2);
    // Two dirs is far below MEASURED_MIN_DIRS → the guess, not 5 MB.
    assert.equal(u.estTrackBytes, stemCache.APPROX_TRACK_BYTES);
    assert.equal(await stemCache.usageBytes(), 10 * MB);
    assert.equal(await stemCache.cachedTrackCount(), 2);
  });

  await test('headroom is sized off the measured average once the cache has one', async () => {
    resetCache();
    // 50 dirs x 1 MB → measured average floors at 8 MB (see above), so a
    // 450 MB budget holds (450-50)/8 = 50 more tracks. Under the old fixed
    // 25 MB guess this would have read 16 — the ~2x pessimism from #1257.
    for (let i = 0; i < stemCache.MEASURED_MIN_DIRS; i++) makeDir(`m${i}`, MB, 100 + i);
    assert.equal(await stemCache.headroomTracks(450 * MB), 50);
  });

  await test('a full cache reports zero headroom, never negative', async () => {
    assert.equal(await stemCache.headroomTracks(10 * MB), 0);
  });

  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stem-cache-sweep tests passed');
}

await main();
