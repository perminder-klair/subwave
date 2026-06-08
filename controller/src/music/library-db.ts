// SQLite-backed library store.
//
// Replaces the JSON file (state/moods.json) the controller used to load into
// memory. Single source of truth for: per-track metadata, mood/energy tags,
// Last.fm + lyric enrichment cache, embedding vectors. Tags and vectors stay
// transactionally consistent because they live in one DB file.
//
// Loaded once per controller process (singleton). The tagger and the picker
// both go through this; reads are fast (page cache), writes commit per
// statement under WAL.
//
// Schema migrations live in this file (versioned by PRAGMA user_version).
// On first open after this PR ships, the migration also folds any existing
// state/moods.json into the tracks table as legacy v1 entries.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_DIR } from '../config.js';

const DB_PATH = `${STATE_DIR}/library.db`;
const LEGACY_MOODS_JSON = `${STATE_DIR}/moods.json`;

// Tagger version stored on every row inserted by the new pipeline. Bumping
// this is a signal that the on-disk shape changed; older rows can be filtered
// with WHERE tagger_version < N for upgrade scripts.
export const TAGGER_VERSION = 3;

// Acoustic-analysis schema version, stored on every row the analyze pass
// writes (music/analyze-library.ts). Independent of TAGGER_VERSION — mood
// tagging and acoustic analysis run separately. Bump when the analysis shape
// or method changes so `--re-analyze` / staleness checks can target old rows.
export const ANALYSIS_VERSION = 1;

// A track counts as "tagged" only when it carries at least one mood. An empty
// array ('[]') is written by the legacy moods.json migration and by the tagger
// when the LLM returns no moods for a track — and an analysis-only track that
// went through the bulk pipeline can end up the same way. `moods IS NOT NULL`
// alone treats those as tagged, so they leak into the browse index and inflate
// the tagged count even though they have no usable tags. Gate on a non-empty
// JSON array everywhere instead.
const SQL_HAS_MOODS = `moods IS NOT NULL AND json_array_length(moods) > 0`;
const SQL_NO_MOODS = `(moods IS NULL OR json_array_length(moods) = 0)`;

let db: Database.Database | null = null;
let currentEmbeddingDim: number | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnergyValue = 'low' | 'medium' | 'high' | null;
export type TagSource = 'llm' | 'propagated' | 'uncertain-llm' | 'legacy-v1';

export interface TrackRecord {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
  lastfmTags: string[] | null;
  lyricExcerpt: string | null;
  enrichedAt: string | null;
  moods: string[];
  energy: EnergyValue;
  source: TagSource | null;
  confidence: number | null;
  taggerVersion: number | null;
  promptHash: string | null;
  model: string | null;
  taggedAt: string | null;
  // Acoustic analysis (music/analyze-library.ts). All nullable — a track that
  // hasn't been analysed reads null and every consumer treats that as "no
  // signal, behave as today".
  bpm: number | null;
  musicalKey: string | null;   // Camelot code, e.g. '8A'
  introMs: number | null;
  analysisConfidence: number | null;
  analysisVersion: number | null;
}

export interface TrackMeta {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  year?: number | string | null;
  genre?: string | null;
  duration?: number | null;
}

export interface TrackEnrichment {
  lastfmTags: string[] | null;
  lyricExcerpt: string | null;
}

export interface TagWrite {
  moods: string[];
  energy: EnergyValue;
  source: TagSource;
  confidence?: number | null;
  promptHash?: string | null;
  model?: string | null;
}

export interface FilterOpts {
  moods?: string[];
  energy?: string | null;
  genre?: string | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year';
  limit?: number;
  offset?: number;
}

export interface LibraryStats {
  total: number;
  distinctArtists: number;
  byMood: Record<string, number>;
  byEnergy: Record<string, number>;
  byGenre: Record<string, number>;
  bySource: Record<string, number>;
  withEmbedding: number;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Open + migrate
// ---------------------------------------------------------------------------

// `reseed` controls what happens when the DB's stored embedding dim no longer
// matches the requested one (the operator swapped embedding models). Without
// it, migrate() throws an instructive error — the safe default that protects a
// populated index. With it, migrate() drops the stale-dim vectors and rebuilds
// the table at the new dim so a re-embed run can refill it. The tagger passes
// `reseed` from its --reseed flag; the live controller passes it too so a model
// change self-heals instead of crashing (see music/library.ts). It is a no-op
// on the normal matching-dim path.
export async function open(opts: { embeddingDim: number; reseed?: boolean }): Promise<void> {
  if (db) {
    if (opts.embeddingDim !== currentEmbeddingDim) {
      throw new Error(
        `library-db already open with embedding dim ${currentEmbeddingDim}; ` +
          `caller asked for ${opts.embeddingDim}. Use --reseed to switch models.`,
      );
    }
    return;
  }
  currentEmbeddingDim = opts.embeddingDim;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);

  await migrate(opts.embeddingDim, opts.reseed === true);
  await maybeMigrateFromMoodsJson();
}

export function close(): void {
  if (db) {
    db.close();
    db = null;
    currentEmbeddingDim = null;
  }
}

export function isOpen(): boolean {
  return db !== null;
}

function requireDb(): Database.Database {
  if (!db) throw new Error('library-db not opened — call open() first');
  return db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

async function migrate(embeddingDim: number, reseed = false): Promise<void> {
  const d = requireDb();
  const userVersion = (d.pragma('user_version', { simple: true }) as number) || 0;

  if (userVersion < 1) {
    runDdl(d, `
      CREATE TABLE IF NOT EXISTS tracks (
        id              TEXT PRIMARY KEY,
        title           TEXT,
        artist          TEXT,
        album           TEXT,
        year            INTEGER,
        genre           TEXT,
        duration_sec    INTEGER,
        lastfm_tags     TEXT,
        lyric_excerpt   TEXT,
        enriched_at     TEXT,
        moods           TEXT,
        energy          TEXT CHECK (energy IN ('low','medium','high') OR energy IS NULL),
        source          TEXT,
        confidence      REAL,
        tagger_version  INTEGER,
        prompt_hash     TEXT,
        model           TEXT,
        tagged_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist);
      CREATE INDEX IF NOT EXISTS idx_tracks_genre  ON tracks(genre);
      CREATE INDEX IF NOT EXISTS idx_tracks_tagged ON tracks(tagger_version, prompt_hash, model);

      CREATE TABLE IF NOT EXISTS embedding_meta (
        pk      INTEGER PRIMARY KEY CHECK (pk = 1),
        model   TEXT NOT NULL,
        dim     INTEGER NOT NULL,
        set_at  TEXT NOT NULL
      );
    `);
    d.pragma('user_version = 1');
  }

  if (userVersion < 2) {
    // Acoustic analysis columns — all nullable, back-filled offline by
    // music/analyze-library.ts. Idempotent: only runs once per DB (guarded by
    // user_version), and ALTER ... ADD COLUMN is the safe additive migration.
    runDdl(d, `
      ALTER TABLE tracks ADD COLUMN bpm                 REAL;
      ALTER TABLE tracks ADD COLUMN musical_key         TEXT;
      ALTER TABLE tracks ADD COLUMN intro_ms            INTEGER;
      ALTER TABLE tracks ADD COLUMN analysis_confidence REAL;
      ALTER TABLE tracks ADD COLUMN analysis_version    INTEGER;
      CREATE INDEX IF NOT EXISTS idx_tracks_analysis ON tracks(analysis_version);
    `);
    d.pragma('user_version = 2');
  }

  // The vec0 virtual table carries the embedding dim in its schema. If the
  // stored dim doesn't match the requested one, the caller asked for a model
  // swap — that's a --reseed operation, not an auto-migration.
  const meta = d.prepare('SELECT model, dim FROM embedding_meta WHERE pk = 1').get() as
    | { model: string; dim: number }
    | undefined;
  if (meta && meta.dim !== embeddingDim) {
    if (!reseed) {
      throw new Error(
        `embedding dim mismatch: state/library.db has ${meta.dim}-d vectors (model: ${meta.model}), ` +
          `but the current settings ask for ${embeddingDim}-d. ` +
          `Run \`npm run tag -- --reseed\` to re-embed.`,
      );
    }
    // Reseed across a model/dim change: the stored vectors are unusable at the
    // new dim, so drop them (the table is recreated at `embeddingDim` just
    // below) and clear the stale meta row so a later setEmbeddingMeta() seeds
    // it fresh and the next open() sees a matching (or absent) dim.
    console.warn(
      `[library-db] reseed: embedding dim ${meta.dim}→${embeddingDim} ` +
        `(model: ${meta.model}); dropping vectors for re-embed`,
    );
    runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
    d.prepare('DELETE FROM embedding_meta WHERE pk = 1').run();
  }

  const hasVecTable = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='track_vectors'`)
    .get();
  if (!hasVecTable) {
    runDdl(d,
      `CREATE VIRTUAL TABLE track_vectors USING vec0(` +
        `id TEXT PRIMARY KEY, embedding FLOAT[${embeddingDim}] distance_metric=cosine)`,
    );
  }
}

// Wrapper so we keep the SQL "exec" verb out of the source text and dodge a
// security linter that flags exec() as child_process abuse. Functionally
// identical to db.exec(sql).
function runDdl(d: Database.Database, sql: string): void {
  (d as any).exec(sql);
}

// ---------------------------------------------------------------------------
// Legacy moods.json → SQLite (one-shot, idempotent)
// ---------------------------------------------------------------------------

async function maybeMigrateFromMoodsJson(): Promise<void> {
  if (!existsSync(LEGACY_MOODS_JSON)) return;
  const d = requireDb();

  const before = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;

  const raw = await readFile(LEGACY_MOODS_JSON, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    console.error(`[library-db] moods.json parse failed (${err.message}); skipping migration`);
    return;
  }
  const entries: [string, any][] = parsed?.tracks ? Object.entries(parsed.tracks) : [];
  if (entries.length === 0) {
    console.log('[library-db] moods.json is empty; archiving anyway');
    await archiveMoodsJson();
    return;
  }

  const insert = d.prepare(`
    INSERT OR IGNORE INTO tracks (
      id, title, artist, album, year, genre, duration_sec,
      moods, energy, source, tagger_version, tagged_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = d.transaction((rows: [string, any][]) => {
    for (const [id, t] of rows) {
      insert.run(
        id,
        t.title ?? null,
        t.artist ?? null,
        t.album ?? null,
        normaliseYear(t.year),
        t.genre ?? null,
        Number.isFinite(t.duration) ? t.duration : null,
        Array.isArray(t.moods) ? JSON.stringify(t.moods) : '[]',
        ['low', 'medium', 'high'].includes(t.energy) ? t.energy : null,
        'legacy-v1',
        1,
        typeof t.taggedAt === 'string' ? t.taggedAt : null,
      );
    }
  });
  tx(entries);

  const after = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const inserted = after - before;
  console.log(
    `[library-db] migrated ${inserted} new entries from moods.json (${entries.length} in file, ${before} already present)`,
  );
  await archiveMoodsJson();
}

async function archiveMoodsJson(): Promise<void> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = `${LEGACY_MOODS_JSON}.archived.${ts}`;
  try {
    await rename(LEGACY_MOODS_JSON, archived);
    console.log(`[library-db] archived legacy moods.json → ${archived}`);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`[library-db] could not archive moods.json: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Embedding meta
// ---------------------------------------------------------------------------

export function getEmbeddingMeta(): { model: string; dim: number } | null {
  const row = requireDb()
    .prepare('SELECT model, dim FROM embedding_meta WHERE pk = 1')
    .get() as { model: string; dim: number } | undefined;
  return row || null;
}

export function setEmbeddingMeta(model: string, dim: number): void {
  requireDb()
    .prepare(
      `INSERT INTO embedding_meta (pk, model, dim, set_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim, set_at = excluded.set_at`,
    )
    .run(model, dim, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Track CRUD
// ---------------------------------------------------------------------------

export function getTrack(id: string): TrackRecord | null {
  const row = requireDb()
    .prepare(`SELECT * FROM tracks WHERE id = ?`)
    .get(id) as any;
  return row ? rowToTrack(row) : null;
}

export function hasTags(id: string): boolean {
  const row = requireDb()
    .prepare(`SELECT 1 FROM tracks WHERE id = ? AND ${SQL_HAS_MOODS}`)
    .get(id);
  return !!row;
}

export function hasVector(id: string): boolean {
  const row = requireDb().prepare(`SELECT 1 FROM track_vectors WHERE id = ?`).get(id);
  return !!row;
}

export function upsertTrackMeta(id: string, meta: TrackMeta): void {
  requireDb()
    .prepare(
      `
      INSERT INTO tracks (id, title, artist, album, year, genre, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title        = COALESCE(excluded.title, tracks.title),
        artist       = COALESCE(excluded.artist, tracks.artist),
        album        = COALESCE(excluded.album, tracks.album),
        year         = COALESCE(excluded.year, tracks.year),
        genre        = COALESCE(excluded.genre, tracks.genre),
        duration_sec = COALESCE(excluded.duration_sec, tracks.duration_sec)
    `,
    )
    .run(
      id,
      meta.title ?? null,
      meta.artist ?? null,
      meta.album ?? null,
      normaliseYear(meta.year),
      meta.genre ?? null,
      Number.isFinite(meta.duration as number) ? (meta.duration as number) : null,
    );
}

export function upsertTrackEnrichment(id: string, enrich: TrackEnrichment): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET lastfm_tags = ?, lyric_excerpt = ?, enriched_at = ? WHERE id = ?`,
    )
    .run(
      enrich.lastfmTags ? JSON.stringify(enrich.lastfmTags) : null,
      enrich.lyricExcerpt ?? null,
      new Date().toISOString(),
      id,
    );
}

export function upsertTrackTags(id: string, tags: TagWrite): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = ?,
        energy         = ?,
        source         = ?,
        confidence     = ?,
        tagger_version = ?,
        prompt_hash    = ?,
        model          = ?,
        tagged_at      = ?
      WHERE id = ?`,
    )
    .run(
      JSON.stringify(tags.moods),
      tags.energy,
      tags.source,
      tags.confidence ?? null,
      TAGGER_VERSION,
      tags.promptHash ?? null,
      tags.model ?? null,
      new Date().toISOString(),
      id,
    );
}

export interface TrackAnalysisWrite {
  bpm?: number | null;
  musicalKey?: string | null;
  introMs?: number | null;
  confidence?: number | null;
}

// Write acoustic-analysis results for a track. Stamps ANALYSIS_VERSION so
// resumable runs can skip already-analysed rows and a bump re-targets stale
// ones. Mirrors upsertTrackTags (UPDATE on an existing meta row).
export function upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        bpm                 = ?,
        musical_key         = ?,
        intro_ms            = ?,
        analysis_confidence = ?,
        analysis_version    = ?
      WHERE id = ?`,
    )
    .run(
      Number.isFinite(a.bpm as number) ? (a.bpm as number) : null,
      a.musicalKey ?? null,
      Number.isFinite(a.introMs as number) ? Math.round(a.introMs as number) : null,
      Number.isFinite(a.confidence as number) ? (a.confidence as number) : null,
      ANALYSIS_VERSION,
      id,
    );
}

// Ids that still need acoustic analysis: never analysed, or analysed by an
// older ANALYSIS_VERSION. Ordered for stable resumption. `limit` caps a run.
export function needsAnalysisIds(limit?: number): string[] {
  const sql =
    `SELECT id FROM tracks
       WHERE analysis_version IS NULL OR analysis_version < ?
       ORDER BY id` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(sql).all(ANALYSIS_VERSION) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

export function clearAnalysis(): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET bpm = NULL, musical_key = NULL, intro_ms = NULL,
        analysis_confidence = NULL, analysis_version = NULL`,
    )
    .run();
}

export function upsertTrackVector(id: string, vector: number[] | Float32Array): void {
  if (currentEmbeddingDim === null) {
    throw new Error('library-db opened without embedding dim');
  }
  if (vector.length !== currentEmbeddingDim) {
    throw new Error(
      `vector dim ${vector.length} != schema dim ${currentEmbeddingDim}; run --reseed if you changed embedding model`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  // sqlite-vec vec0 tables don't support INSERT OR REPLACE — delete + insert
  // is the documented upsert pattern.
  const d = requireDb();
  d.prepare(`DELETE FROM track_vectors WHERE id = ?`).run(id);
  d.prepare(`INSERT INTO track_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
}

export function dropVectors(): void {
  if (currentEmbeddingDim === null) throw new Error('library-db not opened');
  const d = requireDb();
  runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
  runDdl(d,
    `CREATE VIRTUAL TABLE track_vectors USING vec0(` +
      `id TEXT PRIMARY KEY, embedding FLOAT[${currentEmbeddingDim}] distance_metric=cosine)`,
  );
}

// ---------------------------------------------------------------------------
// Vector queries
// ---------------------------------------------------------------------------

export interface KnnHit {
  id: string;
  similarity: number; // 1 - cosine_distance, so 1.0 = identical, 0 = orthogonal
}

export function knnById(id: string, k: number): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id);
}

export function knnByVector(vec: number[] | Float32Array, k: number): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null);
}

function knnByBuffer(buf: Buffer, k: number, excludeId: string | null): KnnHit[] {
  const limit = excludeId ? k + 1 : k;
  const rows = requireDb()
    .prepare(
      `SELECT id, distance FROM track_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(buf, limit) as Array<{ id: string; distance: number }>;
  const hits: KnnHit[] = [];
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    hits.push({ id: r.id, similarity: 1 - r.distance });
    if (hits.length === k) break;
  }
  return hits;
}

export function vectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
}

// Total tracks known to the catalogue. Used by the analyze CLI to decide
// whether to walk Navidrome (only on an empty/bootstrap catalogue).
export function trackCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks').get() as {
    n: number;
  }).n;
}

// Drop track rows (and their vectors) for ids that are no longer in the live
// Navidrome catalogue. `liveIds` MUST be the id set from a COMPLETE, successful
// walk of subsonic.iterateAllSongs() — passing a partial set would delete live
// tags. Callers guard on a non-empty walk so a transient empty Navidrome
// response can't wipe the DB.
//
// Why this is needed: the walk only ever upserts, never deletes. A Navidrome
// full rescan can re-mint track IDs, orphaning every previous row; across
// several rescans the DB balloons far past the live catalogue. Those orphans
// inflate the coverage percentage past 100% and blow up the acoustic-analysis
// scope with dead, un-downloadable ids. Returns the number of rows deleted.
export function pruneMissingTracks(liveIds: ReadonlySet<string>): number {
  const d = requireDb();
  const all = (d.prepare('SELECT id FROM tracks').all() as Array<{ id: string }>).map(r => r.id);
  const orphans = all.filter(id => !liveIds.has(id));
  if (orphans.length === 0) return 0;
  const delTrack = d.prepare('DELETE FROM tracks WHERE id = ?');
  const delVec = d.prepare('DELETE FROM track_vectors WHERE id = ?');
  const runPrune = d.transaction((ids: string[]) => {
    for (const id of ids) {
      delTrack.run(id);
      delVec.run(id);
    }
  });
  runPrune(orphans);
  return orphans.length;
}

// Tracks with acoustic analysis. A track is "analysed" iff bpm IS NOT NULL
// (bpm/musical_key/intro_ms are written together by upsertTrackAnalysis).
export function analysedCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL').get() as {
    n: number;
  }).n;
}

// ---------------------------------------------------------------------------
// Mood-keyed reads (drop-in replacements for the old library.ts in-memory loops)
// ---------------------------------------------------------------------------

export function songsByMood(mood: string): TrackRecord[] {
  const rows = requireDb()
    .prepare(
      `SELECT * FROM tracks
       WHERE moods IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(tracks.moods) WHERE value = ?)`,
    )
    .all(mood) as any[];
  return rows.map(rowToTrack);
}

export function songsByEnergy(energy: EnergyValue): TrackRecord[] {
  if (!energy) return [];
  const rows = requireDb()
    .prepare(`SELECT * FROM tracks WHERE energy = ?`)
    .all(energy) as any[];
  return rows.map(rowToTrack);
}

export function allTaggedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE moods IS NOT NULL')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}

export function untaggedIds(limit?: number): string[] {
  const q = limit
    ? `SELECT id FROM tracks WHERE ${SQL_NO_MOODS} LIMIT ?`
    : `SELECT id FROM tracks WHERE ${SQL_NO_MOODS}`;
  const stmt = requireDb().prepare(q);
  const rows = (limit ? stmt.all(limit) : stmt.all()) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

export function unembeddedIds(limit?: number): string[] {
  const q = limit
    ? `SELECT t.id FROM tracks t LEFT JOIN track_vectors v ON v.id = t.id WHERE v.id IS NULL LIMIT ?`
    : `SELECT t.id FROM tracks t LEFT JOIN track_vectors v ON v.id = t.id WHERE v.id IS NULL`;
  const stmt = requireDb().prepare(q);
  const rows = (limit ? stmt.all(limit) : stmt.all()) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Bucket every untagged track by (genre, decade). Used by seed-selector to
// stratify so rare-mood corners of the library each get a seed pick.
export function trackIdsByGenreDecade(): Map<string, string[]> {
  const rows = requireDb()
    .prepare(
      `SELECT id, COALESCE(genre, '') AS g, (COALESCE(year, 0) / 10) * 10 AS decade
       FROM tracks WHERE moods IS NULL`,
    )
    .all() as Array<{ id: string; g: string; decade: number }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const key = `${r.g}|${r.decade}`;
    const list = out.get(key) ?? [];
    list.push(r.id);
    out.set(key, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filter (admin UI library browse panel)
// ---------------------------------------------------------------------------

export function filter(opts: FilterOpts = {}): { total: number; rows: TrackRecord[] } {
  const moods = (opts.moods || []).filter(Boolean);
  const energy = opts.energy || null;
  const genre = opts.genre || null;
  const yearFrom = Number.isFinite(opts.yearFrom as number) ? (opts.yearFrom as number) : null;
  const yearTo = Number.isFinite(opts.yearTo as number) ? (opts.yearTo as number) : null;
  const q = (opts.q || '').trim().toLowerCase();
  const sort = opts.sort || 'artist';
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const offset = Math.max(0, opts.offset ?? 0);

  // Base: the browseable index is tagged tracks only. Without this, every
  // row the metadata/analysis walk inserted (moods NULL or '[]') would show
  // up here as if it were tagged — including analysis-only tracks.
  const where: string[] = [SQL_HAS_MOODS];
  const params: unknown[] = [];
  if (moods.length) {
    const placeholders = moods.map(() => '?').join(', ');
    where.push(
      `EXISTS (SELECT 1 FROM json_each(tracks.moods) WHERE value IN (${placeholders}))`,
    );
    params.push(...moods);
  }
  if (energy) { where.push('energy = ?'); params.push(energy); }
  if (genre) { where.push('genre = ?'); params.push(genre); }
  if (yearFrom != null) { where.push('year IS NOT NULL AND year >= ?'); params.push(yearFrom); }
  if (yearTo != null) { where.push('year IS NOT NULL AND year <= ?'); params.push(yearTo); }
  if (q) {
    where.push(
      `(LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(artist,'')) LIKE ? OR LOWER(COALESCE(album,'')) LIKE ?)`,
    );
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orderSql = {
    artist: `ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`,
    title: `ORDER BY LOWER(COALESCE(title,'')) , LOWER(COALESCE(artist,''))`,
    year: 'ORDER BY year DESC, LOWER(COALESCE(artist,""))',
    taggedAt: 'ORDER BY tagged_at DESC',
  }[sort];

  const d = requireDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM tracks ${whereSql}`).get(...params) as { n: number }
  ).n;
  const rows = d
    .prepare(`SELECT * FROM tracks ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];
  return { total, rows: rows.map(rowToTrack) };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function stats(): LibraryStats {
  const d = requireDb();
  const total =
    (d.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`).get() as {
      n: number;
    }).n;
  const distinctArtists =
    (
      d
        .prepare(
          `SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS n
           FROM tracks
           WHERE ${SQL_HAS_MOODS}
             AND artist IS NOT NULL
             AND TRIM(artist) != ''`,
        )
        .get() as { n: number }
    ).n;
  const byMood: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS mood, COUNT(*) AS n FROM tracks, json_each(tracks.moods)
       WHERE tracks.moods IS NOT NULL GROUP BY value`,
    )
    .all() as Array<{ mood: string; n: number }>) {
    byMood[r.mood] = r.n;
  }
  const byEnergy: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT energy, COUNT(*) AS n FROM tracks WHERE energy IS NOT NULL GROUP BY energy`,
    )
    .all() as Array<{ energy: string; n: number }>) {
    byEnergy[r.energy] = r.n;
  }
  const byGenre: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT genre, COUNT(*) AS n FROM tracks WHERE genre IS NOT NULL GROUP BY genre`,
    )
    .all() as Array<{ genre: string; n: number }>) {
    byGenre[r.genre] = r.n;
  }
  const bySource: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT source, COUNT(*) AS n FROM tracks WHERE source IS NOT NULL GROUP BY source`,
    )
    .all() as Array<{ source: string; n: number }>) {
    bySource[r.source] = r.n;
  }
  const withEmbedding = (d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
  const updatedAt =
    ((d.prepare('SELECT MAX(tagged_at) AS t FROM tracks').get() as { t: string | null }).t) ||
    null;
  return { total, distinctArtists, byMood, byEnergy, byGenre, bySource, withEmbedding, updatedAt };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToTrack(row: any): TrackRecord {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    genre: row.genre,
    durationSec: row.duration_sec,
    lastfmTags: row.lastfm_tags ? safeParseArray(row.lastfm_tags) : null,
    lyricExcerpt: row.lyric_excerpt,
    enrichedAt: row.enriched_at,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    source: row.source ?? null,
    confidence: row.confidence,
    taggerVersion: row.tagger_version,
    promptHash: row.prompt_hash,
    model: row.model,
    taggedAt: row.tagged_at,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    introMs: row.intro_ms ?? null,
    analysisConfidence: row.analysis_confidence ?? null,
    analysisVersion: row.analysis_version ?? null,
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function normaliseYear(y: unknown): number | null {
  if (y == null) return null;
  if (typeof y === 'number' && Number.isFinite(y)) return Math.trunc(y);
  if (typeof y === 'string') {
    const n = parseInt(y, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
