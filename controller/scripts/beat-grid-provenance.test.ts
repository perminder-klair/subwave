// Persistence and wire compatibility for optional Beat This window evidence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { canonicalId } from '../src/music/id-canonical.js';
import { parseBeatGridProvenance, type BeatGridProvenance } from '../src/schemas/beat-grid.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-grid-provenance-'));
process.env.STATE_DIR = stateDir;
const provenance: BeatGridProvenance = {
  version: 1, backend: 'beat-this-onnx', model: 'custom', modelSha256: 'a'.repeat(64),
  preprocessingVersion: 1, windowStartMs: 0, windowEndMs: 40000,
  evidence: { medianBpm: 120, intervalSupport: 1, librosaBeatSupport: 0 },
  source: { sha256: 'b'.repeat(64), bytes: 12345, complete: true },
};
const tailProvenance = { ...provenance, windowStartMs: 220000, windowEndMs: 240000 };
const wire = {
  ok: true, beats: [250, 750, 1250], bars: [750], grid_provenance: provenance,
  outro: { startMs: 235000, ending: 'cold', beats: [220250, 220750], bars: [220750], gridProvenance: tailProvenance },
};
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/health' ? { ok: true, engines: ['analyze'] } : wire));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
process.env.ANALYZE_URL = `http://127.0.0.1:${address.port}`;
const analyzer = await import('../src/music/analyzer.js');
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 8, adoptStoredDim: true });
after(async () => {
  analyzer.shutdown();
  db.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await removeTempDir(stateDir);
});

test('flat sidecar and facet/local mapping retain measured provenance', async () => {
  const result = await analyzer.analyzePath('/shared/source.audio', { complete: true });
  assert.deepEqual(result.gridProvenance, provenance);
  assert.deepEqual(result.outro?.gridProvenance, tailProvenance);
  const facet = analyzer.parseFacetAnswer({ facets: { head: { status: 'ok', data: wire } } });
  assert.deepEqual(facet.facets.head?.result.gridProvenance, provenance);
  assert.deepEqual(facet.facets.head?.result.outro?.gridProvenance, tailProvenance);
});

test('flat/facet writes persist evidence, including disagreement, through reopen', async () => {
  db.upsertTrackMeta('grid', { title: 'grid' });
  const result = await analyzer.analyzePath('/shared/source.audio');
  db.upsertTrackAnalysis('grid', result);
  assert.deepEqual(db.getTrack('grid')?.gridProvenance, provenance);
  assert.deepEqual(db.getTrack('grid')?.outro?.gridProvenance, tailProvenance);
  const head = {
    bpm: 120, musicalKey: null, introMs: null, confidence: null, sections: null,
    pace: null, beats: wire.beats, bars: wire.bars, keyRanges: null,
    leadSilenceMs: null, gridProvenance: provenance,
  };
  db.writeFacetResults('grid', { head, source: 'full' });
  const version = db.requireDb().pragma('user_version', { simple: true });
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), version);
  assert.deepEqual(db.getTrack('grid')?.gridProvenance, provenance);
  assert.deepEqual(db.getTrack('grid')?.outro?.gridProvenance, tailProvenance);
  // A non-grid facet cannot erase the grid or its evidence.
  db.writeFacetResults('grid', { loudness: { loudnessLufs: -12, peakDb: -1 }, source: 'full' });
  assert.deepEqual(db.getTrack('grid')?.gridProvenance, provenance);
  // A new head from an older worker/off/fallback replaces the learned label.
  db.writeFacetResults('grid', { head: { ...head, gridProvenance: undefined }, source: 'full' });
  assert.equal(db.getTrack('grid')?.gridProvenance, null);
  assert.deepEqual(db.getTrack('grid')?.beats, wire.beats);
  // An unmeasured/capped tail keeps its original provenance with its grid.
  assert.deepEqual(db.getTrack('grid')?.outro?.gridProvenance, tailProvenance);
});

test('malformed/unknown evidence is ignored without dropping valid grids', () => {
  for (const bad of [null, {}, { ...provenance, version: 2 },
    { ...provenance, windowEndMs: 0 }, { ...provenance, modelSha256: 'bad' },
    { ...provenance, evidence: { ...provenance.evidence, intervalSupport: 2 } }]) {
    assert.equal(parseBeatGridProvenance(bad), null);
    const mapped = analyzer.parseFacetAnswer({ facets: { head: { status: 'ok', data: {
      ...wire, grid_provenance: bad, outro: { ...wire.outro, gridProvenance: bad },
    } } } }).facets.head!.result;
    assert.equal(mapped.gridProvenance, null);
    assert.equal(mapped.outro?.gridProvenance, undefined);
    assert.deepEqual(mapped.beats, wire.beats);
  }
  db.requireDb().prepare('UPDATE tracks SET grid_provenance_json = ? WHERE id = ?').run('{bad', 'grid');
  assert.equal(db.getTrack('grid')?.gridProvenance, null);
  assert.deepEqual(db.getTrack('grid')?.beats, wire.beats);
});

test('ID adoption carries provenance with its grid and keeps a fresh legacy grid unlabelled', () => {
  for (const fresh of [false, true]) {
    const old = (fresh ? '2' : '1').repeat(32);
    const current = canonicalId(old);
    db.upsertTrackMeta(old, { title: 'old id' });
    db.upsertTrackMeta(current, { title: 'current id' });
    db.upsertTrackAnalysis(old, { beats: wire.beats, bars: wire.bars, gridProvenance: provenance });
    if (fresh) db.upsertTrackAnalysis(current, { beats: [100, 600], bars: [100] });
    assert.equal(db.adoptRotatedIds(new Set([current, 'grid'])).adopted, 1);
    const track = db.getTrack(current)!;
    assert.deepEqual(track.beats, fresh ? [100, 600] : wire.beats);
    assert.deepEqual(track.gridProvenance, fresh ? null : provenance);
  }
});

test('legacy replacement and audio reset remove stale learned labels', () => {
  for (const clear of [() => db.upsertTrackAnalysis('grid', { beats: wire.beats }),
    () => db.clearTrackAudio('grid'), () => db.clearAnalysis()]) {
    db.upsertTrackAnalysis('grid', { beats: wire.beats, gridProvenance: provenance });
    assert.deepEqual(db.getTrack('grid')?.gridProvenance, provenance);
    clear();
    assert.equal(db.getTrack('grid')?.gridProvenance, null);
  }
});

test('an old database gains the nullable column by name without advancing user_version', async () => {
  const version = db.requireDb().pragma('user_version', { simple: true });
  db.requireDb().exec('ALTER TABLE tracks DROP COLUMN grid_provenance_json');
  db.close();
  await db.open({ embeddingDim: 8, adoptStoredDim: true });
  assert.equal(db.requireDb().pragma('user_version', { simple: true }), version);
  assert.equal(db.getTrack('grid')?.gridProvenance, null);
});
