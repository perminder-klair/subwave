// Tests for the stem-cache budget enforcement seams (music/stem-cache.ts):
// the LRU sweep's failure/shortfall reporting, the measured per-track size
// estimate, and the per-track write decision the analysis pass gates
// ride-along stems on. Parallel scan accounting also pins every directory
// and byte exactly once, ignoring stray files at the cache root.
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
// Run: `npm test -- stem-cache-sweep`.

import { createTempDir } from './test-utils/temp-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MB = 1024 ** 2;

async function main() {
  const stateDir = createTempDir(join(tmpdir(), 'subwave-stem-sweep-'));
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

  await test('evicts oldest-first down to the budget and reports a clean bill', async () => {
    resetCache();
    makeDir('old', 10 * MB, 3000);
    makeDir('mid', 10 * MB, 2000);
    makeDir('new', 10 * MB, 1000);
    // No library DB is open in this file. The priority lookup takes its catch
    // fallback, so the sweep must degrade to the original mtime LRU.
    // Budget fits two dirs — only the oldest should go.
    const res = await stemCache.sweep(25 * MB);
    assert.equal(res.removed, 1);
    assert.equal(res.freedBytes, 10 * MB);
    assert.equal(res.failedDirs, 0);
    assert.equal(res.overBudgetBytes, 0);
    assert.deepEqual([...(await stemCache.cachedTrackIdSet())].sort(), ['mid', 'new']);
  });

  await test('a sweep whose walk overlapped another writer stores its figure flagged stale', async () => {
    // The walk is minutes on a share. A purge or forgetStems that adjusted the
    // snapshot meanwhile may or may not be in what the walk counted, so the
    // sweep's figure must not be trusted as is.
    const snapFile = join(stateDir, 'stem-cache-usage.json');
    resetCache();
    for (let i = 0; i < 4; i++) makeDir(`w${i}`, 10 * MB, 4000 - i * 1000);
    await stemCache.usage();   // a stored, trusted measurement
    const measured = readFileSync(snapFile, 'utf8');
    // keepLast is read after the walk, before the snapshot is written: another
    // writer moves the snapshot there.
    class Moving extends Set<string> {
      moved = false;
      override has(v: string) {
        if (!this.moved) {
          this.moved = true;
          const s = JSON.parse(readFileSync(snapFile, 'utf8'));
          writeFileSync(snapFile, JSON.stringify({ ...s, bytes: s.bytes - MB, updatedAt: new Date().toISOString() }));
        }
        return super.has(v);
      }
    }
    const keep = new Moving(['not-cached']);
    await stemCache.sweep(25 * MB, { force: true, keepLast: keep });
    assert.equal(keep.moved, true);
    const after = JSON.parse(readFileSync(snapFile, 'utf8'));
    assert.equal(after.stale, true, 'overlapped: re-measured next read');
    assert.equal(after.bytes, 20 * MB, 'the walk\'s own figure is kept for the budget field');
    // Untouched in between, the sweep's figure is trusted as before.
    writeFileSync(snapFile, measured);
    resetCache();
    for (let i = 0; i < 4; i++) makeDir(`w${i}`, 10 * MB, 4000 - i * 1000);
    await stemCache.usage();
    await stemCache.sweep(25 * MB, { force: true, keepLast: new Set() });
    assert.equal(JSON.parse(readFileSync(snapFile, 'utf8')).stale, undefined);
    resetCache();
  });

  await test('no keep-last set, or an empty one, evicts exactly as before', async () => {
    // What a station with pick-time stems off gets (pick-stems-policy.ts
    // sweepKeepLast returns no set): the same dirs in the same order.
    const evicted = async (opts?: { keepLast?: ReadonlySet<string> }) => {
      resetCache();
      for (let i = 0; i < 6; i++) makeDir(`k${i}`, 10 * MB, 6000 - i * 1000);
      await stemCache.sweep(25 * MB, { force: true, ...opts });
      const left = await stemCache.cachedTrackIdSet();
      return ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'].filter(id => !left.has(id));
    };
    const plain = await evicted();
    assert.deepEqual(plain, ['k0', 'k1', 'k2', 'k3'], 'oldest first');
    assert.deepEqual(await evicted({ keepLast: undefined }), plain);
    assert.deepEqual(await evicted({ keepLast: new Set() }), plain);
    // And a queued track's dir goes after the rest, still down to the budget.
    assert.deepEqual(await evicted({ keepLast: new Set(['k0']) }), ['k1', 'k2', 'k3', 'k4']);
    resetCache();
    makeDir('old', 10 * MB, 3000);
    makeDir('mid', 10 * MB, 2000);
    makeDir('new', 10 * MB, 1000);
    await stemCache.sweep(25 * MB, { force: true });
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

  // A folder an older analyzer left 755 under another uid: this user cannot
  // delete inside it, however often the sweep tries. Staged with 0555, since
  // only root could stage a real foreign owner, and root would ignore the mode.
  const stuckDirs = (dirs: string[]) => {
    for (const d of dirs) chmodSync(d, 0o555);
    return () => { for (const d of dirs) chmodSync(d, 0o755); };
  };
  const skipAsRoot = () => {
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
    console.log('    (skipped: running as root, rm cannot be made to fail via permissions)');
    return true;
  };

  await test('stuck folders over the budget never push the sweep into deleting others', async (t) => {
    if (skipAsRoot()) return;
    const warn = t.mock.method(console, 'warn', () => {});
    resetCache();
    const unstick = stuckDirs([
      makeDir('stuck-a', 10 * MB, 9000),
      makeDir('stuck-b', 10 * MB, 8000),
      makeDir('stuck-c', 10 * MB, 7000),
    ]);
    makeDir('fresh-a', 1 * MB, 300);
    makeDir('fresh-b', 1 * MB, 200);
    makeDir('fresh-c', 1 * MB, 100);
    try {
      const res = await stemCache.sweep(25 * MB);
      assert.equal(res.removed, 0, 'deleting the fresh folders would free nothing the stuck ones hold');
      assert.equal(res.failedDirs, 3);
      assert.equal(res.overBudgetBytes, 8 * MB, 'the report still states the real overage');
      assert.deepEqual(
        [...(await stemCache.cachedTrackIdSet())].sort(),
        ['fresh-a', 'fresh-b', 'fresh-c', 'stuck-a', 'stuck-b', 'stuck-c'],
      );
      assert.equal(warn.mock.callCount(), 1, 'one warning per sweep, naming the count');
      assert.match(String(warn.mock.calls[0].arguments[0]), /3 folder/);
    } finally {
      unstick();
    }
  });

  await test('fresh folders survive even when the eviction order reaches them first', async (t) => {
    // The real catalogue's shape: a new unplayed track ranks below a stuck
    // played one. Finding out only by failing would delete the fresh folders
    // before the sweep had met a single stuck one.
    if (skipAsRoot()) return;
    t.mock.method(console, 'warn', () => {});
    resetCache();
    makeDir('fresh-a', 1 * MB, 9000);
    makeDir('fresh-b', 1 * MB, 8000);
    const unstick = stuckDirs([
      makeDir('stuck-a', 15 * MB, 300),
      makeDir('stuck-b', 15 * MB, 200),
    ]);
    try {
      const res = await stemCache.sweep(25 * MB);
      assert.equal(res.removed, 0);
      assert.equal(res.failedDirs, 2);
      assert.deepEqual(
        [...(await stemCache.cachedTrackIdSet())].sort(),
        ['fresh-a', 'fresh-b', 'stuck-a', 'stuck-b'],
      );
    } finally {
      unstick();
    }
  });

  await test('pick-time stems: stuck folders no longer keep the cache full for good (#2253)', async (t) => {
    // The verifier's probe on #2250: 32 of 64 dirs undeletable, sweeps that
    // remove nothing, and budgetVeto turning every pick away for good, because
    // it counted bytes the sweep had already left out of its own check. Sparse
    // files give the 1 GB budget floor its real scale without writing a GB.
    if (skipAsRoot()) return;
    t.mock.method(console, 'warn', () => {});
    const policy = await import('../src/broadcast/pick-stems-policy.js');
    const GB = 1024 ** 3;
    const budget = 1 * GB;
    const dirBytes = 32 * MB;
    const snapshotFile = join(stateDir, 'stem-cache-usage.json');
    const readSnap = () => JSON.parse(readFileSync(snapshotFile, 'utf8'));
    const sparseDir = (id: string, ageSec: number) => {
      const dir = stemCache.dirFor(id);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, 'head-drums.flac');
      writeFileSync(f, '');
      truncateSync(f, dirBytes);
      const ts = (Date.now() - ageSec * 1000) / 1000;
      utimesSync(f, ts, ts);
      return dir;
    };
    const veto = async () => {
      const u = await stemCache.usage();
      return policy.budgetVeto({
        usedBytes: u.bytes, budgetBytes: budget, estTrackBytes: u.estTrackBytes, unevictableBytes: u.unevictableBytes,
      });
    };
    // One pick-time separation, settled the way pick-stems.ts settles it.
    const pickTimeWrite = async (id: string) => {
      const before = await stemCache.trackDirBytes(id);
      sparseDir(id, 0);
      await stemCache.settleTrackWrite(id, before);
    };

    resetCache();
    const stuck: string[] = [];
    for (let i = 0; i < 64; i++) {
      const dir = sparseDir(`t${i}`, (i + 1) * 3600);
      if (i % 2 === 0) stuck.push(dir);
    }
    forgetSnapshot();
    const unstick = stuckDirs(stuck);
    try {
      for (let s = 0; s < 2; s++) {
        const res = await stemCache.sweep(budget);
        assert.deepEqual(
          { removed: res.removed, failedDirs: res.failedDirs, overBudgetBytes: res.overBudgetBytes },
          { removed: 0, failedDirs: 32, overBudgetBytes: 1 * GB },
          'what can go already fits; the stuck GB is reported, never chased',
        );
      }
      assert.equal(readSnap().unevictableBytes, 32 * dirBytes, 'the sweep records what it cannot delete');
      const u = await stemCache.usage();
      assert.equal(u.bytes, 2 * GB, 'the total still counts the stuck folders (overage, headroom)');
      assert.equal(u.unevictableBytes, 1 * GB);
      assert.equal(
        policy.budgetVeto({ usedBytes: u.bytes, budgetBytes: budget, estTrackBytes: u.estTrackBytes, unevictableBytes: 0 }),
        'budget-full',
        'the old rule: every pick turned away until someone opens the folders',
      );
      assert.equal(await veto(), null, 'judged on the evictable part, a pick is admitted');

      // Picks run the cache past the allowance, then the sweep makes room, as
      // the booth-log notice promises.
      let admitted = 0;
      for (let pick = 0; pick < 10 && (await veto()) === null; pick++) {
        await pickTimeWrite(`pick-${pick}`);
        admitted += 1;
      }
      assert.ok(admitted >= 1 && admitted < 10, `${admitted} picks, then the allowance binds`);
      assert.equal(await veto(), 'budget-full');
      assert.equal(readSnap().unevictableBytes, 1 * GB, 'a pick-time settle keeps the figure');
      const res = await stemCache.sweep(budget);
      assert.equal(res.removed, admitted, 'the sweep evicts back down to the budget');
      assert.equal(res.failedDirs, 32);
      assert.equal(await veto(), null, 'and pick-time stems runs again');
    } finally {
      unstick();
    }
  });

  await test('the stuck figure rides every writer that keeps the totals, and a walk drops it', async (t) => {
    if (skipAsRoot()) return;
    t.mock.method(console, 'warn', () => {});
    resetCache();
    const snapshotFile = join(stateDir, 'stem-cache-usage.json');
    const readSnap = () => JSON.parse(readFileSync(snapshotFile, 'utf8'));
    const unstick = stuckDirs([makeDir('stuck-a', 10 * MB, 9000), makeDir('stuck-b', 10 * MB, 8000)]);
    makeDir('fresh-a', 1 * MB, 100);
    try {
      await stemCache.sweep(15 * MB);
      assert.equal(readSnap().unevictableBytes, 20 * MB);
      // An analysis pass: pending, then settled with a new dir.
      assert.equal(await stemCache.markPassPending(), true);
      assert.equal(readSnap().unevictableBytes, 20 * MB, 'markPassPending');
      // Written as the pass writes it: makeDir would drop the snapshot.
      mkdirSync(stemCache.dirFor('pass-new'), { recursive: true });
      writeFileSync(join(stemCache.dirFor('pass-new'), 'head-drums.flac'), Buffer.alloc(1 * MB));
      const settled = await stemCache.settlePassWrites(['pass-new'], 15 * MB);
      assert.ok(settled, 'the pass settles additively');
      assert.equal(readSnap().unevictableBytes, 20 * MB, 'settlePassWrites');
      assert.equal((await stemCache.usage()).unevictableBytes, 20 * MB, 'served from the snapshot');
      // forgetStems, the orphan purge: stale, figure kept beside the totals.
      await stemCache.markUsageStale();
      assert.equal(readSnap().stale, true);
      assert.equal(readSnap().unevictableBytes, 20 * MB, 'markUsageStale');
      // The next read walks, and a walk does not probe: unknown, the old rule.
      const walked = await stemCache.usage();
      assert.equal(walked.unevictableBytes, 0);
      assert.equal(readSnap().unevictableBytes, undefined, 'a walk drops it');
      // Under budget, the sweep records none.
      await stemCache.sweep(1000 * MB, { force: true });
      assert.equal(readSnap().unevictableBytes, undefined);
    } finally {
      unstick();
    }
  });

  await test('a stuck folder leaves eviction working for everything else', async (t) => {
    // Out of the budget check, not an off switch: what can go still has to fit.
    if (skipAsRoot()) return;
    t.mock.method(console, 'warn', () => {});
    resetCache();
    const unstick = stuckDirs([makeDir('stuck', 10 * MB, 9000)]);
    makeDir('old', 10 * MB, 3000);
    makeDir('mid', 10 * MB, 2000);
    makeDir('new', 10 * MB, 1000);
    try {
      const res = await stemCache.sweep(25 * MB);
      assert.equal(res.removed, 1);
      assert.equal(res.failedDirs, 1);
      assert.equal(res.overBudgetBytes, 5 * MB);
      assert.deepEqual([...(await stemCache.cachedTrackIdSet())].sort(), ['mid', 'new', 'stuck']);
    } finally {
      unstick();
    }
  });

  await test('a delete refused after the probe passed leaves the budget check only once it fails', async (t) => {
    // The catch the probe can't replace (#2225): a share that answers access()
    // and then refuses the delete. The sweep learns of it only by failing, so
    // the folders ranked before it are gone already, and the warning must not
    // say otherwise. Staged with a 0755 folder holding a 0555 subfolder: the
    // probe sees a folder it can write, rm -r is refused inside it.
    if (skipAsRoot()) return;
    const warn = t.mock.method(console, 'warn', () => {});
    resetCache();
    makeDir('old-a', 2 * MB, 9000);
    makeDir('old-b', 2 * MB, 8000);
    const refused = makeDir('refused', 10 * MB, 7000);
    makeDir('new', 20 * MB, 100);
    // Backdated, or the subfolder's own mtime would rank the folder newest.
    const locked = join(refused, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'x'), 'x');
    const ts = (Date.now() - 7000 * 1000) / 1000;
    utimesSync(join(locked, 'x'), ts, ts);
    utimesSync(locked, ts, ts);
    chmodSync(locked, 0o555);
    forgetSnapshot();
    try {
      const res = await stemCache.sweep(25 * MB);
      assert.equal(res.failedDirs, 1);
      assert.equal(res.removed, 2, 'the folders ranked before it went in its place');
      assert.deepEqual(
        [...(await stemCache.cachedTrackIdSet())].sort(),
        ['new', 'refused'],
        'once it failed, its bytes left the check: the newest folder survives',
      );
      assert.equal(warn.mock.callCount(), 1);
      const msg = String(warn.mock.calls[0].arguments[0]);
      assert.match(msg, /1 folder/);
      assert.doesNotMatch(msg, /nothing is evicted/, 'the warning makes no claim the catch path breaks');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  await test('an over-budget sweep never touches the orphan quarantine, nor counts it', async () => {
    // .orphan-quarantine is a dot-dir of whole track dirs (orphan-purge.ts):
    // measured as a cache dir it weighed a few KB, ranked first (no library
    // row) and went in one rm -rf, grace and release skipped, and the sweep
    // then went on evicting live dirs it no longer needed to free.
    resetCache();
    makeDir('live-a', 10 * MB, 3000);
    makeDir('live-b', 10 * MB, 2000);
    const qu = join(stemCache.stemsRoot(), '.orphan-quarantine');
    for (const id of ['gone-1', 'gone-2']) {
      mkdirSync(join(qu, id), { recursive: true });
      writeFileSync(join(qu, id, 'tail-drums.flac'), Buffer.alloc(5 * MB));
    }
    const before = await stemCache.usage();
    assert.equal(before.dirs, 2, 'the quarantine is not a cache dir');
    assert.equal(before.bytes, 20 * MB, 'nor are its bytes the budget\'s');
    assert.deepEqual([...(await stemCache.cachedTrackIdSet())].sort(), ['live-a', 'live-b']);
    forgetSnapshot();
    const res = await stemCache.sweep(15 * MB);
    assert.equal(res.removed, 1, 'one live dir brings it under budget');
    assert.deepEqual([...(await stemCache.cachedTrackIdSet())], ['live-b']);
    for (const id of ['gone-1', 'gone-2']) {
      assert.ok(existsSync(join(qu, id, 'tail-drums.flac')), `${id} survived the sweep`);
    }
  });

  await test('usage reports bytes, dirs and the implied per-track estimate together', async () => {
    resetCache();
    makeDir('u1', 4 * MB, 100);
    makeDir('u2', 6 * MB, 200);
    const u = await stemCache.usage();
    assert.equal(u.bytes, 10 * MB);
    assert.equal(u.dirs, 2);
    // Two dirs is far below MEASURED_MIN_DIRS → the guess, not 5 MB.
    assert.equal(u.estTrackBytes, stemCache.APPROX_TRACK_BYTES);
  });

  await test('headroom is sized off the measured average once the cache has one', async () => {
    resetCache();
    // 50 dirs x 1 MB → measured average floors at 8 MB (see above), so a
    // 450 MB budget holds (450-50)/8 = 50 more tracks. Under the old fixed
    // 25 MB guess this would have read 16 — the ~2x pessimism from #1257.
    for (let i = 0; i < stemCache.MEASURED_MIN_DIRS; i++) makeDir(`m${i}`, MB, 100 + i);
    assert.equal(await stemCache.headroomTracks(450 * MB), 50);
  });

  await test('a walk wider than the fan-out counts every dir and every byte once', async () => {
    resetCache();
    const n = stemCache.SCAN_CONCURRENCY * 7 + 3;
    let expected = 0;
    for (let i = 0; i < n; i++) {
      const dir = stemCache.dirFor(`t${i}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 3; f++) {
        const size = 100 + i * 3 + f;
        writeFileSync(join(dir, `head-${f}.flac`), Buffer.alloc(size));
        expected += size;
      }
    }
    writeFileSync(join(stemCache.stemsRoot(), 'stray.txt'), 'not a track dir');
    const u = await stemCache.usage();
    assert.equal(u.dirs, n);
    assert.equal(u.bytes, expected);
  });
}

await main();
