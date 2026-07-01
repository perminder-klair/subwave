// Shared LibraryDbAdapter contract suite — the SAME assertions run against
// both backends (scripts/sqlite-adapter.test.ts and
// scripts/postgres-adapter.test.ts), so the two implementations can't drift
// on semantics: migration idempotency, track/tag/enrichment/analysis writes,
// text + audio KNN ordering and seed exclusion, filter facets, stats, prune,
// and the dim-negotiation (reseed / adoptStoredDim) guards.
//
// Backend-specific setup (temp STATE_DIR vs TEST_DATABASE_URL, table wipes)
// lives in the thin runner scripts; everything observable through the
// adapter interface lives here.

import assert from 'node:assert/strict';
import type { LibraryDbAdapter } from '../src/music/db/adapter.js';

export const DIM = 8;          // text-embedding dim for the test — small + cheap
export const AUDIO_DIM = 512;  // fixed by AUDIO_EMBEDDING_DIM

// Deterministic unit vector along axis `axis` (cosine-orthogonal to any other axis).
function unitVec(dim: number, axis: number): number[] {
  const v = new Array(dim).fill(0);
  v[axis % dim] = 1;
  return v;
}

// A vector between axis 0 and axis 1 — closer to axis 0.
function leanVec(dim: number): number[] {
  const v = new Array(dim).fill(0);
  v[0] = 0.9;
  v[1] = 0.1;
  return v;
}

export interface ContractOpts {
  label: string;
  // Fresh adapter instance. Called once up front and again for the
  // dim-negotiation tests (which need a re-open from cold).
  makeAdapter: () => LibraryDbAdapter;
  // Optional: clear any pre-existing rows right after the first open()
  // (Postgres reuses a database; SQLite runners start from an empty temp dir).
  wipe?: (adapter: LibraryDbAdapter) => Promise<void>;
}

export async function runAdapterContract(opts: ContractOpts): Promise<number> {
  let failures = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      failures++;
      console.error(`  ✗ ${name}\n      ${err?.message || err}`);
    }
  }

  const adapter = opts.makeAdapter();

  // ---- Lifecycle + migration ------------------------------------------------
  console.log('lifecycle + schema migration:');

  await test('open() runs migrations and reports the requested dim', async () => {
    const dim = await adapter.open({ embeddingDim: DIM });
    assert.equal(dim, DIM);
    assert.equal(adapter.isOpen(), true);
  });

  if (opts.wipe) {
    await test('test tables can be wiped for a clean run', async () => {
      await opts.wipe!(adapter);
      assert.equal(await adapter.trackCount(), 0);
    });
  }

  await test('open() is idempotent across close/reopen (migrations re-run safely)', async () => {
    await adapter.close();
    assert.equal(adapter.isOpen(), false);
    const dim = await adapter.open({ embeddingDim: DIM });
    assert.equal(dim, DIM);
  });

  // ---- Track meta + tags ------------------------------------------------
  console.log('track meta + tag writes:');

  await test('upsertTrackMeta inserts, getTrack round-trips', async () => {
    await adapter.upsertTrackMeta('t1', {
      title: 'Night Drive', artist: 'Neon Fox', album: 'Afterglow', year: 2021, genre: 'Synthwave', duration: 245,
    });
    const t = await adapter.getTrack('t1');
    assert.equal(t?.title, 'Night Drive');
    assert.equal(t?.artist, 'Neon Fox');
    assert.equal(t?.year, 2021);
    assert.equal(t?.durationSec, 245);
    assert.deepEqual(t?.moods, []);       // untagged → empty array, not null
  });

  await test('upsertTrackMeta updates in place (no duplicate row)', async () => {
    await adapter.upsertTrackMeta('t1', { title: 'Night Drive (Remaster)', artist: 'Neon Fox', album: 'Afterglow', year: 2021, genre: 'Synthwave', duration: 245 });
    assert.equal(await adapter.trackCount(), 1);
    assert.equal((await adapter.getTrack('t1'))?.title, 'Night Drive (Remaster)');
  });

  await test('year normalises from string form', async () => {
    await adapter.upsertTrackMeta('t2', { title: 'Rainy Girl', artist: 'Blue Note', album: 'Umbrella', year: '1998', genre: 'Jazz', duration: 190 });
    assert.equal((await adapter.getTrack('t2'))?.year, 1998);
  });

  await test('upsertTrackTags + hasTags + moods round-trip', async () => {
    assert.equal(await adapter.hasTags('t1'), false);
    await adapter.upsertTrackTags('t1', {
      moods: ['night', 'driving'], energy: 'high', source: 'llm',
      confidence: 0.9, promptHash: 'ph-1', model: 'test-model',
    });
    assert.equal(await adapter.hasTags('t1'), true);
    const t = await adapter.getTrack('t1');
    assert.deepEqual(t?.moods, ['night', 'driving']);
    assert.equal(t?.energy, 'high');
    assert.equal(t?.source, 'llm');
  });

  await test('songsByMood / songsByEnergy find the tagged track', async () => {
    const byMood = await adapter.songsByMood('night');
    assert.equal(byMood.length, 1);
    assert.equal(byMood[0].id, 't1');
    const byEnergy = await adapter.songsByEnergy('high');
    assert.equal(byEnergy.length, 1);
    assert.deepEqual(await adapter.songsByMood('no-such-mood'), []);
  });

  await test('untaggedIds excludes tagged rows; allTaggedIds inverse', async () => {
    assert.deepEqual(await adapter.untaggedIds(), ['t2']);
    assert.deepEqual(await adapter.allTaggedIds(), ['t1']);
  });

  await test('staleTaggedIds flags prompt/model drift, never manual tags', async () => {
    // Same hash+model → nothing stale.
    assert.deepEqual(await adapter.staleTaggedIds('ph-1', 'test-model'), []);
    // Changed prompt → t1 is stale.
    assert.deepEqual(await adapter.staleTaggedIds('ph-2', 'test-model'), ['t1']);
    // Manual tags are ground truth — never stale.
    await adapter.upsertTrackTags('t2', { moods: ['calm'], energy: 'low', source: 'manual' });
    const stale = await adapter.staleTaggedIds('ph-2', 'test-model');
    assert.ok(!stale.includes('t2'), 'manual-tagged t2 must not be stale');
  });

  await test('clearTrackTags reverts a track to untagged', async () => {
    await adapter.clearTrackTags('t2');
    assert.equal(await adapter.hasTags('t2'), false);
  });

  // ---- Enrichment + analysis ------------------------------------------------
  console.log('enrichment + acoustic analysis:');

  await test('upsertTrackEnrichment round-trips lastfm tags + lyrics', async () => {
    await adapter.upsertTrackEnrichment('t1', { lastfmTags: ['synthwave', 'retrowave'], lyricExcerpt: 'city lights below' });
    const t = await adapter.getTrack('t1');
    assert.deepEqual(t?.lastfmTags, ['synthwave', 'retrowave']);
    assert.equal(t?.lyricExcerpt, 'city lights below');
    assert.ok(t?.enrichedAt, 'enrichedAt stamped');
  });

  await test('upsertTrackAnalysis writes acoustics; needsAnalysisIds shrinks', async () => {
    const before = await adapter.needsAnalysisIds();
    assert.ok(before.includes('t1'));
    await adapter.upsertTrackAnalysis('t1', {
      bpm: 118, musicalKey: '8A', introMs: 12000, loudnessLufs: -9.4,
      vocalRanges: [], // analysed instrumental
      pace: [{ startMs: 0, endMs: 60000, value: 0.7 }] as any,
    });
    const t = await adapter.getTrack('t1');
    assert.equal(t?.bpm, 118);
    assert.equal(t?.musicalKey, '8A');
    assert.equal(t?.introMs, 12000);
    assert.equal(t?.loudnessLufs, -9.4);
    assert.deepEqual(t?.vocalRanges, []); // [] = instrumental, distinct from null
    const after = await adapter.needsAnalysisIds();
    assert.ok(!after.includes('t1'));
    assert.equal(await adapter.analysedCount(), 1);
  });

  // ---- Text vectors + KNN ---------------------------------------------------
  console.log('text vectors + KNN:');

  await test('upsertTrackVector + hasVector + vectorCount', async () => {
    await adapter.upsertTrackMeta('t3', { title: 'Axis One', artist: 'Ortho', album: 'Basis', year: 2020, genre: 'Test', duration: 100 });
    await adapter.upsertTrackVector('t1', leanVec(DIM));       // near axis 0
    await adapter.upsertTrackVector('t2', unitVec(DIM, 0));    // axis 0
    await adapter.upsertTrackVector('t3', unitVec(DIM, 1));    // axis 1 (orthogonal)
    // Record the index provenance the way the tagger does after open() — the
    // dim-negotiation tests at the bottom key off this row.
    await adapter.setEmbeddingMeta('test-embed', DIM);
    assert.equal(await adapter.hasVector('t1'), true);
    assert.equal(await adapter.vectorCount(), 3);
  });

  await test('knnById orders by cosine similarity, excludes the seed', async () => {
    const hits = await adapter.knnById('t2', 2);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].id, 't1', 'lean vector is nearest to axis 0');
    assert.equal(hits[1].id, 't3');
    assert.ok(hits[0].similarity > hits[1].similarity);
    assert.ok(hits[0].similarity > 0.9 && hits[0].similarity <= 1.0);
    assert.ok(Math.abs(hits[1].similarity) < 0.01, 'orthogonal ≈ 0 similarity');
    assert.ok(!hits.some(h => h.id === 't2'), 'seed excluded from its own KNN');
  });

  await test('knnByVector matches knnById semantics', async () => {
    const hits = await adapter.knnByVector(unitVec(DIM, 1), 1);
    assert.equal(hits[0].id, 't3');
    assert.ok(hits[0].similarity > 0.99);
  });

  await test('getVector round-trips as Float32Array', async () => {
    const v = await adapter.getVector('t2');
    assert.ok(v instanceof Float32Array);
    assert.equal(v!.length, DIM);
    assert.ok(Math.abs(v![0] - 1) < 1e-6);
    assert.equal(await adapter.getVector('nope'), null);
  });

  await test('unembeddedIds / embeddedIds partition correctly', async () => {
    await adapter.upsertTrackMeta('t4', { title: 'No Vector Yet', artist: 'Ortho', album: 'Basis', year: 2020, genre: 'Test', duration: 90 });
    assert.deepEqual((await adapter.unembeddedIds()).sort(), ['t4']);
    assert.deepEqual((await adapter.embeddedIds()).sort(), ['t1', 't2', 't3']);
  });

  // ---- Audio vectors ----------------------------------------------------
  console.log('audio (CLAP) vectors:');

  await test('audio vector round-trip + KNN + counts', async () => {
    await adapter.upsertTrackAudioVector('t1', unitVec(AUDIO_DIM, 0));
    await adapter.upsertTrackAudioVector('t2', leanVec(AUDIO_DIM));
    assert.equal(await adapter.hasAudioVector('t1'), true);
    assert.equal(await adapter.hasAudioVector('t3'), false);
    assert.equal(await adapter.audioVectorCount(), 2);
    const hits = await adapter.knnAudioById('t1', 1);
    assert.equal(hits[0].id, 't2');
    // Seedless KNN has no exclusion — the exact-match vector itself is hit #1.
    const byVec = await adapter.knnByAudioVector(unitVec(AUDIO_DIM, 0), 1);
    assert.equal(byVec[0].id, 't1', 'seedless audio KNN includes the exact match');
    const av = await adapter.getAudioVector('t1');
    assert.equal(av!.length, AUDIO_DIM);
  });

  // ---- Filter + stats ------------------------------------------------------
  console.log('filter + stats:');

  await test('filter: q matches title/artist, facets narrow, pagination works', async () => {
    // Re-tag t2 (cleared above) so mood facet has two candidates.
    await adapter.upsertTrackTags('t2', { moods: ['calm', 'night'], energy: 'low', source: 'llm', promptHash: 'ph-1', model: 'test-model' });

    const byQ = await adapter.filter({ q: 'neon' });
    assert.equal(byQ.total, 1);
    assert.equal(byQ.rows[0].id, 't1');

    const byMood = await adapter.filter({ moods: ['night'] });
    assert.equal(byMood.total, 2);

    const byEnergy = await adapter.filter({ moods: ['night'], energy: 'high' });
    assert.equal(byEnergy.total, 1);
    assert.equal(byEnergy.rows[0].id, 't1');

    const byYear = await adapter.filter({ yearFrom: 2000, yearTo: 2022 });
    assert.ok(byYear.rows.every(r => Number(r.year) >= 2000));

    const instrumental = await adapter.filter({ vocal: 'instrumental' });
    assert.equal(instrumental.total, 1, 'only analysed-instrumental t1 matches');

    const page = await adapter.filter({ sort: 'title', limit: 1, offset: 1 });
    assert.equal(page.rows.length, 1);
    assert.ok(page.total >= 2, 'total reflects the full match count, not the page');
  });

  await test('stats aggregates moods/energy/genre/source + embedding counts', async () => {
    const s = await adapter.stats();
    assert.equal(s.total, 2);                       // t1 + t2 tagged
    assert.equal(s.byMood['night'], 2);
    assert.equal(s.byEnergy['high'], 1);
    assert.equal(s.bySource['llm'], 2);
    assert.equal(s.withEmbedding, 3);
    assert.equal(s.withAudioEmbedding, 2);
    assert.ok(s.updatedAt, 'updatedAt stamped');
  });

  await test('allTagged / allTaggedSampled return full records', async () => {
    const all = await adapter.allTagged();
    assert.equal(all.length, 2);
    // Stratified sample keeps ≥1 per genre (GREATEST(1, …)); t1/t2 are in
    // different genres, so max=1 still yields one row from each stratum.
    const sampled = await adapter.allTaggedSampled(1, 2);
    assert.equal(sampled.length, 2);
    assert.ok(sampled.every(r => r.moods.length > 0));
  });

  // ---- Prune -----------------------------------------------------------
  console.log('prune (Navidrome reconcile):');

  await test('pruneMissingTracks drops rows + vectors not in the live set', async () => {
    const pruned = await adapter.pruneMissingTracks(new Set(['t1', 't2', 't3']));
    assert.equal(pruned, 1); // t4
    assert.equal(await adapter.getTrack('t4'), null);
    assert.equal(await adapter.trackCount(), 3);
  });

  // ---- Dim negotiation -----------------------------------------------------
  console.log('embedding dim negotiation:');

  await test('reopening at a different dim without reseed throws (index protected)', async () => {
    await adapter.close();
    const fresh = opts.makeAdapter();
    await assert.rejects(
      fresh.open({ embeddingDim: DIM * 2 }),
      /reseed/i,
      'mismatched dim must throw an actionable --reseed error',
    );
    await fresh.close().catch(() => {});
  });

  await test('adoptStoredDim honours the stored dim over the requested one', async () => {
    const fresh = opts.makeAdapter();
    const dim = await fresh.open({ embeddingDim: DIM * 2, adoptStoredDim: true });
    assert.equal(dim, DIM, 'stored dim wins; populated index untouched');
    assert.equal(await fresh.vectorCount(), 3);
    await fresh.close();
  });

  await test('reseed rebuilds the vector table at the new dim (vectors dropped)', async () => {
    const fresh = opts.makeAdapter();
    const dim = await fresh.open({ embeddingDim: DIM * 2, reseed: true });
    assert.equal(dim, DIM * 2);
    assert.equal(await fresh.vectorCount(), 0, 'reseed drops stale-dim vectors');
    await fresh.upsertTrackVector('t1', unitVec(DIM * 2, 0));
    assert.equal(await fresh.vectorCount(), 1);
    await fresh.close();
  });

  console.log(
    failures === 0
      ? `\nall ${opts.label} adapter-contract tests passed`
      : `\n${failures} ${opts.label} adapter-contract tests FAILED`,
  );
  return failures;
}
