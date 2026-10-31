// Tests for the whole-file facets in library.db: `loudness` v2 (integrated
// loudness, true peak, sample peak and LRA over the whole file) and `edges`
// (silence at both ends against the absolute floor, and the decoded length).
//
// The contracts pinned here:
//   - schema step 32 adds the columns, and is safe on a database that already
//     has some of them (a user_version wound back below the step);
//   - a loudness figure's facet version is the measurement's own: the window
//     figure every head analysis writes stays at v1 (so it is due for v2), a
//     whole-file figure is v2 — read off `loudness_version`, never assumed;
//   - nothing that measures less may overwrite a whole-file figure: a flat
//     analysis, a facet answer from an older analyzer, or a --re-analyze clear;
//   - edges have their own columns and their own facet row, untouched by every
//     head/tail write and clear;
//   - a silent file settles as unmeasurable instead of staying due forever;
//   - the short-term loudness curve is stored with every v2 figure; a v2
//     figure without one (an analyzer that predates it) stays one version
//     below, re-planned only on an analyzer that reports the curve;
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

const CURVE = {
  whole: { startMs: 3000, stepMs: 1000, lufs: [-152, -141, -139] },
  head: { startMs: 3000, stepMs: 500, lufs: [-152, -150] },
  tail: { startMs: 210_000, stepMs: 500, lufs: [-160, -1000] },
};
const WHOLE = { loudnessLufs: -14.2, peakDb: 0.4, samplePeakDb: -0.2, loudnessRangeLu: 7.5, version: 2, curve: CURVE };
const P = await import('../src/music/acoustics-plan.js');
const { parseWholeLoudnessCurve } = await import('../src/music/whole-loudness-curve.js');
const storedCurve = (id: string) =>
  (sql.prepare('SELECT loudness_curve_json AS c FROM tracks WHERE id = ?').get(id) as { c: string | null }).c;
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
  assert.deepEqual(parseWholeLoudnessCurve(storedCurve('whole')), CURVE, 'the curve round-trips through its column');
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

test('step 32 re-runs safely on a database that already has the columns', async () => {
  // A wound-back user_version must not make ADD COLUMN throw.
  db.requireDb().pragma('user_version = 31');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.ok((db.requireDb().pragma('user_version', { simple: true }) as number) >= 32);
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
  sql.prepare(`UPDATE tracks SET loudness_version = 2, loudness_curve_json = ? WHERE id = 'legacy'`).run(JSON.stringify(CURVE));
  db.resyncAllFacets(db.requireDb());
  assert.equal(facetRow('legacy', 'loudness')?.version, 2);
  assert.equal(facetRow('legacy', 'loudness')?.status, 'ok');
  assert.ok(!db.facetNeedsIds('loudness').includes('legacy'));
  consistent();
});

test('a v2 figure without its curve stays one version below, re-planned only for a curve-capable analyzer', () => {
  // An analyzer that predates the curve: the figures are whole-file (kept,
  // used for gain), the row is one version below and says why.
  db.upsertTrackMeta('nocurve', { title: 'nocurve', artist: 'A', album: 'B', duration: 240 });
  db.writeFacetResults('nocurve', { source: 'url', loudness: { ...WHOLE, curve: null } });
  assert.equal(cols('nocurve').loudness_version, 2);
  assert.equal(cols('nocurve').loudness_lufs, -14.2);
  assert.deepEqual(facetRow('nocurve', 'loudness'), { status: 'ok', version: 1, reason: 'no-curve' });
  consistent();
  const plan = (loudnessCurve: boolean | null) => P.planAcoustics({
    ids: ['nocurve', 'whole'], facets: ['loudness'], where: { kind: 'needs' }, state: db.loadFacetState(['loudness']),
    capabilities: { clap: null, demucs: null, tailVocal: null, wholeFile: true, loudnessCurve },
  });
  // Unknown or older: asking again would get the same curve-less answer, every run.
  for (const cap of [null, false]) {
    const p = plan(cap);
    assert.deepEqual(p.items, [], String(cap));
    assert.equal(p.byFacet[0].skipped['no-curve'], 1);
  }
  assert.deepEqual(plan(true).items.map(i => i.id), ['nocurve']);
  // The curve arrives: v2, settled; and it survives a whole-table re-derive.
  db.writeFacetResults('nocurve', { source: 'url', loudness: WHOLE });
  assert.deepEqual(facetRow('nocurve', 'loudness'), { status: 'ok', version: 2, reason: null });
  db.resyncAllFacets(db.requireDb());
  assert.deepEqual(facetRow('nocurve', 'loudness'), { status: 'ok', version: 2, reason: null });
  consistent();
});

test('a v2 figure stored before the curve existed is re-derived one version below', () => {
  // The station that ran the whole-file pass before the curve: column v2, no
  // curve, facet row at v2. A table re-derive reopens it for the curve.
  db.upsertTrackMeta('pre', { title: 'pre', artist: 'A', album: 'B', duration: 240 });
  db.writeFacetResults('pre', { source: 'url', loudness: WHOLE });
  sql.prepare(`UPDATE tracks SET loudness_curve_json = NULL WHERE id = 'pre'`).run();
  db.resyncAllFacets(db.requireDb());
  assert.deepEqual(facetRow('pre', 'loudness'), { status: 'ok', version: 1, reason: 'no-curve' });
  consistent();
});

test('the curve parser refuses malformed input', () => {
  assert.equal(parseWholeLoudnessCurve(null), null);
  assert.equal(parseWholeLoudnessCurve('{not json'), null);
  assert.equal(parseWholeLoudnessCurve({ head: CURVE.head }), null, 'whole is required');
  assert.equal(parseWholeLoudnessCurve({ whole: { ...CURVE.whole, stepMs: 0 } }), null);
  assert.equal(parseWholeLoudnessCurve({ whole: { ...CURVE.whole, lufs: [1, 'x'] } }), null);
  assert.equal(parseWholeLoudnessCurve({ ...CURVE, tail: { startMs: -1, stepMs: 500, lufs: [] } }), null);
  // A 6.8 h DJ set (24,347 s) is a curve, not a runaway; past a day is.
  const long = { whole: { startMs: 3000, stepMs: 1000, lufs: Array(24_345).fill(-140) } };
  assert.equal(parseWholeLoudnessCurve(long)?.whole.lufs.length, 24_345);
  assert.equal(parseWholeLoudnessCurve({ whole: { ...long.whole, lufs: Array(86_401).fill(-140) } }), null);
  assert.deepEqual(parseWholeLoudnessCurve({ whole: { startMs: 3000, stepMs: 1000, lufs: [-2000, -141.4] } }),
    { whole: { startMs: 3000, stepMs: 1000, lufs: [-1000, -141] } }, 'floored and rounded to tenths');
});

test('the derivation stamp moved, so a table derived before re-derives once', () => {
  assert.equal(JSON.parse(db.facetDerivationStamp()).revision, 2);
});
