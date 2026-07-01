// library-db.ts — adapter router / public async API.
//
// Selects the active storage backend at startup based on DATABASE_URL:
//   DATABASE_URL set   → PostgresAdapter (pgvector, postgres npm package)
//   DATABASE_URL unset → SqliteAdapter   (better-sqlite3 + sqlite-vec)
//
// All exports are now async (return Promises). Existing callers that invoke
// these functions synchronously (without `await`) will receive a Promise
// object rather than the resolved value — see POSTGRES.md for the migration
// guide. The SQLite data-path is unchanged; only the calling convention
// shifts to async.
//
// Re-exports all types from the core module so import sites only need one
// import regardless of whether they need the runtime API, the types, or both.

import type { LibraryDbAdapter } from './db/adapter.js';
import { SqliteAdapter } from './db/sqlite.js';
import { PostgresAdapter } from './db/postgres.js';
import { DATABASE_URL } from '../config.js';

export {
  // Constants
  TAGGER_VERSION,
  ANALYSIS_VERSION,
  AUDIO_EMBEDDING_DIM,
  AUDIO_EMBEDDING_VERSION,
  // Types
  type EnergyValue,
  type TagSource,
  type TrackRecord,
  type TrackKeyRange,
  type TrackSection,
  type TrackPaceSpan,
  type TrackMeta,
  type TrackEnrichment,
  type TagWrite,
  type FilterOpts,
  type LibraryStats,
  type KnnHit,
  type TrackAnalysisWrite,
} from './library-db-core.js';

// ---------------------------------------------------------------------------
// Adapter singleton
// ---------------------------------------------------------------------------

let _adapter: LibraryDbAdapter | null = null;

function getAdapter(): LibraryDbAdapter {
  if (_adapter) return _adapter;
  _adapter = DATABASE_URL ? new PostgresAdapter(DATABASE_URL) : new SqliteAdapter();
  return _adapter;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Open the library database and run pending schema migrations.
 *
 * `embeddingDim` — the text-embedding vector dimension for this run.
 * `reseed`       — if true, drop and recreate stale-dim vectors (model swap).
 * `adoptStoredDim` — if true, use the dim already in the DB rather than
 *                    trusting `embeddingDim` (live-controller self-heal path).
 */
export async function open(opts: {
  embeddingDim: number;
  reseed?: boolean;
  adoptStoredDim?: boolean;
}): Promise<number> {
  return getAdapter().open(opts);
}

export async function close(): Promise<void> {
  return getAdapter().close();
}

export function isOpen(): boolean {
  return getAdapter().isOpen();
}

export async function backup(destPath: string): Promise<void> {
  return getAdapter().backup(destPath);
}

export async function restoreFromFile(srcPath: string): Promise<void> {
  return getAdapter().restoreFromFile(srcPath);
}

// ---------------------------------------------------------------------------
// Embedding meta
// ---------------------------------------------------------------------------

export async function getEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
  return getAdapter().getEmbeddingMeta();
}

export async function setEmbeddingMeta(model: string, dim: number): Promise<void> {
  return getAdapter().setEmbeddingMeta(model, dim);
}

export async function getAudioEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
  return getAdapter().getAudioEmbeddingMeta();
}

export async function setAudioEmbeddingMeta(model: string, dim: number): Promise<void> {
  return getAdapter().setAudioEmbeddingMeta(model, dim);
}

// ---------------------------------------------------------------------------
// Track CRUD
// ---------------------------------------------------------------------------

export async function getTrack(id: string) {
  return getAdapter().getTrack(id);
}

export async function hasTags(id: string): Promise<boolean> {
  return getAdapter().hasTags(id);
}

export async function hasVector(id: string): Promise<boolean> {
  return getAdapter().hasVector(id);
}

export async function upsertTrackMeta(
  id: string,
  meta: import('./library-db-core.js').TrackMeta,
): Promise<void> {
  return getAdapter().upsertTrackMeta(id, meta);
}

export async function upsertTrackEnrichment(
  id: string,
  enrich: import('./library-db-core.js').TrackEnrichment,
): Promise<void> {
  return getAdapter().upsertTrackEnrichment(id, enrich);
}

export async function upsertTrackTags(
  id: string,
  tags: import('./library-db-core.js').TagWrite,
): Promise<void> {
  return getAdapter().upsertTrackTags(id, tags);
}

export async function clearTrackTags(id: string): Promise<void> {
  return getAdapter().clearTrackTags(id);
}

export async function upsertTrackAnalysis(
  id: string,
  a: import('./library-db-core.js').TrackAnalysisWrite,
): Promise<void> {
  return getAdapter().upsertTrackAnalysis(id, a);
}

export async function needsAnalysisIds(limit?: number): Promise<string[]> {
  return getAdapter().needsAnalysisIds(limit);
}

export async function clearAnalysis(opts?: { keepVocal?: boolean }): Promise<void> {
  return getAdapter().clearAnalysis(opts);
}

export async function upsertTrackVector(
  id: string,
  vector: number[] | Float32Array,
): Promise<void> {
  return getAdapter().upsertTrackVector(id, vector);
}

export async function dropVectors(): Promise<void> {
  return getAdapter().dropVectors();
}

export async function upsertTrackAudioVector(
  id: string,
  vector: number[] | Float32Array,
): Promise<void> {
  return getAdapter().upsertTrackAudioVector(id, vector);
}

export async function dropAudioVectors(): Promise<void> {
  return getAdapter().dropAudioVectors();
}

// ---------------------------------------------------------------------------
// Vector queries
// ---------------------------------------------------------------------------

export async function knnById(id: string, k: number) {
  return getAdapter().knnById(id, k);
}

export async function knnByVector(vec: number[] | Float32Array, k: number) {
  return getAdapter().knnByVector(vec, k);
}

export async function knnAudioById(id: string, k: number) {
  return getAdapter().knnAudioById(id, k);
}

export async function knnByAudioVector(vec: number[] | Float32Array, k: number) {
  return getAdapter().knnByAudioVector(vec, k);
}

export async function vectorCount(): Promise<number> {
  return getAdapter().vectorCount();
}

export async function hasAudioVector(id: string): Promise<boolean> {
  return getAdapter().hasAudioVector(id);
}

export async function getVector(id: string): Promise<Float32Array | null> {
  return getAdapter().getVector(id);
}

export async function getAudioVector(id: string): Promise<Float32Array | null> {
  return getAdapter().getAudioVector(id);
}

export async function audioVectorCount(): Promise<number> {
  return getAdapter().audioVectorCount();
}

export async function vocalAnalyzedCount(): Promise<number> {
  return getAdapter().vocalAnalyzedCount();
}

export async function unanalysedAudioIds(limit?: number): Promise<string[]> {
  return getAdapter().unanalysedAudioIds(limit);
}

export async function needsVocalIds(limit?: number): Promise<string[]> {
  return getAdapter().needsVocalIds(limit);
}

// ---------------------------------------------------------------------------
// Bulk reads
// ---------------------------------------------------------------------------

export async function trackCount(): Promise<number> {
  return getAdapter().trackCount();
}

export async function pruneMissingTracks(liveIds: ReadonlySet<string>): Promise<number> {
  return getAdapter().pruneMissingTracks(liveIds);
}

export async function analysedCount(): Promise<number> {
  return getAdapter().analysedCount();
}

export async function analysedIds(): Promise<string[]> {
  return getAdapter().analysedIds();
}

export async function songsByMood(mood: string) {
  return getAdapter().songsByMood(mood);
}

export async function songsByEnergy(energy: import('./library-db-core.js').EnergyValue) {
  return getAdapter().songsByEnergy(energy);
}

export async function allTaggedIds(): Promise<string[]> {
  return getAdapter().allTaggedIds();
}

export async function staleTaggedIds(
  promptHash: string,
  model: string,
  limit?: number,
): Promise<string[]> {
  return getAdapter().staleTaggedIds(promptHash, model, limit);
}

export async function enrichedIds(): Promise<string[]> {
  return getAdapter().enrichedIds();
}

export async function untaggedIds(limit?: number): Promise<string[]> {
  return getAdapter().untaggedIds(limit);
}

export async function unembeddedIds(limit?: number): Promise<string[]> {
  return getAdapter().unembeddedIds(limit);
}

export async function embeddedIds(): Promise<string[]> {
  return getAdapter().embeddedIds();
}

export async function trackIdsByGenreDecade(): Promise<Map<string, string[]>> {
  return getAdapter().trackIdsByGenreDecade();
}

export async function genreCentroids() {
  return getAdapter().genreCentroids();
}

// ---------------------------------------------------------------------------
// Filter / stats
// ---------------------------------------------------------------------------

export async function filter(opts?: import('./library-db-core.js').FilterOpts) {
  return getAdapter().filter(opts);
}

export async function allTagged(limit?: number) {
  return getAdapter().allTagged(limit);
}

export async function allTaggedSampled(max: number, totalTagged: number) {
  return getAdapter().allTaggedSampled(max, totalTagged);
}

export async function stats() {
  return getAdapter().stats();
}
