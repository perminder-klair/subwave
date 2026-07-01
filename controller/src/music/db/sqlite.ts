// SqliteAdapter — wraps the synchronous library-db-core.ts functions in
// Promise.resolve() so they satisfy the async LibraryDbAdapter contract.
//
// No business logic lives here; all schema/migration/query logic stays in
// library-db-core.ts. This adapter is a thin shim whose sole job is lifting
// sync return values into Promises.

import type { LibraryDbAdapter } from './adapter.js';
import type {
  TrackRecord,
  TrackMeta,
  TrackEnrichment,
  TagWrite,
  TrackAnalysisWrite,
  KnnHit,
  FilterOpts,
  EnergyValue,
  LibraryStats,
} from './adapter.js';

// Import the entire sync surface of the core module. Using a namespace import
// rather than individual named imports keeps the shim concise: each method
// body is a single Promise.resolve(core.fn(...)) call.
import * as core from '../library-db-core.js';

export class SqliteAdapter implements LibraryDbAdapter {
  // ---- Lifecycle -----------------------------------------------------------

  async open(opts: {
    embeddingDim: number;
    reseed?: boolean;
    adoptStoredDim?: boolean;
  }): Promise<number> {
    await core.open(opts);
    return core.getCurrentEmbeddingDim() ?? opts.embeddingDim;
  }

  async close(): Promise<void> {
    return core.close();
  }

  isOpen(): boolean {
    return core.isOpen();
  }

  async backup(destPath: string): Promise<void> {
    return core.backup(destPath);
  }

  async restoreFromFile(srcPath: string): Promise<void> {
    return core.restoreFromFile(srcPath);
  }

  // ---- Embedding meta ------------------------------------------------------

  async getEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
    return core.getEmbeddingMeta();
  }

  async setEmbeddingMeta(model: string, dim: number): Promise<void> {
    return core.setEmbeddingMeta(model, dim);
  }

  async getAudioEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
    return core.getAudioEmbeddingMeta();
  }

  async setAudioEmbeddingMeta(model: string, dim: number): Promise<void> {
    return core.setAudioEmbeddingMeta(model, dim);
  }

  // ---- Track CRUD ----------------------------------------------------------

  async getTrack(id: string): Promise<TrackRecord | null> {
    return core.getTrack(id);
  }

  async hasTags(id: string): Promise<boolean> {
    return core.hasTags(id);
  }

  async hasVector(id: string): Promise<boolean> {
    return core.hasVector(id);
  }

  async upsertTrackMeta(id: string, meta: TrackMeta): Promise<void> {
    return core.upsertTrackMeta(id, meta);
  }

  async upsertTrackEnrichment(id: string, enrich: TrackEnrichment): Promise<void> {
    return core.upsertTrackEnrichment(id, enrich);
  }

  async upsertTrackTags(id: string, tags: TagWrite): Promise<void> {
    return core.upsertTrackTags(id, tags);
  }

  async clearTrackTags(id: string): Promise<void> {
    return core.clearTrackTags(id);
  }

  async upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): Promise<void> {
    return core.upsertTrackAnalysis(id, a);
  }

  async needsAnalysisIds(limit?: number): Promise<string[]> {
    return core.needsAnalysisIds(limit);
  }

  async clearAnalysis(opts?: { keepVocal?: boolean }): Promise<void> {
    return core.clearAnalysis(opts);
  }

  async upsertTrackVector(id: string, vector: number[] | Float32Array): Promise<void> {
    return core.upsertTrackVector(id, vector);
  }

  async dropVectors(): Promise<void> {
    return core.dropVectors();
  }

  async upsertTrackAudioVector(id: string, vector: number[] | Float32Array): Promise<void> {
    return core.upsertTrackAudioVector(id, vector);
  }

  async dropAudioVectors(): Promise<void> {
    return core.dropAudioVectors();
  }

  // ---- Vector queries ------------------------------------------------------

  async knnById(id: string, k: number): Promise<KnnHit[]> {
    return core.knnById(id, k);
  }

  async knnByVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]> {
    return core.knnByVector(vec, k);
  }

  async knnAudioById(id: string, k: number): Promise<KnnHit[]> {
    return core.knnAudioById(id, k);
  }

  async knnByAudioVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]> {
    return core.knnByAudioVector(vec, k);
  }

  async vectorCount(): Promise<number> {
    return core.vectorCount();
  }

  async hasAudioVector(id: string): Promise<boolean> {
    return core.hasAudioVector(id);
  }

  async getVector(id: string): Promise<Float32Array | null> {
    return core.getVector(id);
  }

  async getAudioVector(id: string): Promise<Float32Array | null> {
    return core.getAudioVector(id);
  }

  async audioVectorCount(): Promise<number> {
    return core.audioVectorCount();
  }

  async vocalAnalyzedCount(): Promise<number> {
    return core.vocalAnalyzedCount();
  }

  async unanalysedAudioIds(limit?: number): Promise<string[]> {
    return core.unanalysedAudioIds(limit);
  }

  async needsVocalIds(limit?: number): Promise<string[]> {
    return core.needsVocalIds(limit);
  }

  // ---- Bulk reads ----------------------------------------------------------

  async trackCount(): Promise<number> {
    return core.trackCount();
  }

  async pruneMissingTracks(liveIds: ReadonlySet<string>): Promise<number> {
    return core.pruneMissingTracks(liveIds);
  }

  async analysedCount(): Promise<number> {
    return core.analysedCount();
  }

  async analysedIds(): Promise<string[]> {
    return core.analysedIds();
  }

  async songsByMood(mood: string): Promise<TrackRecord[]> {
    return core.songsByMood(mood);
  }

  async songsByEnergy(energy: EnergyValue): Promise<TrackRecord[]> {
    return core.songsByEnergy(energy);
  }

  async allTaggedIds(): Promise<string[]> {
    return core.allTaggedIds();
  }

  async staleTaggedIds(
    promptHash: string,
    model: string,
    limit?: number,
  ): Promise<string[]> {
    return core.staleTaggedIds(promptHash, model, limit);
  }

  async enrichedIds(): Promise<string[]> {
    return core.enrichedIds();
  }

  async untaggedIds(limit?: number): Promise<string[]> {
    return core.untaggedIds(limit);
  }

  async unembeddedIds(limit?: number): Promise<string[]> {
    return core.unembeddedIds(limit);
  }

  async embeddedIds(): Promise<string[]> {
    return core.embeddedIds();
  }

  async trackIdsByGenreDecade(): Promise<Map<string, string[]>> {
    return core.trackIdsByGenreDecade();
  }

  async genreCentroids(): Promise<
    Array<{ genre: string; count: number; centroid: Float32Array }>
  > {
    return core.genreCentroids();
  }

  // ---- Filter / stats ------------------------------------------------------

  async filter(
    opts?: FilterOpts,
  ): Promise<{ total: number; rows: TrackRecord[] }> {
    return core.filter(opts);
  }

  async allTagged(limit?: number): Promise<TrackRecord[]> {
    return core.allTagged(limit);
  }

  async allTaggedSampled(max: number, totalTagged: number): Promise<TrackRecord[]> {
    return core.allTaggedSampled(max, totalTagged);
  }

  async stats(): Promise<LibraryStats> {
    return core.stats();
  }
}
