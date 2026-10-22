// Tests for the whole-file facets in library.db: `loudness` v2 (integrated
// loudness, true peak, sample peak and LRA over the whole file) and `edges`
// (silence at both ends against the absolute floor, and the decoded length).
//
// The contracts pinned here:
//   - schema step 30 adds the columns, and is safe on a database that already
//     has some of them (a user_version wound back below the step);
//   - a loudness figure's facet version is the measurement's own: the window
//     figure every head analysis writes stays at v1 (so it is due for v2), a
//     whole-file figure is v2 — read off `loudness_version`, never assumed;
//   - nothing that measures less may overwrite a whole-file figure: a flat
//     analysis, a facet answer from an older analyzer, or a --re-analyze clear;
//   - edges have their own columns and their own facet row, untouched by every
//     head/tail write and clear;
//   - a silent file settles as unmeasurable instead of staying due forever;
//   - the facet table stays consistent with the columns (checkFacets) throughout.
//
// Real better-sqlite3 against a temp STATE_DIR, like facet-status.test.ts.
// Run: `npm test -- whole-file-facets`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-whole-file-'));
process.env.STATE_DIR = stateDir;

const db = await import('../src/music/library-db.js');
const { checkFacets } = await import('../src/music/facet-check.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
const sql = { prepare: (q: string) => db.requireDb().prepare(q) };

type Row = { status: string; version: number; reason: string | null };
const facetRow = (id: string, facet: string): Row | undefined =>
  sql.prepare('SELECT status, version, reason FROM track_facet_status WHERE track_id = ? AND facet = ?')
    .get(id, facet) as Row | undefined;
const cols = (id: string) => sql.prepare(
  `SELECT loudness_lufs, peak_db, sample_peak_db, loudness_range_lu, loudness_version,
          edge_lead_ms, edge_tail_ms, decoded_duration_ms
     FROM tracks WHERE id = ?`,
).get(id) as Record<string, number | null>;
const consistent = () => {
  const r = checkFacets();
  assert.ok(r.ok, JSON.stringify({ drift: r.drift, orphans: r.orphans }));
};

const WHOLE = { loudnessLufs: -14.2, peakDb: 0.4, samplePeakDb: -0.2, loudnessRangeLu: 7.5, version: 2 };
const EDGES = { leadMs: 1200, tailMs: 4300, durationMs: 241_517 };

for (const id of ['window', 'whole', 'silent', 'fresh']) {
  db.upsertTrackMeta(id, { title: id, artist: 'A', album: 'B', duration: 240 });
}
// Every head analysis measures the window's loudness.
for (const id of ['window', 'whole', 'silent']) {
  db.upsertTrackAnalysis(id, { bpm: 120, musicalKey: 'Am', loudnessLufs: -10, peakDb: -1 });
}

test('versions: loudness is at v2, edges is a facet of its own', () => {
  assert.equal(db.FACET_VERSIONS.loudness, 2);
  assert.ok((db.FACETS as readonly string[]).includes('edges'));
  assert.equal(db.FACET_VERSIONS.edges, 1);
});

test('a window loudness figure is v1, so it is due for the whole-file pass', () => {
  assert.deepEqual(facetRow('window', 'loudness'), { status: 'ok', version: 1, reason: null });
  assert.ok(db.facetNeedsIds('loudness').includes('window'));
  // No edges row until measured: never attempted, so due.
  assert.equal(facetRow('window', 'edges'), undefined);
  assert.ok(db.facetNeedsIds('edges').includes('window'));
  consistent();
});

test('a whole-file answer stores all four figures with its version, and settles', () => {
  db.writeFacetResults('whole', { source: 'url', loudness: WHOLE, edges: EDGES });
  assert.deepEqual(cols('whole'), {
    loudness_lufs: -14.2, peak_db: 0.4, sample_peak_db: -0.2, loudness_range_lu: 7.5, loudness_version: 2,
    edge_lead_ms: 1200, edge_tail_ms: 4300, decoded_duration_ms: 241_517,
  });
  assert.deepEqual(facetRow('whole', 'loudness'), { status: 'ok', version: 2, reason: null });
  assert.deepEqual(facetRow('whole', 'edges'), { status: 'ok', version: 1, reason: null });
  assert.ok(!db.facetNeedsIds('loudness').includes('whole'));
  assert.ok(!db.facetNeedsIds('edges').includes('whole'));
  const t = db.getTrack('whole')!;
  assert.equal(t.edgeLeadMs, 1200);
  assert.equal(t.edgeTailMs, 4300);
  assert.equal(t.decodedDurationMs, 241_517);
  consistent();
});

test('a flat head analysis never overwrites whole-file loudness, but still updates a window one', () => {
  db.upsertTrackAnalysis('whole', { bpm: 121, musicalKey: 'Am', loudnessLufs: -9, peakDb: -2 });
  db.upsertTrackAnalysis('window', { bpm: 121, musicalKey: 'Am', loudnessLufs: -9, peakDb: -2 });
  assert.equal(cols('whole').loudness_lufs, -14.2);
  assert.equal(cols('whole').peak_db, 0.4);
  assert.equal(cols('whole').edge_tail_ms, 4300);
  assert.equal(cols('window').loudness_lufs, -9);
  assert.equal(facetRow('whole', 'loudness')?.version, 2);
  consistent();
});

test('a window answer from an older analyzer cannot downgrade a whole-file figure', () => {
  db.writeFacetResults('whole', { source: 'full', loudness: { loudnessLufs: -8, peakDb: -3 } });
  assert.equal(cols('whole').loudness_lufs, -14.2);
  assert.equal(cols('whole').loudness_version, 2);
  // On a window track the same answer is just a window figure, still v1.
  db.writeFacetResults('window', { source: 'full', loudness: { loudnessLufs: -8, peakDb: -3 } });
  assert.equal(cols('window').loudness_lufs, -8);
  assert.equal(cols('window').loudness_version, null);
  assert.equal(facetRow('window', 'loudness')?.version, 1);
  consistent();
});

test('a silent file settles: unmeasurable at the current version, not due', () => {
  db.writeFacetResults('silent', { source: 'url', unmeasurable: { edges: 'silent-file' } });
  assert.deepEqual(facetRow('silent', 'edges'), { status: 'unmeasurable', version: 1, reason: 'silent-file' });
  assert.ok(!db.facetNeedsIds('edges').includes('silent'));
  consistent();
});

test('--re-analyze clears the window analysis but keeps the whole-file figures', () => {
  db.clearAnalysis();
  const w = cols('whole');
  assert.equal(w.loudness_lufs, -14.2);
  assert.equal(w.peak_db, 0.4);
  assert.equal(w.loudness_range_lu, 7.5);
  assert.equal(w.edge_lead_ms, 1200);
  assert.equal(cols('window').loudness_lufs, null);
  assert.deepEqual(facetRow('whole', 'loudness'), { status: 'ok', version: 2, reason: null });
  assert.deepEqual(facetRow('whole', 'edges'), { status: 'ok', version: 1, reason: null });
  assert.equal(facetRow('silent', 'edges')?.status, 'unmeasurable');
  consistent();
});

test('step 30 re-runs safely on a database that already has the columns', async () => {
  // A wound-back user_version must not make ADD COLUMN throw.
  db.requireDb().pragma('user_version = 29');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 30);
  assert.equal(cols('whole').loudness_version, 2);
  consistent();
});

test('a stored whole-file figure promotes a stale loudness row on re-derive', () => {
  // A station that measured whole-file loudness before this facet existed has
  // loudness_version = 2 on the track but a facet row derived at v1. The
  // column IS the measurement's version, so a re-derive must take it, or every
  // such track is planned for a loudness re-read it does not need.
  db.upsertTrackMeta('legacy', { title: 'legacy', artist: 'A', album: 'B', duration: 240 });
  db.upsertTrackAnalysis('legacy', { bpm: 120, musicalKey: 'Am', loudnessLufs: -12, peakDb: 0.5 });
  assert.equal(facetRow('legacy', 'loudness')?.version, 1);
  sql.prepare(`UPDATE tracks SET loudness_version = 2 WHERE id = 'legacy'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.equal(facetRow('legacy', 'loudness')?.version, 2);
  assert.equal(facetRow('legacy', 'loudness')?.status, 'ok');
  assert.ok(!db.facetNeedsIds('loudness').includes('legacy'));
  consistent();
});

test('the derivation stamp moved, so a table derived before re-derives once', () => {
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 2);
});
