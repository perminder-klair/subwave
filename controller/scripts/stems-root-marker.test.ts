// Tests for the stems share marker (music/stem-cache.ts stemsRootStatus):
// an unmounted stems share must never read as an empty cache. Without the
// marker, the analysis pass saw an empty mount point, re-separated the whole
// budget onto the local disk and stamped those tracks as attempted; the sweep
// and the doctor read the same emptiness as "nothing cached".
//
// Runs against a temp STATE_DIR, set before stem-cache is imported (dynamic
// import below), matching scripts/stem-cache-sweep.test.ts. The library DB is
// opened last, for the one case that needs stamped stems (the unmounted share).
// Run: `tsx scripts/stems-root-marker.test.ts` (auto-discovered by npm test).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stems-marker-'));
  process.env.STATE_DIR = stateDir;
  const stemCache = await import('../src/music/stem-cache.js');
  const root = join(stateDir, 'stems');
  const marker = join(root, stemCache.STEMS_MARKER);
  const reset = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(join(stateDir, 'stem-cache-usage.json'), { force: true });
  };

  console.log('stemsRootDecision');
  const d = stemCache.stemsRootDecision;
  await test('marker present: ok', () => {
    assert.equal(d({ markerPresent: true, stemDirs: 0, stampedTracks: 500, prepare: false }), 'ok');
  });
  await test('no marker, track dirs on disk: adopt the existing cache', () => {
    assert.equal(d({ markerPresent: false, stemDirs: 12, stampedTracks: 500, prepare: false }), 'adopt');
  });
  await test('no marker, empty root, stems stamped in the library: offline (unmounted share)', () => {
    assert.equal(d({ markerPresent: false, stemDirs: 0, stampedTracks: 500, prepare: true }), 'offline');
    assert.equal(d({ markerPresent: false, stemDirs: 0, stampedTracks: 1, prepare: false }), 'offline');
  });
  await test('nothing anywhere: create only when about to write', () => {
    assert.equal(d({ markerPresent: false, stemDirs: 0, stampedTracks: 0, prepare: true }), 'create');
    assert.equal(d({ markerPresent: false, stemDirs: 0, stampedTracks: 0, prepare: false }), 'none');
  });

  console.log('stemsRootStatus');
  await test('fresh install, prepare: creates the root and the marker', async () => {
    reset();
    const st = await stemCache.stemsRootStatus({ prepare: true });
    assert.equal(st.online, true);
    assert.equal(st.action, 'create');
    assert.ok(existsSync(marker));
  });
  await test('fresh install, no prepare (hourly sweep): touches nothing', async () => {
    reset();
    const st = await stemCache.stemsRootStatus();
    assert.equal(st.online, false);
    assert.equal(st.action, 'none');
    assert.equal(st.message, undefined);
    assert.ok(!existsSync(root));
  });
  await test('analysis preparation adopts an existing cache without a marker', async () => {
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    const st = await stemCache.stemsRootStatus({ prepare: true });
    assert.equal(st.online, true);
    assert.equal(st.action, 'adopt');
    assert.ok(existsSync(marker));
  });
  await test('existing cache on a root that refuses the marker stays online', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('    (skipped: running as root, the root cannot be made read-only)');
      return;
    }
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    chmodSync(root, 0o555);
    try {
      const st = await stemCache.stemsRootStatus({ prepare: true });
      assert.equal(st.online, true);
      assert.equal(st.action, 'adopt');
      assert.match(st.message ?? '', /could not write/, 'the failure is reported, not silent');
      assert.ok(!existsSync(marker));
    } finally {
      chmodSync(root, 0o755);
    }
  });
  await test('readOnly reports adopt without writing the marker', async () => {
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    const st = await stemCache.stemsRootStatus({ readOnly: true });
    assert.equal(st.action, 'adopt');
    assert.ok(!existsSync(marker));
  });
  await test('marker present: ok, one stat', async () => {
    reset();
    mkdirSync(root, { recursive: true });
    writeFileSync(marker, '{}\n');
    const st = await stemCache.stemsRootStatus({ prepare: true });
    assert.deepEqual(st, { online: true, action: 'ok' });
  });
  await test('the marker is not a track id', async () => {
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    writeFileSync(marker, '{}\n');
    assert.deepEqual([...await stemCache.cachedTrackIdSet()], ['track-1']);
  });

  console.log('sweep');
  await test('no root: sweep is a quiet no-op', async () => {
    reset();
    const r = await stemCache.sweep(1);
    assert.equal(r.removed, 0);
    assert.equal(r.offline, undefined);
  });
  await test('marked cache over budget: sweep still evicts', async () => {
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    writeFileSync(join(root, 'track-1', 'head-drums.flac'), Buffer.alloc(4096));
    writeFileSync(marker, '{}\n');
    const r = await stemCache.sweep(1);
    assert.equal(r.removed, 1);
    assert.ok(existsSync(marker), 'the sweep never removes the marker');
  });
  await test('legacy cache sweep evicts without creating a marker', async () => {
    reset();
    mkdirSync(join(root, 'track-1'), { recursive: true });
    writeFileSync(join(root, 'track-1', 'head-drums.flac'), Buffer.alloc(4096));
    const r = await stemCache.sweep(1);
    assert.equal(r.removed, 1);
    assert.equal(r.freedBytes, 4096);
    assert.equal(r.overBudgetBytes, 0);
    assert.ok(!existsSync(marker), 'hourly maintenance must not authorize stem writes');
  });

  console.log('unmounted share (library DB open, stems stamped)');
  const db = await import('../src/music/library-db.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });
  db.upsertTrackMeta('t1', { title: 'Song', artist: 'A', album: 'B', duration: 200 });
  db.upsertTrackAnalysis('t1', { bpm: 120, stemsAttempted: true });
  await test('a README does not turn an offline root into an existing cache', async () => {
    reset();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README'), 'Stem mountpoint\n');
    assert.equal((await stemCache.stemsRootStatus({ readOnly: true })).action, 'offline');
    const st = await stemCache.stemsRootStatus({ prepare: true });
    assert.equal(st.online, false);
    assert.equal(st.action, 'offline');
    assert.ok(!existsSync(marker));
  });
  await test('empty root with stamped stems: offline, nothing written', async () => {
    reset();
    mkdirSync(root, { recursive: true }); // the bare mount point
    const st = await stemCache.stemsRootStatus({ prepare: true });
    assert.equal(st.online, false);
    assert.equal(st.action, 'offline');
    assert.match(st.message ?? '', /not mounted/);
    assert.ok(!existsSync(marker), 'the marker is never written on an offline root');
  });
  await test('offline: the sweep does nothing and says why', async () => {
    const r = await stemCache.sweep(1);
    assert.equal(r.removed, 0);
    assert.match(r.offline ?? '', /\.subwave-stems/);
  });
  await test('mount comes back (marker present): online again', async () => {
    writeFileSync(marker, '{}\n');
    assert.equal((await stemCache.stemsRootStatus({ prepare: true })).online, true);
  });
  db.close?.();

  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} stems-root-marker test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stems-root-marker tests passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
