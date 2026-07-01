/**
 * PostgresAdapter integration test.
 * Spins entirely in-process — no Navidrome, no server, no LLM.
 * Requires a live Postgres with pgvector at DATABASE_URL.
 *
 * Run: DATABASE_URL=postgres://postgres:<password>@localhost:5433/postgres tsx scripts/test-pg-adapter.ts
 */

import { PostgresAdapter } from '../src/music/db/postgres.js';

const URL = process.env.DATABASE_URL;
if (!URL) { console.error('DATABASE_URL not set'); process.exit(1); }

let passed = 0;
let failed = 0;

function ok(label: string, val: boolean) {
  if (val) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

function section(name: string) { console.log(`\n── ${name}`); }

// ---------------------------------------------------------------------------

const db = new PostgresAdapter(URL);

// ── open / migrations ───────────────────────────────────────────────────────
section('open() / migrations');
const dim = await db.open({ embeddingDim: 8 }); // tiny dim for speed
ok('returns effective dim', typeof dim === 'number' && dim === 8);
ok('isOpen()', db.isOpen());

// second open() is idempotent (adoptStoredDim path)
const dim2 = await db.open({ embeddingDim: 8, adoptStoredDim: true });
ok('open() idempotent', dim2 === 8);

// Wipe data tables so repeated test runs start clean (schema_migrations left intact)
await db['_sql']`DELETE FROM track_vectors`;
await db['_sql']`DELETE FROM track_audio_vectors`;
await db['_sql']`DELETE FROM tracks`;
await db['_sql']`DELETE FROM embedding_meta`;
await db['_sql']`DELETE FROM audio_embedding_meta`;

// ── upsertTrackMeta ─────────────────────────────────────────────────────────
section('upsertTrackMeta / getTrack');
await db.upsertTrackMeta('track-1', {
  title: 'Test Song', artist: 'Test Artist', album: 'Test Album',
  year: 2024, genre: 'Math Rock', duration: 240,
});
await db.upsertTrackMeta('track-2', {
  title: 'Another Song', artist: 'Another Artist', album: 'Another Album',
  year: 2020, genre: 'Post-Rock', duration: 300,
});
await db.upsertTrackMeta('track-3', {
  title: 'Third Song', artist: 'Test Artist', album: 'Collab',
  year: 2022, genre: 'Math Rock', duration: 180,
});

const t1 = await db.getTrack('track-1');
ok('getTrack returns row', t1?.title === 'Test Song');
ok('getTrack genre', t1?.genre === 'Math Rock');
ok('getTrack durationSec', t1?.durationSec === 240);
ok('getTrack null for missing', await db.getTrack('nope') === null);

// ── upsertTrackTags / hasTags ────────────────────────────────────────────────
section('upsertTrackTags / hasTags / allTaggedIds');
ok('hasTags false before tag', await db.hasTags('track-1') === false);

await db.upsertTrackTags('track-1', {
  moods: ['energetic', 'driving'], energy: 'high',
  source: 'llm', confidence: 0.9, promptHash: 'abc123', model: 'deepseek',
});
await db.upsertTrackTags('track-3', {
  moods: ['melancholic', 'atmospheric'], energy: 'medium',
  source: 'llm', confidence: 0.85, promptHash: 'abc123', model: 'deepseek',
});

ok('hasTags true after tag', await db.hasTags('track-1') === true);
ok('hasTags false still for untagged', await db.hasTags('track-2') === false);

const tagged = await db.allTaggedIds();
ok('allTaggedIds returns 2', tagged.length === 2);
ok('allTaggedIds correct ids', tagged.includes('track-1') && tagged.includes('track-3'));

// ── songsByMood / songsByEnergy ──────────────────────────────────────────────
section('songsByMood / songsByEnergy');
const energetic = await db.songsByMood('energetic');
ok('songsByMood finds energetic', energetic.some(t => t.id === 'track-1'));
ok('songsByMood excludes non-match', !energetic.some(t => t.id === 'track-3'));

const melancholic = await db.songsByMood('melancholic');
ok('songsByMood melancholic', melancholic.some(t => t.id === 'track-3'));

const highEnergy = await db.songsByEnergy('high');
ok('songsByEnergy high', highEnergy.some(t => t.id === 'track-1'));

// ── upsertTrackAnalysis / needsAnalysisIds ───────────────────────────────────
section('upsertTrackAnalysis / needsAnalysisIds / analysedCount');
const needs = await db.needsAnalysisIds();
ok('needsAnalysisIds has all 3 before analysis', needs.length === 3);

await db.upsertTrackAnalysis('track-1', {
  bpm: 140, musicalKey: '8A', introMs: 4000,
  confidence: 0.92, loudnessLufs: -14.5, peakDb: -1.2,
});
const analysed = await db.analysedCount();
ok('analysedCount after one analysis', analysed === 1);

const t1Again = await db.getTrack('track-1');
ok('getTrack bpm after analysis', t1Again?.bpm === 140);
ok('getTrack musicalKey', t1Again?.musicalKey === '8A');
ok('getTrack introMs', t1Again?.introMs === 4000);
ok('getTrack loudnessLufs', t1Again?.loudnessLufs === -14.5);

// ── embedding meta ───────────────────────────────────────────────────────────
section('embedding meta');
ok('getEmbeddingMeta null before set', await db.getEmbeddingMeta() === null);
await db.setEmbeddingMeta('test-model', 8);
const meta = await db.getEmbeddingMeta();
ok('getEmbeddingMeta after set', meta?.model === 'test-model' && meta?.dim === 8);

// ── upsertTrackVector / knnByVector / knnById ────────────────────────────────
section('vectors / KNN');
// 8-d vectors
const v1 = new Float32Array([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
const v3 = new Float32Array([0.9, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]); // close to v1
const v2 = new Float32Array([0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]); // far

await db.upsertTrackVector('track-1', v1);
await db.upsertTrackVector('track-2', v2);
await db.upsertTrackVector('track-3', v3);

// 20 filler vectors in dims 1-7 (never dim 0, so track-3 stays closest to v1)
// Gives ivfflat enough data points for meaningful recall
for (let i = 0; i < 20; i++) {
  const fv = new Float32Array(8);
  fv[(i % 7) + 1] = 1.0;
  await db.upsertTrackVector(`filler-${i}`, fv);
}

ok('hasVector true', await db.hasVector('track-1') === true);
ok('hasVector false for missing', await db.hasVector('no-such') === false);
ok('vectorCount', await db.vectorCount() === 23);

const knn1 = await db.knnById('track-1', 2);
ok('knnById returns hits', knn1.length >= 1);
ok('knnById closest is track-3 (v3 ≈ v1)', knn1[0]?.id === 'track-3');
ok('knnById similarity < 1 for non-identical', (knn1[0]?.similarity ?? 1.0) < 1.0);

const knnV = await db.knnByVector(v1, 2);
ok('knnByVector top hit id', knnV[0]?.id === 'track-1' || knnV[0]?.id === 'track-3');
ok('knnByVector returns hits', knnV.length >= 1);

const gotVec = await db.getVector('track-1');
ok('getVector returns Float32Array', gotVec instanceof Float32Array);
ok('getVector length', gotVec?.length === 8);

// ── audio vectors ────────────────────────────────────────────────────────────
section('audio vectors');
const av1 = new Float32Array(512).fill(0.1);
await db.upsertTrackAudioVector('track-1', av1);
// Add audio vectors for track-2, track-3, and 20 fillers so ivfflat has recall
await db.upsertTrackAudioVector('track-2', new Float32Array(512).fill(0.05));
await db.upsertTrackAudioVector('track-3', new Float32Array(512).fill(0.07));
for (let i = 0; i < 20; i++) {
  const fav = new Float32Array(512);
  fav[i % 512] = 1.0;
  await db.upsertTrackAudioVector(`filler-${i}`, fav);
}
ok('hasAudioVector true', await db.hasAudioVector('track-1') === true);
ok('audioVectorCount', await db.audioVectorCount() === 23);

const av = await db.getAudioVector('track-1');
ok('getAudioVector returns 512-d', av?.length === 512);

const knnA = await db.knnAudioById('track-1', 2);
ok('knnAudioById returns hit', knnA.length >= 1);

// ── unembeddedIds / untaggedIds ──────────────────────────────────────────────
section('unembedded / untagged / stale');
const unembedded = await db.unembeddedIds();
ok('unembeddedIds 0 (all 3 have vectors)', unembedded.length === 0);

const untagged = await db.untaggedIds();
ok('untaggedIds 1 (track-2 has no moods)', untagged.length === 1 && untagged[0] === 'track-2');

const stale = await db.staleTaggedIds('different-hash', 'deepseek');
ok('staleTaggedIds finds outdated', stale.length === 2);

// ── filter / stats ───────────────────────────────────────────────────────────
section('filter / stats');
const all = await db.filter();
ok('filter() returns tagged rows', all.rows.length === 2);
ok('filter() total count', all.total === 2);

const byMood = await db.filter({ moods: ['energetic'] });
ok('filter by mood', byMood.rows.length === 1 && byMood.rows[0].id === 'track-1');

const byGenre = await db.filter({ q: 'Test' });
ok('filter by text search', byGenre.rows.length >= 1);

const stats = await db.stats();
ok('stats.total (tagged count)', stats.total === 2);
ok('stats.withEmbedding >= 3', stats.withEmbedding >= 3);

// ── trackCount / analysedIds ─────────────────────────────────────────────────
section('counts / ids');
ok('trackCount', await db.trackCount() === 3);
const aIds = await db.analysedIds();
ok('analysedIds', aIds.includes('track-1') && aIds.length === 1);

// ── trackIdsByGenreDecade / genreCentroids ───────────────────────────────────
section('genreDecade / genreCentroids');
const gd = await db.trackIdsByGenreDecade();
ok('trackIdsByGenreDecade has untagged track-2', gd.size > 0);

const centroids = await db.genreCentroids();
ok('genreCentroids returns entries', centroids.length > 0);
ok('genreCentroids has genre', centroids.every(c => typeof c.genre === 'string'));
ok('genreCentroids centroid is Float32Array', centroids.every(c => c.centroid instanceof Float32Array));
ok('genreCentroids centroid dim matches', centroids.every(c => c.centroid.length === 8));

// ── pruneMissingTracks (transaction test) ────────────────────────────────────
section('pruneMissingTracks (transaction)');
const liveSet = new Set(['track-1', 'track-3']); // track-2 is "gone from Navidrome"
const pruned = await db.pruneMissingTracks(liveSet);
ok('pruneMissingTracks returns count', pruned === 1);
ok('pruned track not in getTrack', await db.getTrack('track-2') === null);
ok('trackCount after prune', await db.trackCount() === 2);
ok('vectorCount after prune', await db.vectorCount() === 22);
ok('track-1 still alive', await db.getTrack('track-1') !== null);

// ── allTaggedSampled ─────────────────────────────────────────────────────────
section('allTagged / allTaggedSampled');
const allTagged = await db.allTagged(10);
ok('allTagged returns tagged', allTagged.length === 2);
const sampled = await db.allTaggedSampled(1, 2);
ok('allTaggedSampled returns 1', sampled.length === 1);

// ── enrichedIds / dropVectors ────────────────────────────────────────────────
section('enrichedIds / clearAnalysis / dropVectors');
const enriched = await db.enrichedIds();
ok('enrichedIds empty (no enrichment)', enriched.length === 0);

await db.clearAnalysis({ keepVocal: false });
ok('analysedCount 0 after clearAnalysis', await db.analysedCount() === 0);

await db.dropVectors();
ok('vectorCount 0 after dropVectors', await db.vectorCount() === 0);

await db.dropAudioVectors();
ok('audioVectorCount 0 after dropAudioVectors', await db.audioVectorCount() === 0);

// ── close / backup 501 ──────────────────────────────────────────────────────
section('close / backup stub');
let warnMsg = '';
const origWarn = console.warn;
console.warn = (m: string) => { warnMsg = m; };
await db.backup('/tmp/ignored.db');
console.warn = origWarn;
ok('backup() is a no-op with warn', warnMsg.includes('pg_dump'));

await db.close();
ok('isOpen() false after close', !db.isOpen());

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`PASSED: ${passed}  FAILED: ${failed}  TOTAL: ${passed + failed}`);
if (failed > 0) { console.error('\nSome tests FAILED.'); process.exit(1); }
else { console.log('\nAll tests passed.'); }
