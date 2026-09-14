// Tests for the stem-cache backfill scope (library-db needsStemsIds/stems_at)
// and the budget headroom that sizes it (music/stem-cache.ts).
//
// Pins the fix for the Discord report "Is there a way to backfill the stem
// scan?": before this, the analysis pass only widened its scope for missing
// CLAP vectors and missing vocal ranges, so turning the stem cache on for an
// already-analysed library did nothing at all and the only route was a
// --re-analyze that wipes every vector and can't resume across runs.
//
// Scope only — the ORDER the scope comes back in is a ranking since #1622 FR
// 14 and is pinned by scripts/stem-priority.test.ts, so every assertion here
// compares SETS. Resumption never depended on the order anyway: the stems_at
// stamp is what a resumed pass reads, which is exactly what freed the order to
// become a ranking with a random tiebreak.
//
// The load-bearing contract is that stems_at stamps the ATTEMPT, not disk
// presence. The LRU sweep deletes stem dirs by design once the cache outgrows
// its budget, so a presence-based scope would drag every evicted track back in
// on the next pass, forever, on any library bigger than the budget.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR, so STATE_DIR is set
// before library-db is imported (dynamic import below), matching
// scripts/embedding-dim-migrate.test.ts.
// Run: `tsx scripts/stem-backfill.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

let failures = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${name}`))
    .catch((err) => { failures++; console.error(`  ✗ ${name}\n      ${err?.message || err}`); });
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-stems-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const stemCache = await import('../src/music/stem-cache.js');
  await db.open({ embeddingDim: 768, adoptStoredDim: true });

  // Three tracks, none analysed yet.
  for (const id of ['t1', 't2', 't3']) {
    db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
  }

  console.log('stem backfill scope:');

  const scope = () => [...db.needsStemsIds()].sort();

  await test('every track needs stems before any pass has run', () => {
    assert.deepEqual(scope(), ['t1', 't2', 't3']);
    assert.equal(db.stemsCachedCount(), 0);
  });

  await test('an analysis pass WITHOUT the stem cache leaves the scope untouched', () => {
    // This is the exact shape of the bug: bpm/key land, the track counts as
    // analysed, and nothing records a stem attempt — so it must stay in scope.
    db.upsertTrackAnalysis('t1', { bpm: 120, musicalKey: 'Am' });
    assert.deepEqual(scope(), ['t1', 't2', 't3']);
    assert.equal(db.stemsCachedCount(), 0);
  });

  await test('a pass that cached stems drops the track from the scope', () => {
    db.upsertTrackAnalysis('t1', { bpm: 120, musicalKey: 'Am', stemsAttempted: true });
    assert.deepEqual(scope(), ['t2', 't3']);
    assert.equal(db.stemsCachedCount(), 1);
  });

  await test('a MISS is stamped too, so an unstemmable track never churns', () => {
    // The worker reached the stem-writing step and failed for this track
    // (analyze.ts passes stemsAttempted for stemsCached === false as well).
    // Re-targeting it every pass forever is the "275/7093" churn class.
    db.upsertTrackAnalysis('t2', { bpm: 100, stemsAttempted: true });
    assert.deepEqual(scope(), ['t3']);
  });

  await test('a later stem-less pass does not clear an existing stamp', () => {
    // COALESCE, same shape as vocal_ranges_json / outro_json: a pass with the
    // cache off passes null and must keep what an earlier stem pass recorded.
    db.upsertTrackAnalysis('t1', { bpm: 121 });
    assert.deepEqual(scope(), ['t3']);
    assert.equal(db.stemsCachedCount(), 2);
  });

  await test('limit caps the scope for a resumable overnight run', () => {
    db.upsertTrackAnalysis('t3', { bpm: 90, stemsAttempted: true });
    for (const id of ['t4', 't5', 't6']) {
      db.upsertTrackMeta(id, { title: `Song ${id}`, artist: 'A', album: 'B', duration: 200 });
    }
    // Which two is the ranking's business (none of these rows carries a bar
    // grid, so they tie at zero and the draw is random); that a limited run
    // takes exactly two, and that the stamps carry the resumption, is this
    // test's.
    const first = db.needsStemsIds(2);
    assert.equal(first.length, 2);
    for (const id of first) db.upsertTrackAnalysis(id, { bpm: 95, stemsAttempted: true });
    assert.deepEqual(scope().length, 1, 'the next run picks up where it left off');
    assert.deepEqual(db.needsStemsIds(2), scope(), 'and only the one track is left');
  });

  await test('clearAnalysis only resets the stamps when the pass will rewrite stems', () => {
    // A --re-analyze with the cache OFF must not lose the stamps: the pass
    // isn't going to rewrite stems, so clearing would re-separate the whole
    // library the next time the operator turned the cache on.
    db.clearAnalysis({ keepVocal: true });
    assert.equal(scope().length, 1, 'stamps survive a cache-off re-analyse');
    db.clearAnalysis({ keepVocal: true, clearStems: true });
    assert.deepEqual(scope(), ['t1', 't2', 't3', 't4', 't5', 't6']);
    assert.equal(db.stemsCachedCount(), 0);
  });

  console.log('stem cache path containment:');

  await test('dirFor never resolves outside the cache root', () => {
    // path.basename() strips separators but hands back "." / ".." / "" AS IS,
    // and path.join(root, "..") resolves to the PARENT of the cache root — so
    // a degenerate or hostile track id used to point stem writes at
    // <stateDir> itself. Nothing there collides by name (write_stems only ever
    // writes <window>-<stem>.flac + tail-meta.json), so the damage was stray
    // files OUTSIDE scanDirs()' reach: the LRU sweep only walks entries under
    // the root, so they would leak past every eviction, forever.
    const root = stemCache.stemsRoot();
    for (const id of ['..', '.', '', '...', 'a/..', 'x/../..', '/etc/passwd']) {
      const dir = stemCache.dirFor(id);
      assert.ok(dir.startsWith(root + sep), `dirFor(${JSON.stringify(id)}) escaped: ${dir}`);
      assert.ok(
        stemCache.stemPath(id, 'tail', 'vocals').startsWith(root + sep),
        `stemPath(${JSON.stringify(id)}) escaped`,
      );
    }
  });

  await test('a well-formed track id still maps to its own dir', () => {
    // The guard must not rewrite the normal case — a renamed dir would orphan
    // every already-cached stem set and re-separate the whole library.
    const id = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
    assert.equal(stemCache.dirFor(id), join(stemCache.stemsRoot(), id));
    assert.notEqual(stemCache.dirFor('t1'), stemCache.dirFor('t2'));
  });

  console.log('stem cache budget headroom:');

  // headroomTracks() reads settings.audio.stemCacheGb; with no settings.json
  // in the temp state dir it falls back to the 15 GB default.
  await test('an empty cache offers the whole budget', async () => {
    const holds = Math.floor((15 * 1024 ** 3) / stemCache.APPROX_TRACK_BYTES);
    assert.equal(await stemCache.usageBytes(), 0);
    assert.equal(await stemCache.headroomTracks(), holds);
    assert.equal(stemCache.budgetBytes(), 15 * 1024 ** 3);
  });

  await test('cached stems count against the headroom', async () => {
    const dir = stemCache.dirFor('t1');
    mkdirSync(dir, { recursive: true });
    // 4 MB across the four head stems — well under one track's ~25 MB, so the
    // headroom drops by less than a whole track slot.
    for (const s of stemCache.STEM_NAMES) {
      writeFileSync(join(dir, `head-${s}.flac`), Buffer.alloc(1024 ** 2));
    }
    assert.equal(await stemCache.usageBytes(), 4 * 1024 ** 2);
    const expected = Math.floor((15 * 1024 ** 3 - 4 * 1024 ** 2) / stemCache.APPROX_TRACK_BYTES);
    assert.equal(await stemCache.headroomTracks(), expected);
  });

  await test('doctor coverage counts dirs on disk, not attempt stamps', async () => {
    // The two numbers are allowed to disagree — that is the point. Stamps
    // record attempts and survive eviction (the scope must converge); the
    // doctor's coverage must NOT, or the warning goes quiet on exactly the
    // stations where the sweep is evicting everything the backfill writes.
    // Here: t1's dir is on disk but the clearAnalysis above wiped all stamps.
    assert.equal(await stemCache.cachedTrackCount(), 1);
    assert.equal(db.stemsCachedCount(), 0);
  });

  await test('a full cache reports zero headroom rather than a negative slot count', async () => {
    // The backfill stands down at 0. Without the floor, an over-budget cache
    // would produce a negative "room" and slice() would silently return the
    // whole pending list — thousands of Demucs passes the sweep evicts.
    assert.equal(await stemCache.headroomTracks(1), 0);
    const tiny = 1024; // 1 KB budget, cache already holds 4 MB
    const swept = await stemCache.sweep(tiny);
    assert.equal(swept.removed, 1, 'the over-budget dir is evicted');
    assert.equal(await stemCache.usageBytes(), 0);
    assert.equal(await stemCache.cachedTrackCount(), 0, 'eviction drops disk coverage');
  });

  await test('hasWindow needs the tail alignment sidecar, not just four stems', async () => {
    const dir = stemCache.dirFor('t2');
    mkdirSync(dir, { recursive: true });
    for (const s of stemCache.STEM_NAMES) {
      writeFileSync(join(dir, `tail-${s}.flac`), Buffer.alloc(1024));
    }
    assert.equal(await stemCache.hasWindow('t2', 'tail'), false, 'no tail-meta.json → miss');
    writeFileSync(join(dir, 'tail-meta.json'), '{"offset":180}');
    assert.equal(await stemCache.hasWindow('t2', 'tail'), true);
  });

  db.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('\nall stem-backfill tests passed');
}

await main();
