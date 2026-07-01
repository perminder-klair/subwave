// LibraryDbAdapter — the contract every storage backend must satisfy.
//
// All methods are async so both the synchronous SQLite backend (wrapped in
// Promise.resolve) and the truly-async Postgres backend implement the same
// interface. The active adapter is selected at startup based on DATABASE_URL:
//   - DATABASE_URL set   → PostgresAdapter (db/postgres.ts)
//   - DATABASE_URL unset → SqliteAdapter   (db/sqlite.ts)

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
} from '../library-db-core.js';

export type {
  TrackRecord,
  TrackMeta,
  TrackEnrichment,
  TagWrite,
  TrackAnalysisWrite,
  KnnHit,
  FilterOpts,
  EnergyValue,
  LibraryStats,
};

export interface LibraryDbAdapter {
  // --- Lifecycle -----------------------------------------------------------

  /**
   * Open the backing store and run any pending schema migrations.
   *
   * Returns the effective embedding dim — the dim the vector table is
   * actually built at. This may differ from `opts.embeddingDim` when
   * `adoptStoredDim` is true and the stored dim wins over the requested one.
   * The caller (library-db.ts) captures and stores this value.
   */
  open(opts: {
    embeddingDim: number;
    reseed?: boolean;
    adoptStoredDim?: boolean;
  }): Promise<number>;

  /** Close the connection / file handle and release resources. */
  close(): Promise<void>;

  /** True after open() has been called and before close(). */
  isOpen(): boolean;

  /**
   * Write a consistent snapshot of the database to `destPath`.
   * Postgres adapters may throw or warn; only SQLite implements this fully.
   */
  backup(destPath: string): Promise<void>;

  /**
   * Replace the backing store with the file at `srcPath`.
   * Postgres adapters may throw or warn; only SQLite implements this fully.
   */
  restoreFromFile(srcPath: string): Promise<void>;

  // --- Embedding meta -------------------------------------------------------

  getEmbeddingMeta(): Promise<{ model: string; dim: number } | null>;
  setEmbeddingMeta(model: string, dim: number): Promise<void>;
  getAudioEmbeddingMeta(): Promise<{ model: string; dim: number } | null>;
  setAudioEmbeddingMeta(model: string, dim: number): Promise<void>;

  // --- Track CRUD -----------------------------------------------------------

  getTrack(id: string): Promise<TrackRecord | null>;
  hasTags(id: string): Promise<boolean>;
  hasVector(id: string): Promise<boolean>;
  upsertTrackMeta(id: string, meta: TrackMeta): Promise<void>;
  upsertTrackEnrichment(id: string, enrich: TrackEnrichment): Promise<void>;
  upsertTrackTags(id: string, tags: TagWrite): Promise<void>;
  clearTrackTags(id: string): Promise<void>;
  upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): Promise<void>;
  needsAnalysisIds(limit?: number): Promise<string[]>;
  clearAnalysis(opts?: { keepVocal?: boolean }): Promise<void>;
  upsertTrackVector(id: string, vector: number[] | Float32Array): Promise<void>;
  dropVectors(): Promise<void>;
  upsertTrackAudioVector(id: string, vector: number[] | Float32Array): Promise<void>;
  dropAudioVectors(): Promise<void>;

  // --- Vector queries -------------------------------------------------------

  knnById(id: string, k: number): Promise<KnnHit[]>;
  knnByVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]>;
  knnAudioById(id: string, k: number): Promise<KnnHit[]>;
  knnByAudioVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]>;
  vectorCount(): Promise<number>;
  hasAudioVector(id: string): Promise<boolean>;
  getVector(id: string): Promise<Float32Array | null>;
  getAudioVector(id: string): Promise<Float32Array | null>;
  audioVectorCount(): Promise<number>;
  vocalAnalyzedCount(): Promise<number>;
  unanalysedAudioIds(limit?: number): Promise<string[]>;
  needsVocalIds(limit?: number): Promise<string[]>;

  // --- Bulk reads -----------------------------------------------------------

  trackCount(): Promise<number>;
  pruneMissingTracks(liveIds: ReadonlySet<string>): Promise<number>;
  analysedCount(): Promise<number>;
  analysedIds(): Promise<string[]>;
  songsByMood(mood: string): Promise<TrackRecord[]>;
  songsByEnergy(energy: EnergyValue): Promise<TrackRecord[]>;
  allTaggedIds(): Promise<string[]>;
  staleTaggedIds(
    promptHash: string,
    model: string,
    limit?: number,
  ): Promise<string[]>;
  enrichedIds(): Promise<string[]>;
  untaggedIds(limit?: number): Promise<string[]>;
  unembeddedIds(limit?: number): Promise<string[]>;
  embeddedIds(): Promise<string[]>;
  trackIdsByGenreDecade(): Promise<Map<string, string[]>>;
  genreCentroids(): Promise<
    Array<{ genre: string; count: number; centroid: Float32Array }>
  >;

  // --- Filter / stats -------------------------------------------------------

  filter(opts?: FilterOpts): Promise<{ total: number; rows: TrackRecord[] }>;
  allTagged(limit?: number): Promise<TrackRecord[]>;
  allTaggedSampled(max: number, totalTagged: number): Promise<TrackRecord[]>;
  stats(): Promise<LibraryStats>;
}
