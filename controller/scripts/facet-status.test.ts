// Tests for track_facet_status — the per-facet analysis status that shadows
// the analysis columns on `tracks` (library-db/facets.ts).
//
// The contracts pinned here:
//   - the table is created OUTSIDE the user_version chain and seeded from the
//     columns on the first open that lacks it; a second open changes nothing;
//   - every analysis write (success, failure, CLAP-only, clear, re-analyze)
//     leaves the table equal to what deriveFacetRows() makes of the columns;
//   - each facet's "needs work" set equals the legacy scope query it will
//     replace (checkFacets compares them), including the failure limit;
//   - a capped download records the tail as unmeasurable with its reason, and a
//     tail kept by COALESCE keeps the version it was measured at;
//   - a facet version bump SETTLES: a pass that still cannot measure the tail
//     records that at the new version instead of leaving the track due forever;
//   - a change to ANALYSIS_VERSION or FACET_VERSIONS re-derives the stored rows
//     on the next open (track_facet_meta), with no write needed to trigger it.
//
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR (set before
// library-db is imported), same shape as analysis-failure.test.ts.
// Run: `tsx scripts/facet-status.test.ts` (folded into `npm run test`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const stateDir = mkdtempSync(join(tmpdir(), 'subwave-facets-'));
  process.env.STATE_DIR = stateDir;

  const db = await import('../src/music/library-db.js');
  const { checkFacets } = await import('../src/music/facet-check.js');
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  // Always the live handle: the test closes and reopens the DB.
  const sql = { prepare: (q: string) => db.requireDb().prepare(q), exec: (q: string) => db.requireDb().exec(q) };

  type Row = { facet: string; status: string; version: number; reason: string | null; attempts: number; source: string | null };
  const rows = (id: string): Record<string, Row> => Object.fromEntries(
    (sql.prepare('SELECT facet, status, version, reason, attempts, source FROM track_facet_status WHERE track_id = ?')
      .all(id) as Row[]).map((r) => [r.facet, r]),
  );
  const brief = (id: string) => Object.fromEntries(
    Object.values(rows(id)).map((r) => [r.facet, r.status === 'failed' ? `failed×${r.attempts}` : r.status]),
  );
  const assertConsistent = () => {
    const r = checkFacets();
    assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans, scopes: r.scopes.filter(s => s.onlyFacetCount || s.onlyLegacyCount) }));
  };
  const clap = () => new Float32Array(db.AUDIO_EMBEDDING_DIM).fill(0.1);

  // ---- a library analysed BEFORE the table existed ---------------------------
  for (const id of ['full', 'capped', 'headonly', 'old', 'failed', 'fresh']) {
    db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 240 });
  }
  db.upsertTrackAnalysis('full', {
    bpm: 120, musicalKey: 'Am', loudnessLufs: -10, peakDb: -1,
    outro: { startMs: 230_000, ending: 'fade', vocalRanges: [] } as never,
    tailSilenceMs: 2_000, tailStartMs: 238_000, vocalRanges: [{ startMs: 1000, endMs: 9000 }] as never,
    stemsAttempted: true,
  });
  db.upsertTrackAudioVector('full', clap());
  // Capped download: head + loudness, no tail.
  db.upsertTrackAnalysis('capped', { bpm: 98, musicalKey: 'C', loudnessLufs: -12 });
  // Vocal ranges from before tail vocal detection: outro without vocalRanges.
  db.upsertTrackAnalysis('headonly', {
    bpm: 100, musicalKey: 'D', loudnessLufs: -9,
    outro: { startMs: 200_000, ending: 'cold' } as never, tailSilenceMs: 0, tailStartMs: 240_000,
    vocalRanges: [] as never,
  });
  // Analysed by an older ANALYSIS_VERSION.
  db.upsertTrackAnalysis('old', { bpm: 90, musicalKey: 'E' });
  sql.prepare('UPDATE tracks SET analysis_version = ? WHERE id = ?').run(db.ANALYSIS_VERSION - 1, 'old');
  db.recordAnalysisFailure('failed', 'decode failed');
  db.recordAnalysisFailure('failed', 'decode failed');

  // Simulate the upgrade: drop the table, reopen, let the seed rebuild it.
  const userVersion = db.requireDb().pragma('user_version', { simple: true });
  sql.exec('DROP TABLE track_facet_status');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  const d = { prepare: (q: string) => db.requireDb().prepare(q), pragma: (q: string, o?: { simple: boolean }) => db.requireDb().pragma(q, o) };

  console.log('seed from existing columns:');

  await test('the table is created outside the user_version chain', () => {
    assert.equal(d.pragma('user_version', { simple: true }), userVersion, 'seeding must not move user_version');
    assert.ok(d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'track_facet_status'`).get());
  });

  await test('a fully analysed track seeds ok on every facet', () => {
    const r = db.requireDb().prepare('SELECT facet, status, source FROM track_facet_status WHERE track_id = ?').all('full') as Row[];
    assert.equal(r.length, 6);
    assert.ok(r.every((x) => x.status === 'ok' && x.source === 'seed'), JSON.stringify(r));
  });

  await test('a capped track seeds its tail as unmeasurable — the rows a tail bump will re-target', () => {
    const r = Object.fromEntries((db.requireDb().prepare(
      'SELECT facet, status, reason FROM track_facet_status WHERE track_id = ?').all('capped') as Row[])
      .map((x) => [x.facet, `${x.status}${x.reason ? ':' + x.reason : ''}`]));
    assert.deepEqual(r, { head: 'ok', loudness: 'ok', tail: 'unmeasurable:tail-not-measured' });
  });

  await test('head-only vocal ranges seed one version below current', () => {
    const v = (db.requireDb().prepare(
      `SELECT version, reason FROM track_facet_status WHERE track_id = 'headonly' AND facet = 'vocal'`).get() as Row);
    assert.equal(v.version, db.FACET_VERSIONS.vocal - 1);
    assert.equal(v.reason, 'head-only');
    assert.ok(db.facetNeedsIds('vocal').includes('headonly'));
  });

  await test('an older analysis_version and an un-analysed track have no head row', () => {
    const has = (id: string) => !!db.requireDb().prepare(
      `SELECT 1 FROM track_facet_status WHERE track_id = ? AND facet = 'head'`).get(id);
    assert.equal(has('old'), false);
    assert.equal(has('fresh'), false);
    assert.ok(db.facetNeedsIds('head').includes('old'));
  });

  await test('a failed track carries its attempts on every facet', () => {
    const r = db.requireDb().prepare(
      'SELECT facet, status, attempts, reason FROM track_facet_status WHERE track_id = ?').all('failed') as Row[];
    assert.equal(r.length, 6);
    assert.ok(r.every((x) => x.status === 'failed' && x.attempts === 2 && x.reason === 'decode failed'));
  });

  await test('seeded table matches the columns and every legacy scope', assertConsistent);

  await test('reopening does not re-seed or change anything', async () => {
    const before = JSON.stringify(db.requireDb().prepare('SELECT * FROM track_facet_status ORDER BY track_id, facet').all());
    db.close();
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    const after = JSON.stringify(db.requireDb().prepare('SELECT * FROM track_facet_status ORDER BY track_id, facet').all());
    assert.equal(after, before);
  });

  await test('the seed records the versions it derived under', () => {
    const m = db.requireDb().prepare('SELECT stamp FROM track_facet_meta WHERE pk = 1').get() as { stamp: string };
    assert.equal(m?.stamp, db.facetDerivationStamp());
  });

  await test('orphan rows are cleaned when the table is re-derived, not on every open', async () => {
    db.requireDb().prepare(
      `INSERT INTO track_facet_status (track_id, facet, version, status, at) VALUES ('ghost', 'head', 1, 'ok', 'x')`).run();
    db.close();
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    // Unchanged versions: an open is a single meta read, no table scan.
    assert.ok(db.requireDb().prepare(`SELECT 1 FROM track_facet_status WHERE track_id = 'ghost'`).get());
    // A missing stamp (a table from before the meta row) re-derives once.
    db.requireDb().prepare('DELETE FROM track_facet_meta').run();
    db.close();
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    assert.equal(db.requireDb().prepare(`SELECT 1 FROM track_facet_status WHERE track_id = 'ghost'`).get(), undefined);
    assertConsistent();
  });

  console.log('live writes:');

  await test('a capped pass records why the tail is missing', () => {
    db.upsertTrackAnalysis('fresh', { bpm: 128, musicalKey: 'F', loudnessLufs: -8, source: 'capped' });
    const r = rows('fresh');
    assert.equal(r.tail.status, 'unmeasurable');
    assert.equal(r.tail.reason, 'capped-download');
    assert.equal(r.head.source, 'capped');
    assertConsistent();
  });

  await test('a later write that does not re-measure the tail keeps its reason', () => {
    // The CLAP write re-syncs every facet of the track; the tail's
    // 'capped-download' must survive it (the planner filters on reasons).
    db.upsertTrackAudioVector('fresh', clap());
    assert.equal(rows('fresh').tail.reason, 'capped-download');
    assertConsistent();
  });

  await test('a later full pass turns the tail ok at the current version', () => {
    db.upsertTrackAnalysis('fresh', {
      bpm: 128, musicalKey: 'F', loudnessLufs: -8, source: 'full',
      outro: { startMs: 220_000, ending: 'cold' } as never, tailSilenceMs: 500, tailStartMs: 239_500,
    });
    const r = rows('fresh');
    assert.equal(r.tail.status, 'ok');
    assert.equal(r.tail.version, db.FACET_VERSIONS.tail);
    assert.equal(r.tail.source, 'full');
  });

  await test('a tail kept by COALESCE keeps the version it was measured at', () => {
    // Pretend this tail was measured by an older tail version.
    d.prepare(`UPDATE track_facet_status SET version = 0 WHERE track_id = 'fresh' AND facet = 'tail'`).run();
    db.upsertTrackAnalysis('fresh', { bpm: 128, musicalKey: 'F', loudnessLufs: -8, source: 'capped' });
    assert.equal(rows('fresh').tail.version, 0, 'a capped re-pass must not promote the old tail');
    assert.ok(db.facetNeedsIds('tail').includes('fresh'));
    db.upsertTrackAnalysis('fresh', {
      bpm: 128, musicalKey: 'F', source: 'full',
      outro: { startMs: 220_000, ending: 'cold' } as never, tailSilenceMs: 500, tailStartMs: 239_500,
    });
    assert.equal(rows('fresh').tail.version, db.FACET_VERSIONS.tail);
  });

  await test('a tail version bump settles for a track whose tail is still unmeasurable', () => {
    db.upsertTrackMeta('notail', { title: 'notail', artist: 'A', album: 'B', duration: 240 });
    db.upsertTrackAnalysis('notail', { bpm: 110, musicalKey: 'G', loudnessLufs: -11, source: 'full' });
    assert.equal(rows('notail').tail.status, 'unmeasurable');
    // Simulate FACET_VERSIONS.tail being bumped past the stored row.
    d.prepare(`UPDATE track_facet_status SET version = ? WHERE track_id = 'notail' AND facet = 'tail'`)
      .run(db.FACET_VERSIONS.tail - 1);
    assert.ok(db.facetNeedsIds('tail').includes('notail'));
    // The retry still cannot measure the tail: that answer is the new version's.
    db.upsertTrackAnalysis('notail', { bpm: 110, musicalKey: 'G', loudnessLufs: -11, source: 'full' });
    const t = rows('notail').tail;
    assert.deepEqual([t.status, t.version, t.reason, t.source],
      ['unmeasurable', db.FACET_VERSIONS.tail, 'tail-not-measured', 'full']);
    assert.ok(!db.facetNeedsIds('tail').includes('notail'), 'a settled tail must leave the needs scope');
    // Same for a capped retry: terminal, with the capped reason.
    d.prepare(`UPDATE track_facet_status SET version = ? WHERE track_id = 'notail' AND facet = 'tail'`)
      .run(db.FACET_VERSIONS.tail - 1);
    db.upsertTrackAnalysis('notail', { bpm: 110, musicalKey: 'G', loudnessLufs: -11, source: 'capped' });
    assert.deepEqual([rows('notail').tail.version, rows('notail').tail.reason], [db.FACET_VERSIONS.tail, 'capped-download']);
    assertConsistent();
  });

  await test('a changed ANALYSIS_VERSION re-derives the table on open, with no write', async () => {
    // 'fresh' is analysed at the current version with an ok head and tail.
    assert.equal(rows('fresh').head.status, 'ok');
    // Simulate a code bump: the track's stamp is now stale, and the table was
    // last derived under different versions.
    d.prepare('UPDATE tracks SET analysis_version = ? WHERE id = ?').run(db.ANALYSIS_VERSION - 1, 'fresh');
    d.prepare(`UPDATE track_facet_meta SET stamp = '{"analysis":0}'`).run();
    db.close();
    await db.open({ embeddingDim: 8, adoptStoredDim: true });
    assert.equal(rows('fresh').head, undefined, 'a stale head must lose its ok row');
    assert.ok(db.facetNeedsIds('head').includes('fresh'));
    assert.equal(rows('fresh').tail.status, 'ok', 'columns still hold the tail');
    const m = db.requireDb().prepare('SELECT stamp FROM track_facet_meta WHERE pk = 1').get() as { stamp: string };
    assert.equal(m.stamp, db.facetDerivationStamp());
    assertConsistent();
    // Put it back for the tests below.
    db.upsertTrackAnalysis('fresh', {
      bpm: 128, musicalKey: 'F', source: 'full',
      outro: { startMs: 220_000, ending: 'cold' } as never, tailSilenceMs: 500, tailStartMs: 239_500,
    });
  });

  await test('a CLAP-only write marks the clap facet', () => {
    db.upsertTrackMeta('clapless', { title: 'c', artist: 'A', album: 'B', duration: 100 });
    assert.ok(db.facetNeedsIds('clap').includes('clapless'));
    db.upsertTrackAudioVector('clapless', clap());
    assert.equal(rows('clapless').clap.status, 'ok');
    assert.ok(!db.facetNeedsIds('clap').includes('clapless'));
    assertConsistent();
  });

  await test('failures count per facet and leave scope at the limit, like the legacy count', () => {
    db.upsertTrackMeta('bad', { title: 'bad', artist: 'A', album: 'B', duration: 100 });
    for (let i = 0; i < db.MAX_ANALYSIS_FAILURES; i++) db.recordAnalysisFailure('bad', 'not audio');
    assert.equal(brief('bad').head, `failed×${db.MAX_ANALYSIS_FAILURES}`);
    assert.equal(rows('bad').head.source, null, "'seed' is only for rows the seed wrote");
    for (const f of ['head', 'clap', 'vocal', 'stems'] as const) {
      assert.ok(!db.facetNeedsIds(f).includes('bad'), `${f} still targets a dead track`);
    }
    assertConsistent();
  });

  await test('a failure on an analysed track only marks what it still lacks', () => {
    db.recordAnalysisFailure('capped', 'read ECONNRESET');
    const b = brief('capped');
    assert.equal(b.head, 'ok');
    assert.equal(b.clap, 'failed×1');
    assertConsistent();
  });

  await test('a success wipes the failure history', () => {
    db.upsertTrackAnalysis('bad', { bpm: 70, musicalKey: 'G', loudnessLufs: -14, source: 'full' });
    assert.ok(!Object.values(brief('bad')).some((v) => v.startsWith('failed')), JSON.stringify(brief('bad')));
    assertConsistent();
  });

  await test('clearing failures puts the track back in scope', () => {
    db.upsertTrackMeta('bad2', { title: 'bad2', artist: 'A', album: 'B', duration: 100 });
    for (let i = 0; i < 3; i++) db.recordAnalysisFailure('bad2', 'x');
    db.clearAnalysisFailures('bad2');
    assert.deepEqual(brief('bad2'), {});
    assert.ok(db.facetNeedsIds('head').includes('bad2'));
    assertConsistent();
  });

  await test('re-analyze (clearAnalysis) mirrors exactly what it clears', () => {
    db.clearAnalysis({ keepVocal: true, clearStems: false });
    const b = brief('full');
    assert.deepEqual(b, { vocal: 'ok', stems: 'ok' });
    // The head-only vocal row's outro is gone, so it is no longer due.
    assert.ok(!db.facetNeedsIds('vocal').includes('headonly'));
    assertConsistent();
    db.clearAnalysis();
    assert.deepEqual(brief('full'), { stems: 'ok' });
    assertConsistent();
  });

  await test('facetCounts adds up', () => {
    for (const c of db.facetCounts()) {
      assert.equal(c.ok + c.unmeasurable + c.failed + c.missing, c.total, c.facet);
    }
  });

  db.close();
  rmSync(stateDir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`✗ facet-status.test.ts: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('✓ facet-status.test.ts passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
