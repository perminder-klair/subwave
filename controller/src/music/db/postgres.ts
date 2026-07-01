// PostgresAdapter — full Postgres + pgvector implementation of LibraryDbAdapter.
//
// Uses the `postgres` npm package (porsager/postgres) with tagged template
// literals for safe, type-inferred queries. Vectors are stored in pgvector
// `vector(N)` columns and queried with the cosine-distance `<=>` operator.
//
// Schema notes vs SQLite:
//   • All JSON columns (moods, lastfm_tags, *_json) are JSONB — Postgres
//     returns them already parsed; we never call JSON.parse() in this adapter.
//   • The sqlite-vec `PRAGMA user_version` migration gate becomes a
//     `schema_migrations(version INT)` table.
//   • `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`.
//   • `json_each` / `json_array_length` → `jsonb_array_elements_text` /
//     `jsonb_array_length`.
//   • `IS NOT ?` (SQLite null-safe ≠) → `IS DISTINCT FROM $n`.
//   • Vectors: Float32Array ↔ '[x,y,z,...]' string, cast as `::vector` in SQL.
//
// backup() and restoreFromFile() are no-ops with a console.warn — pg has its
// own tooling (pg_dump / pg_restore) and these operations don't translate to
// a single-file model.

import postgres from 'postgres';
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
import {
  TAGGER_VERSION,
  ANALYSIS_VERSION,
  AUDIO_EMBEDDING_DIM,
} from '../library-db-core.js';
import type { TrackKeyRange, TrackSection, TrackPaceSpan } from '../library-db-core.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert a Float32Array / number[] to the pgvector literal '[x,y,z,...]'. */
function vecToString(vec: number[] | Float32Array): string {
  return '[' + Array.from(vec).join(',') + ']';
}

/** Parse a pgvector literal '[x,y,z,...]' back to a Float32Array. */
function vecFromString(s: string): Float32Array {
  const nums = s.replace(/^\[|\]$/g, '').split(',').map(Number);
  return new Float32Array(nums);
}

/** Row-to-TrackRecord projection for Postgres rows (JSONB columns come back
 *  as already-parsed JS values; no JSON.parse() needed). */
function rowToTrack(row: Record<string, any>): TrackRecord {
  return {
    id: row['id'],
    title: row['title'] ?? null,
    artist: row['artist'] ?? null,
    album: row['album'] ?? null,
    year: row['year'] ?? null,
    genre: row['genre'] ?? null,
    durationSec: row['duration_sec'] ?? null,
    // lastfm_tags is JSONB — already an array or null
    lastfmTags: row['lastfm_tags'] ?? null,
    lyricExcerpt: row['lyric_excerpt'] ?? null,
    enrichedAt: row['enriched_at'] ?? null,
    // moods is JSONB — already an array; fall back to []
    moods: Array.isArray(row['moods']) ? (row['moods'] as string[]) : [],
    energy: row['energy'] ?? null,
    source: row['source'] ?? null,
    confidence: row['confidence'] ?? null,
    taggerVersion: row['tagger_version'] ?? null,
    promptHash: row['prompt_hash'] ?? null,
    model: row['model'] ?? null,
    taggedAt: row['tagged_at'] ?? null,
    bpm: row['bpm'] ?? null,
    musicalKey: row['musical_key'] ?? null,
    introMs: row['intro_ms'] ?? null,
    analysisConfidence: row['analysis_confidence'] ?? null,
    analysisVersion: row['analysis_version'] ?? null,
    loudnessLufs: row['loudness_lufs'] ?? null,
    peakDb: row['peak_db'] ?? null,
    // structure_json, vocal_ranges_json, etc. are JSONB (already parsed).
    // Run the same validators that the SQLite adapter applies to its TEXT
    // columns so both adapters return identical, sanitised TrackRecord values.
    structure: row['structure_json'] != null ? safeParseSectionsPg(row['structure_json']) : null,
    // null = not computed, [] = instrumental (parseSpansPg preserves []).
    vocalRanges:
      row['vocal_ranges_json'] !== null && row['vocal_ranges_json'] !== undefined
        ? parseSpansPg(row['vocal_ranges_json'])
        : null,
    pace: row['pace_json'] != null ? parsePaceSpansPg(row['pace_json']) : null,
    beats: row['beats_json'] != null ? parseMsArrayPg(row['beats_json']) : null,
    bars: row['bars_json'] != null ? parseMsArrayPg(row['bars_json']) : null,
    keyRanges: row['key_ranges_json'] != null ? parseKeyRangesPg(row['key_ranges_json']) : null,
  };
}

// ---------------------------------------------------------------------------
// JSONB validators — mirror the SQLite parse helpers in library-db-core.ts.
// Postgres returns JSONB columns as already-parsed JS values (not strings),
// so these take `unknown` rather than `string`.
// ---------------------------------------------------------------------------

function parseKeyRangesPg(v: unknown): TrackKeyRange[] | null {
  if (!Array.isArray(v)) return null;
  const out: TrackKeyRange[] = [];
  for (const x of v) {
    const startMs = Number((x as any)?.startMs);
    const endMs = Number((x as any)?.endMs);
    const tonic = (x as any)?.tonic;
    const mode = (x as any)?.mode;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    if (typeof tonic !== 'string' || (mode !== 'major' && mode !== 'minor')) continue;
    out.push({ startMs, endMs, tonic, mode });
  }
  return out.length ? out : null;
}

function parseMsArrayPg(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return out.length ? out : null;
}

function parsePaceSpansPg(v: unknown): TrackPaceSpan[] | null {
  if (!Array.isArray(v)) return null;
  const out: TrackPaceSpan[] = [];
  for (const x of v) {
    const startMs = Number((x as any)?.startMs);
    const endMs = Number((x as any)?.endMs);
    const value = Number((x as any)?.value);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(value) || endMs <= startMs) continue;
    out.push({ startMs, endMs, value });
  }
  return out.length ? out : null;
}

function parseSpansPg(v: unknown): TrackSection[] {
  if (!Array.isArray(v)) return [];
  const out: TrackSection[] = [];
  for (const x of v) {
    const startMs = Number((x as any)?.startMs);
    const endMs = Number((x as any)?.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const kind = typeof (x as any)?.kind === 'string' ? (x as any).kind : undefined;
    out.push(kind ? { startMs, endMs, kind } : { startMs, endMs });
  }
  return out;
}

function safeParseSectionsPg(v: unknown): TrackSection[] | null {
  const out = parseSpansPg(v);
  return out.length ? out : null;
}

/** Normalise year: number/string → integer or null. */
function normaliseYear(y: unknown): number | null {
  if (y == null) return null;
  if (typeof y === 'number' && Number.isFinite(y)) return Math.trunc(y);
  if (typeof y === 'string') {
    const n = parseInt(y, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// SQL fragment constants — Postgres JSONB equivalents of the SQLite
// json_array_length() patterns used throughout library-db-core.ts.
const SQL_HAS_MOODS =
  `moods IS NOT NULL AND jsonb_array_length(moods) > 0` as const;
const SQL_NO_MOODS =
  `(moods IS NULL OR jsonb_array_length(moods) = 0)` as const;

// ---------------------------------------------------------------------------
// PostgresAdapter
// ---------------------------------------------------------------------------

export class PostgresAdapter implements LibraryDbAdapter {
  private readonly _connStr: string;
  private _sql: ReturnType<typeof postgres> | null = null;
  private _opened = false;
  private _embeddingDim: number | null = null;

  constructor(connectionString: string) {
    this._connStr = connectionString;
  }

  private get sql(): ReturnType<typeof postgres> {
    if (!this._sql) throw new Error('PostgresAdapter not opened — call open() first');
    return this._sql;
  }

  // ---- Lifecycle -----------------------------------------------------------

  async open(opts: {
    embeddingDim: number;
    reseed?: boolean;
    adoptStoredDim?: boolean;
  }): Promise<number> {
    if (this._opened) {
      if (!opts.adoptStoredDim && opts.embeddingDim !== this._embeddingDim) {
        throw new Error(
          `PostgresAdapter already open with embedding dim ${this._embeddingDim}; ` +
            `caller asked for ${opts.embeddingDim}. Use --reseed to switch models.`,
        );
      }
      return this._embeddingDim!;
    }

    this._sql = postgres(this._connStr, { types: {} });

    try {
      await this._migrate();

      const effectiveDim = await this._initVectorTables(
        opts.embeddingDim,
        opts.reseed === true,
        opts.adoptStoredDim === true,
      );

      this._embeddingDim = effectiveDim;
      this._opened = true;
      return effectiveDim;
    } catch (err) {
      // Release the connection pool so callers can retry without leaking
      // connections on repeated open() failures (e.g. PG not ready yet).
      await this._sql.end().catch(() => {});
      this._sql = null;
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this._sql) {
      await this._sql.end();
      this._sql = null;
    }
    this._opened = false;
    this._embeddingDim = null;
  }

  isOpen(): boolean {
    return this._opened;
  }

  async backup(destPath: string): Promise<void> {
    console.warn(
      `[postgres-adapter] backup() is not supported with Postgres. ` +
        `Use pg_dump instead. Destination path (ignored): ${destPath}`,
    );
  }

  async restoreFromFile(srcPath: string): Promise<void> {
    console.warn(
      `[postgres-adapter] restoreFromFile() is not supported with Postgres. ` +
        `Use pg_restore instead. Source path (ignored): ${srcPath}`,
    );
  }

  // ---- Schema migrations ---------------------------------------------------

  private async _migrate(): Promise<void> {
    const sql = this.sql;

    // These are idempotent and run outside the transaction so they're
    // available when the advisory-locked block below reads the version.
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`;

    // Advisory lock prevents two processes starting simultaneously from racing
    // on the version check + DDL. Without it both see userVersion = 0 and both
    // try INSERT INTO schema_migrations VALUES (1), causing a PK violation.
    await sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('subwave_schema_migration'))`;

      const [vRow] = await sql<[{ max: number | null }]>`
        SELECT MAX(version) AS max FROM schema_migrations
      `;
      const userVersion = vRow?.max ?? 0;

      if (userVersion < 1) {
        await sql`
          CREATE TABLE IF NOT EXISTS tracks (
            id                TEXT PRIMARY KEY,
            title             TEXT,
            artist            TEXT,
            album             TEXT,
            year              INTEGER,
            genre             TEXT,
            duration_sec      INTEGER,
            lastfm_tags       JSONB,
            lyric_excerpt     TEXT,
            enriched_at       TEXT,
            moods             JSONB,
            energy            TEXT CHECK (energy IN ('low','medium','high') OR energy IS NULL),
            source            TEXT,
            confidence        REAL,
            tagger_version    INTEGER,
            prompt_hash       TEXT,
            model             TEXT,
            tagged_at         TEXT
          )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_tracks_genre  ON tracks(genre)`;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_tracks_tagged
            ON tracks(tagger_version, prompt_hash, model)
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS embedding_meta (
            pk      INTEGER PRIMARY KEY DEFAULT 1 CHECK (pk = 1),
            model   TEXT NOT NULL,
            dim     INTEGER NOT NULL,
            set_at  TEXT NOT NULL
          )
        `;
        await sql`INSERT INTO schema_migrations VALUES (1)`;
      }

      if (userVersion < 2) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bpm                 REAL`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS musical_key         TEXT`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS intro_ms            INTEGER`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS analysis_confidence REAL`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS analysis_version    INTEGER`;
        await sql`
          CREATE INDEX IF NOT EXISTS idx_tracks_analysis ON tracks(analysis_version)
        `;
        await sql`INSERT INTO schema_migrations VALUES (2)`;
      }

      if (userVersion < 3) {
        await sql`
          CREATE TABLE IF NOT EXISTS audio_embedding_meta (
            pk      INTEGER PRIMARY KEY DEFAULT 1 CHECK (pk = 1),
            model   TEXT NOT NULL,
            dim     INTEGER NOT NULL,
            set_at  TEXT NOT NULL
          )
        `;
        await sql`INSERT INTO schema_migrations VALUES (3)`;
      }

      if (userVersion < 4) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS loudness_lufs REAL`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS peak_db       REAL`;
        await sql`INSERT INTO schema_migrations VALUES (4)`;
      }

      if (userVersion < 5) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS structure_json JSONB`;
        await sql`INSERT INTO schema_migrations VALUES (5)`;
      }

      if (userVersion < 6) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS vocal_ranges_json JSONB`;
        await sql`INSERT INTO schema_migrations VALUES (6)`;
      }

      if (userVersion < 7) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS pace_json JSONB`;
        await sql`INSERT INTO schema_migrations VALUES (7)`;
      }

      if (userVersion < 8) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS beats_json JSONB`;
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS bars_json  JSONB`;
        await sql`INSERT INTO schema_migrations VALUES (8)`;
      }

      if (userVersion < 9) {
        await sql`ALTER TABLE tracks ADD COLUMN IF NOT EXISTS key_ranges_json JSONB`;
        await sql`INSERT INTO schema_migrations VALUES (9)`;
      }
    });
  }

  /** Create or reseed the pgvector tables; returns the effective embedding dim. */
  private async _initVectorTables(
    embeddingDim: number,
    reseed: boolean,
    adoptStoredDim: boolean,
  ): Promise<number> {
    if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
      throw new Error(
        `Invalid embeddingDim ${embeddingDim}: must be a positive integer`,
      );
    }
    const sql = this.sql;

    const [meta] = await sql<[{ model: string; dim: number } | undefined]>`
      SELECT model, dim FROM embedding_meta WHERE pk = 1
    `;

    let effectiveDim = embeddingDim;
    if (meta && meta.dim !== embeddingDim) {
      if (adoptStoredDim) {
        console.warn(
          `[postgres-adapter] adopting stored embedding dim ${meta.dim} ` +
            `(model: ${meta.model}); caller requested ${embeddingDim}. ` +
            `Re-tag with --reseed to switch models.`,
        );
        effectiveDim = meta.dim;
      } else if (!reseed) {
        throw new Error(
          `embedding dim mismatch: Postgres has ${meta.dim}-d vectors ` +
            `(model: ${meta.model}), but settings ask for ${embeddingDim}-d. ` +
            `Run \`npm run tag -- --reseed\` to re-embed.`,
        );
      } else {
        console.warn(
          `[postgres-adapter] reseed: embedding dim ${meta.dim}→${embeddingDim} ` +
            `(model: ${meta.model}); dropping vectors for re-embed`,
        );
        await sql`DROP TABLE IF EXISTS track_vectors`;
        await sql`DELETE FROM embedding_meta WHERE pk = 1`;
      }
    }

    // Create the text-embedding vector table if it doesn't exist.
    // We store the dim in the column type — if the table already exists with a
    // different dim (stale from a partial migration) the ALTER would fail,
    // which is intentional: require --reseed in that case.
    const [tvRow] = await sql<[{ exists: boolean }]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'track_vectors'
      ) AS exists
    `;
    if (!tvRow.exists) {
      await sql.unsafe(`
        CREATE TABLE track_vectors (
          id        TEXT PRIMARY KEY,
          embedding vector(${effectiveDim}) NOT NULL
        )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_track_vectors_embedding
          ON track_vectors USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100)
      `);
    }

    // Audio-vector table — fixed at AUDIO_EMBEDDING_DIM (CLAP).
    const [avRow] = await sql<[{ exists: boolean }]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'track_audio_vectors'
      ) AS exists
    `;
    if (!avRow.exists) {
      await sql.unsafe(`
        CREATE TABLE track_audio_vectors (
          id        TEXT PRIMARY KEY,
          embedding vector(${AUDIO_EMBEDDING_DIM}) NOT NULL
        )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_track_audio_vectors_embedding
          ON track_audio_vectors USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100)
      `);
    }

    return effectiveDim;
  }

  // ---- Embedding meta ------------------------------------------------------

  async getEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
    const [row] = await this.sql<[{ model: string; dim: number } | undefined]>`
      SELECT model, dim FROM embedding_meta WHERE pk = 1
    `;
    return row ?? null;
  }

  async setEmbeddingMeta(model: string, dim: number): Promise<void> {
    await this.sql`
      INSERT INTO embedding_meta (pk, model, dim, set_at) VALUES (1, ${model}, ${dim}, ${new Date().toISOString()})
      ON CONFLICT (pk) DO UPDATE SET model = EXCLUDED.model, dim = EXCLUDED.dim, set_at = EXCLUDED.set_at
    `;
  }

  async getAudioEmbeddingMeta(): Promise<{ model: string; dim: number } | null> {
    const [row] = await this.sql<[{ model: string; dim: number } | undefined]>`
      SELECT model, dim FROM audio_embedding_meta WHERE pk = 1
    `;
    return row ?? null;
  }

  async setAudioEmbeddingMeta(model: string, dim: number): Promise<void> {
    await this.sql`
      INSERT INTO audio_embedding_meta (pk, model, dim, set_at) VALUES (1, ${model}, ${dim}, ${new Date().toISOString()})
      ON CONFLICT (pk) DO UPDATE SET model = EXCLUDED.model, dim = EXCLUDED.dim, set_at = EXCLUDED.set_at
    `;
  }

  // ---- Track CRUD ----------------------------------------------------------

  async getTrack(id: string): Promise<TrackRecord | null> {
    const [row] = await this.sql`SELECT * FROM tracks WHERE id = ${id}`;
    return row ? rowToTrack(row) : null;
  }

  async hasTags(id: string): Promise<boolean> {
    const [row] = await this.sql.unsafe(
      `SELECT 1 FROM tracks WHERE id = $1 AND ${SQL_HAS_MOODS}`,
      [id],
    );
    return !!row;
  }

  async hasVector(id: string): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 FROM track_vectors WHERE id = ${id}`;
    return !!row;
  }

  async upsertTrackMeta(id: string, meta: TrackMeta): Promise<void> {
    const year = normaliseYear(meta.year);
    const dur = Number.isFinite(meta.duration as number) ? (meta.duration as number) : null;
    await this.sql`
      INSERT INTO tracks (id, title, artist, album, year, genre, duration_sec)
      VALUES (${id}, ${meta.title ?? null}, ${meta.artist ?? null}, ${meta.album ?? null},
              ${year}, ${meta.genre ?? null}, ${dur})
      ON CONFLICT (id) DO UPDATE SET
        title        = COALESCE(EXCLUDED.title,        tracks.title),
        artist       = COALESCE(EXCLUDED.artist,       tracks.artist),
        album        = COALESCE(EXCLUDED.album,        tracks.album),
        year         = COALESCE(EXCLUDED.year,         tracks.year),
        genre        = COALESCE(EXCLUDED.genre,        tracks.genre),
        duration_sec = COALESCE(EXCLUDED.duration_sec, tracks.duration_sec)
    `;
  }

  async upsertTrackEnrichment(id: string, enrich: TrackEnrichment): Promise<void> {
    // lastfm_tags is JSONB — pass the array directly; postgres serialises it.
    const tags = enrich.lastfmTags ?? null;
    await this.sql`
      UPDATE tracks SET
        lastfm_tags   = ${tags as any},
        lyric_excerpt = ${enrich.lyricExcerpt ?? null},
        enriched_at   = ${new Date().toISOString()}
      WHERE id = ${id}
    `;
  }

  async upsertTrackTags(id: string, tags: TagWrite): Promise<void> {
    // moods is JSONB — pass the array directly.
    await this.sql`
      UPDATE tracks SET
        moods          = ${tags.moods as any},
        energy         = ${tags.energy ?? null},
        source         = ${tags.source},
        confidence     = ${tags.confidence ?? null},
        tagger_version = ${TAGGER_VERSION},
        prompt_hash    = ${tags.promptHash ?? null},
        model          = ${tags.model ?? null},
        tagged_at      = ${new Date().toISOString()}
      WHERE id = ${id}
    `;
  }

  async clearTrackTags(id: string): Promise<void> {
    await this.sql`
      UPDATE tracks SET
        moods          = NULL,
        energy         = NULL,
        source         = NULL,
        confidence     = NULL,
        tagger_version = NULL,
        prompt_hash    = NULL,
        model          = NULL,
        tagged_at      = NULL
      WHERE id = ${id}
    `;
  }

  async upsertTrackAnalysis(id: string, a: TrackAnalysisWrite): Promise<void> {
    const bpm = Number.isFinite(a.bpm as number) ? (a.bpm as number) : null;
    const introMs = Number.isFinite(a.introMs as number) ? Math.round(a.introMs as number) : null;
    const confidence = Number.isFinite(a.confidence as number) ? (a.confidence as number) : null;
    const lufs = Number.isFinite(a.loudnessLufs as number) ? (a.loudnessLufs as number) : null;
    const peak = Number.isFinite(a.peakDb as number) ? (a.peakDb as number) : null;
    // JSON columns: pass arrays/null directly; postgres serialises to JSONB.
    const sections = (a.sections && a.sections.length) ? a.sections : null;
    const pace = (a.pace && a.pace.length) ? a.pace : null;
    const beats = (a.beats && a.beats.length) ? a.beats : null;
    const bars = (a.bars && a.bars.length) ? a.bars : null;
    const keyRanges = (a.keyRanges && a.keyRanges.length) ? a.keyRanges : null;
    // vocalRanges: null means "don't touch existing column" (COALESCE pattern).
    // An explicit array (including []) overwrites the column.
    const vocalVal = a.vocalRanges != null ? a.vocalRanges : null;

    await this.sql`
      UPDATE tracks SET
        bpm                 = ${bpm},
        musical_key         = ${a.musicalKey ?? null},
        intro_ms            = ${introMs},
        analysis_confidence = ${confidence},
        loudness_lufs       = ${lufs},
        peak_db             = ${peak},
        structure_json      = ${sections as any},
        pace_json           = ${pace as any},
        beats_json          = ${beats as any},
        bars_json           = ${bars as any},
        key_ranges_json     = ${keyRanges as any},
        vocal_ranges_json   = COALESCE(${vocalVal as any}, vocal_ranges_json),
        analysis_version    = ${ANALYSIS_VERSION}
      WHERE id = ${id}
    `;
  }

  async needsAnalysisIds(limit?: number): Promise<string[]> {
    const rows = limit && limit > 0
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM tracks
          WHERE analysis_version IS NULL OR analysis_version < ${ANALYSIS_VERSION}
          ORDER BY id
          LIMIT ${Math.floor(limit)}
        `
      : await this.sql<{ id: string }[]>`
          SELECT id FROM tracks
          WHERE analysis_version IS NULL OR analysis_version < ${ANALYSIS_VERSION}
          ORDER BY id
        `;
    return rows.map(r => r.id);
  }

  async clearAnalysis(opts: { keepVocal?: boolean } = {}): Promise<void> {
    if (opts.keepVocal) {
      await this.sql`
        UPDATE tracks SET
          bpm = NULL, musical_key = NULL, intro_ms = NULL,
          analysis_confidence = NULL, loudness_lufs = NULL, peak_db = NULL,
          structure_json = NULL, pace_json = NULL, beats_json = NULL,
          bars_json = NULL, key_ranges_json = NULL, analysis_version = NULL
      `;
    } else {
      await this.sql`
        UPDATE tracks SET
          bpm = NULL, musical_key = NULL, intro_ms = NULL,
          analysis_confidence = NULL, loudness_lufs = NULL, peak_db = NULL,
          structure_json = NULL, pace_json = NULL, beats_json = NULL,
          bars_json = NULL, key_ranges_json = NULL, vocal_ranges_json = NULL,
          analysis_version = NULL
      `;
    }
    await this.sql`DELETE FROM track_audio_vectors`;
  }

  // ---- Vector CRUD ---------------------------------------------------------

  async upsertTrackVector(id: string, vector: number[] | Float32Array): Promise<void> {
    if (this._embeddingDim === null) {
      throw new Error('PostgresAdapter opened without embedding dim');
    }
    if (vector.length !== this._embeddingDim) {
      throw new Error(
        `vector dim ${vector.length} != schema dim ${this._embeddingDim}; ` +
          `run --reseed if you changed embedding model`,
      );
    }
    const vecStr = vecToString(vector);
    await this.sql.unsafe(
      `INSERT INTO track_vectors (id, embedding) VALUES ($1, $2::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [id, vecStr],
    );
  }

  async dropVectors(): Promise<void> {
    if (this._embeddingDim === null) throw new Error('PostgresAdapter not opened');
    const dim = this._embeddingDim;
    await this.sql`DROP TABLE IF EXISTS track_vectors`;
    await this.sql.unsafe(`
      CREATE TABLE track_vectors (
        id        TEXT PRIMARY KEY,
        embedding vector(${dim}) NOT NULL
      )
    `);
    await this.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_track_vectors_embedding
        ON track_vectors USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);
  }

  async upsertTrackAudioVector(id: string, vector: number[] | Float32Array): Promise<void> {
    if (vector.length !== AUDIO_EMBEDDING_DIM) {
      throw new Error(
        `audio vector dim ${vector.length} != ${AUDIO_EMBEDDING_DIM} (CLAP); ` +
          `check CLAP_MODEL / the analyzer's audio_embedding output`,
      );
    }
    const vecStr = vecToString(vector);
    await this.sql.unsafe(
      `INSERT INTO track_audio_vectors (id, embedding) VALUES ($1, $2::vector)
       ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [id, vecStr],
    );
  }

  async dropAudioVectors(): Promise<void> {
    await this.sql`DROP TABLE IF EXISTS track_audio_vectors`;
    await this.sql.unsafe(`
      CREATE TABLE track_audio_vectors (
        id        TEXT PRIMARY KEY,
        embedding vector(${AUDIO_EMBEDDING_DIM}) NOT NULL
      )
    `);
    await this.sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_track_audio_vectors_embedding
        ON track_audio_vectors USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    `);
  }

  // ---- Vector queries ------------------------------------------------------

  async knnById(id: string, k: number): Promise<KnnHit[]> {
    const [row] = await this.sql<[{ embedding: string } | undefined]>`
      SELECT embedding::text FROM track_vectors WHERE id = ${id}
    `;
    if (!row) return [];
    return this._knnByVecStr(row.embedding, k, id, 'track_vectors');
  }

  async knnByVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]> {
    return this._knnByVecStr(vecToString(vec), k, null, 'track_vectors');
  }

  async knnAudioById(id: string, k: number): Promise<KnnHit[]> {
    const [row] = await this.sql<[{ embedding: string } | undefined]>`
      SELECT embedding::text FROM track_audio_vectors WHERE id = ${id}
    `;
    if (!row) return [];
    return this._knnByVecStr(row.embedding, k, id, 'track_audio_vectors');
  }

  async knnByAudioVector(vec: number[] | Float32Array, k: number): Promise<KnnHit[]> {
    return this._knnByVecStr(vecToString(vec), k, null, 'track_audio_vectors');
  }

  /** Inner KNN helper — runs the cosine-distance query against `table`. */
  private async _knnByVecStr(
    vecStr: string,
    k: number,
    excludeId: string | null,
    table: 'track_vectors' | 'track_audio_vectors',
  ): Promise<KnnHit[]> {
    // Fetch k+1 when excluding a seed so we can drop it and still return k hits.
    const limit = excludeId ? k + 1 : k;
    // `table` is always a hardcoded name from our own code (never user input).
    const rows = await this.sql.unsafe<{ id: string; distance: number }[]>(
      `SELECT id, (embedding <=> $1::vector) AS distance
       FROM ${table}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vecStr, limit],
    );
    const hits: KnnHit[] = [];
    for (const r of rows) {
      if (excludeId && r.id === excludeId) continue;
      hits.push({ id: r.id, similarity: 1 - r.distance });
      if (hits.length === k) break;
    }
    return hits;
  }

  async vectorCount(): Promise<number> {
    const [r] = await this.sql<[{ n: string }]>`SELECT COUNT(*) AS n FROM track_vectors`;
    return Number(r.n);
  }

  async hasAudioVector(id: string): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 FROM track_audio_vectors WHERE id = ${id}`;
    return !!row;
  }

  async getVector(id: string): Promise<Float32Array | null> {
    const [row] = await this.sql<[{ embedding: string } | undefined]>`
      SELECT embedding::text FROM track_vectors WHERE id = ${id}
    `;
    return row ? vecFromString(row.embedding) : null;
  }

  async getAudioVector(id: string): Promise<Float32Array | null> {
    const [row] = await this.sql<[{ embedding: string } | undefined]>`
      SELECT embedding::text FROM track_audio_vectors WHERE id = ${id}
    `;
    return row ? vecFromString(row.embedding) : null;
  }

  async audioVectorCount(): Promise<number> {
    const [r] = await this.sql<[{ n: string }]>`
      SELECT COUNT(*) AS n FROM track_audio_vectors
    `;
    return Number(r.n);
  }

  async vocalAnalyzedCount(): Promise<number> {
    const [r] = await this.sql<[{ n: string }]>`
      SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL
    `;
    return Number(r.n);
  }

  async unanalysedAudioIds(limit?: number): Promise<string[]> {
    const rows = limit && limit > 0
      ? await this.sql<{ id: string }[]>`
          SELECT t.id FROM tracks t
          LEFT JOIN track_audio_vectors v ON v.id = t.id
          WHERE v.id IS NULL ORDER BY t.id LIMIT ${Math.floor(limit)}
        `
      : await this.sql<{ id: string }[]>`
          SELECT t.id FROM tracks t
          LEFT JOIN track_audio_vectors v ON v.id = t.id
          WHERE v.id IS NULL ORDER BY t.id
        `;
    return rows.map(r => r.id);
  }

  async needsVocalIds(limit?: number): Promise<string[]> {
    const rows = limit && limit > 0
      ? await this.sql<{ id: string }[]>`
          SELECT id FROM tracks WHERE vocal_ranges_json IS NULL ORDER BY id
          LIMIT ${Math.floor(limit)}
        `
      : await this.sql<{ id: string }[]>`
          SELECT id FROM tracks WHERE vocal_ranges_json IS NULL ORDER BY id
        `;
    return rows.map(r => r.id);
  }

  // ---- Bulk reads ----------------------------------------------------------

  async trackCount(): Promise<number> {
    const [r] = await this.sql<[{ n: string }]>`SELECT COUNT(*) AS n FROM tracks`;
    return Number(r.n);
  }

  async pruneMissingTracks(liveIds: ReadonlySet<string>): Promise<number> {
    // Fetch all known ids, find orphans in JS (same approach as SQLite), then
    // delete in bulk with ANY($1::text[]).
    const allRows = await this.sql<{ id: string }[]>`SELECT id FROM tracks`;
    const allIds = allRows.map(r => r.id);
    const orphans = allIds.filter(id => !liveIds.has(id));
    if (orphans.length === 0) return 0;

    // Wrap in a transaction so a mid-delete crash can't leave track_vectors /
    // track_audio_vectors rows with no backing tracks row (would break KNN).
    await this.sql.begin(async sql => {
      await sql`DELETE FROM tracks              WHERE id = ANY(${orphans as any})`;
      await sql`DELETE FROM track_vectors       WHERE id = ANY(${orphans as any})`;
      await sql`DELETE FROM track_audio_vectors WHERE id = ANY(${orphans as any})`;
    });
    return orphans.length;
  }

  async analysedCount(): Promise<number> {
    const [r] = await this.sql<[{ n: string }]>`
      SELECT COUNT(*) AS n FROM tracks WHERE bpm IS NOT NULL
    `;
    return Number(r.n);
  }

  async analysedIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM tracks WHERE bpm IS NOT NULL ORDER BY id
    `;
    return rows.map(r => r.id);
  }

  async songsByMood(mood: string): Promise<TrackRecord[]> {
    // moods is JSONB — use the containment operator to check array membership.
    // jsonb_build_array(mood::text) produces '["mood"]'::jsonb so @> is exact.
    const rows = await this.sql<Record<string, any>[]>`
      SELECT * FROM tracks
      WHERE moods IS NOT NULL
        AND moods @> jsonb_build_array(${mood}::text)
    `;
    return rows.map(rowToTrack);
  }

  async songsByEnergy(energy: EnergyValue): Promise<TrackRecord[]> {
    if (!energy) return [];
    const rows = await this.sql<Record<string, any>[]>`
      SELECT * FROM tracks WHERE energy = ${energy}
    `;
    return rows.map(rowToTrack);
  }

  async allTaggedIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM tracks WHERE moods IS NOT NULL
    `;
    return rows.map(r => r.id);
  }

  async staleTaggedIds(promptHash: string, model: string, limit?: number): Promise<string[]> {
    // `IS DISTINCT FROM` is PostgreSQL's null-safe inequality (IS NOT in SQLite).
    const rows = limit && limit > 0
      ? await this.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM tracks
           WHERE ${SQL_HAS_MOODS}
             AND (source IS NULL OR source != 'manual')
             AND (prompt_hash IS DISTINCT FROM $1 OR model IS DISTINCT FROM $2)
           ORDER BY id LIMIT ${Math.floor(limit)}`,
          [promptHash, model],
        )
      : await this.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM tracks
           WHERE ${SQL_HAS_MOODS}
             AND (source IS NULL OR source != 'manual')
             AND (prompt_hash IS DISTINCT FROM $1 OR model IS DISTINCT FROM $2)
           ORDER BY id`,
          [promptHash, model],
        );
    return rows.map(r => r.id);
  }

  async enrichedIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM tracks WHERE enriched_at IS NOT NULL
    `;
    return rows.map(r => r.id);
  }

  async untaggedIds(limit?: number): Promise<string[]> {
    const rows = limit
      ? await this.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM tracks WHERE ${SQL_NO_MOODS} LIMIT $1`,
          [limit],
        )
      : await this.sql.unsafe<{ id: string }[]>(
          `SELECT id FROM tracks WHERE ${SQL_NO_MOODS}`,
          [],
        );
    return rows.map(r => r.id);
  }

  async unembeddedIds(limit?: number): Promise<string[]> {
    const rows = limit
      ? await this.sql<{ id: string }[]>`
          SELECT t.id FROM tracks t
          LEFT JOIN track_vectors v ON v.id = t.id
          WHERE v.id IS NULL LIMIT ${limit}
        `
      : await this.sql<{ id: string }[]>`
          SELECT t.id FROM tracks t
          LEFT JOIN track_vectors v ON v.id = t.id
          WHERE v.id IS NULL
        `;
    return rows.map(r => r.id);
  }

  async embeddedIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM track_vectors`;
    return rows.map(r => r.id);
  }

  async trackIdsByGenreDecade(): Promise<Map<string, string[]>> {
    const rows = await this.sql<{ id: string; g: string; decade: number }[]>`
      SELECT id,
             COALESCE(genre, '')                         AS g,
             (COALESCE(year, 0) / 10) * 10              AS decade
      FROM tracks
      WHERE moods IS NULL
    `;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const key = `${r.g}|${r.decade}`;
      const list = out.get(key) ?? [];
      list.push(r.id);
      out.set(key, list);
    }
    return out;
  }

  async genreCentroids(): Promise<
    Array<{ genre: string; count: number; centroid: Float32Array }>
  > {
    // Use a server-side cursor (batch size 200) so we accumulate into running
    // sums without loading all embedding strings at once. For a 100k-track
    // library at 1536-d that's ~1.2 GB of strings if fetched in one shot.
    const sums = new Map<string, { sum: Float64Array; count: number }>();
    let dim = 0;

    await this.sql`
      SELECT t.genre, v.embedding::text AS embedding
      FROM tracks t
      JOIN track_vectors v ON v.id = t.id
      WHERE t.genre IS NOT NULL AND TRIM(t.genre) != ''
    `.cursor(200, (rows) => {
      for (const r of rows as { genre: string; embedding: string }[]) {
        const vec = vecFromString(r.embedding);
        if (!dim) dim = vec.length;
        if (vec.length !== dim) continue;

        let acc = sums.get(r.genre);
        if (!acc) {
          acc = { sum: new Float64Array(dim), count: 0 };
          sums.set(r.genre, acc);
        }
        for (let i = 0; i < dim; i++) acc.sum[i] += vec[i];
        acc.count++;
      }
    });

    const out: Array<{ genre: string; count: number; centroid: Float32Array }> = [];
    for (const [genre, { sum, count }] of sums) {
      if (!count) continue;
      const centroid = new Float32Array(dim);
      for (let i = 0; i < dim; i++) centroid[i] = sum[i] / count;
      out.push({ genre, count, centroid });
    }
    return out;
  }

  // ---- Filter / stats ------------------------------------------------------

  async filter(
    opts: FilterOpts = {},
  ): Promise<{ total: number; rows: TrackRecord[] }> {
    const moods = (opts.moods || []).filter(Boolean);
    const energy = opts.energy || null;
    const genre = opts.genre || null;
    const vocal = opts.vocal === 'instrumental' || opts.vocal === 'vocal'
      ? opts.vocal
      : null;
    const yearFrom = Number.isFinite(opts.yearFrom as number)
      ? (opts.yearFrom as number)
      : null;
    const yearTo = Number.isFinite(opts.yearTo as number)
      ? (opts.yearTo as number)
      : null;
    const q = (opts.q || '').trim().toLowerCase();
    const sort = opts.sort || 'artist';
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const offset = Math.max(0, opts.offset ?? 0);

    // Build WHERE conditions as sql fragments. The sql tagged-template literal
    // approach in the postgres package lets us safely compose dynamic queries
    // by nesting fragments — parameter numbering is handled automatically.
    const sql = this.sql;

    // Always restrict to the tagged set.
    const conds: ReturnType<typeof sql>[] = [
      sql`moods IS NOT NULL AND jsonb_array_length(moods) > 0`,
    ];

    if (moods.length) {
      // ?| checks if any element of the text array exists as a top-level JSONB
      // array element — equivalent to the SQLite json_each IN(...) EXISTS check.
      conds.push(sql`moods ?| ${moods as any}`);
    }
    if (energy) conds.push(sql`energy = ${energy}`);
    if (genre) conds.push(sql`genre = ${genre}`);
    if (vocal === 'instrumental') {
      conds.push(
        sql`vocal_ranges_json IS NOT NULL AND jsonb_array_length(vocal_ranges_json) = 0`,
      );
    } else if (vocal === 'vocal') {
      conds.push(
        sql`vocal_ranges_json IS NOT NULL AND jsonb_array_length(vocal_ranges_json) > 0`,
      );
    }
    if (yearFrom != null) conds.push(sql`year IS NOT NULL AND year >= ${yearFrom}`);
    if (yearTo != null) conds.push(sql`year IS NOT NULL AND year <= ${yearTo}`);
    if (q) {
      const pat = `%${q}%`;
      conds.push(
        sql`(LOWER(COALESCE(title,'')) LIKE ${pat} OR LOWER(COALESCE(artist,'')) LIKE ${pat} OR LOWER(COALESCE(album,'')) LIKE ${pat})`,
      );
    }

    // Combine conditions with AND.
    const where = conds.reduce((a, b) => sql`${a} AND ${b}`);

    // Pace-mean subquery: subquery over JSONB pace_json for the pace sort.
    // NULLS LAST ensures un-analysed tracks sink to the bottom of each sort.
    const paceMeanSub = sql`
      (SELECT AVG((je->>'value')::float) FROM jsonb_array_elements(pace_json) AS je)
    `;

    // Build ORDER BY fragment based on the requested sort key.
    type Frag = ReturnType<typeof sql>;
    const orderMap: Record<string, Frag> = {
      artist: sql`ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`,
      title: sql`ORDER BY LOWER(COALESCE(title,'')) , LOWER(COALESCE(artist,''))`,
      year: sql`ORDER BY year DESC NULLS LAST, LOWER(COALESCE(artist,''))`,
      taggedAt: sql`ORDER BY tagged_at DESC NULLS LAST`,
      bpm: sql`ORDER BY bpm ASC NULLS LAST, LOWER(COALESCE(artist,''))`,
      loudness: sql`ORDER BY loudness_lufs DESC NULLS LAST, LOWER(COALESCE(artist,''))`,
      pace: sql`ORDER BY ${paceMeanSub} DESC NULLS LAST, LOWER(COALESCE(artist,''))`,
    };
    const order: Frag =
      orderMap[sort] ??
      sql`ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`;

    const [countRow] = await sql<[{ n: string }]>`
      SELECT COUNT(*) AS n FROM tracks WHERE ${where}
    `;
    const total = Number(countRow.n);

    const rows = await sql<Record<string, any>[]>`
      SELECT * FROM tracks WHERE ${where} ${order} LIMIT ${limit} OFFSET ${offset}
    `;

    return { total, rows: rows.map(rowToTrack) };
  }

  async allTagged(limit?: number): Promise<TrackRecord[]> {
    const rows = limit && limit > 0
      ? await this.sql.unsafe<Record<string, any>[]>(
          `SELECT * FROM tracks WHERE ${SQL_HAS_MOODS} ORDER BY id LIMIT ${Math.floor(limit)}`,
          [],
        )
      : await this.sql.unsafe<Record<string, any>[]>(
          `SELECT * FROM tracks WHERE ${SQL_HAS_MOODS} ORDER BY id`,
          [],
        );
    return rows.map(rowToTrack);
  }

  async allTaggedSampled(max: number, totalTagged: number): Promise<TrackRecord[]> {
    const m = Math.floor(max);
    const total = Math.floor(totalTagged);
    if (m <= 0 || total <= 0) return [];

    // PostgreSQL supports the window-function stratified-sample query directly.
    // GREATEST replaces SQLite's MAX, and the subquery needs an explicit alias.
    const rows = await this.sql.unsafe<Record<string, any>[]>(
      `SELECT * FROM (
         SELECT t.*,
           ROW_NUMBER() OVER (PARTITION BY genre ORDER BY id) AS __rn,
           COUNT(*)     OVER (PARTITION BY genre)             AS __gc
         FROM tracks t
         WHERE ${SQL_HAS_MOODS}
       ) AS sub
       WHERE __rn <= GREATEST(1, ROUND(__gc * 1.0 * $1 / $2)::int)
       ORDER BY id`,
      [m, total],
    );
    return rows.map(rowToTrack);
  }

  async stats(): Promise<LibraryStats> {
    const sql = this.sql;

    const [totalRow] = await sql.unsafe<[{ n: string }]>(
      `SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`,
      [],
    );
    const total = Number(totalRow.n);

    const [artistRow] = await sql.unsafe<[{ n: string }]>(
      `SELECT COUNT(DISTINCT LOWER(TRIM(artist))) AS n
       FROM tracks
       WHERE ${SQL_HAS_MOODS}
         AND artist IS NOT NULL
         AND TRIM(artist) != ''`,
      [],
    );
    const distinctArtists = Number(artistRow.n);

    // Mood counts — jsonb_array_elements_text expands the JSONB array into rows.
    const moodRows = await sql.unsafe<{ mood: string; n: string }[]>(
      `SELECT m AS mood, COUNT(*) AS n
       FROM tracks, jsonb_array_elements_text(moods) AS m
       WHERE moods IS NOT NULL
       GROUP BY m`,
      [],
    );
    const byMood: Record<string, number> = {};
    for (const r of moodRows) byMood[r.mood] = Number(r.n);

    const energyRows = await sql<{ energy: string; n: string }[]>`
      SELECT energy, COUNT(*) AS n FROM tracks
      WHERE energy IS NOT NULL
      GROUP BY energy
    `;
    const byEnergy: Record<string, number> = {};
    for (const r of energyRows) byEnergy[r.energy] = Number(r.n);

    const genreRows = await sql<{ genre: string; n: string }[]>`
      SELECT genre, COUNT(*) AS n FROM tracks
      WHERE genre IS NOT NULL
      GROUP BY genre
    `;
    const byGenre: Record<string, number> = {};
    for (const r of genreRows) byGenre[r.genre] = Number(r.n);

    const sourceRows = await sql<{ source: string; n: string }[]>`
      SELECT source, COUNT(*) AS n FROM tracks
      WHERE source IS NOT NULL
      GROUP BY source
    `;
    const bySource: Record<string, number> = {};
    for (const r of sourceRows) bySource[r.source] = Number(r.n);

    const [vecRow] = await sql<[{ n: string }]>`SELECT COUNT(*) AS n FROM track_vectors`;
    const withEmbedding = Number(vecRow.n);

    const [audRow] = await sql<[{ n: string }]>`
      SELECT COUNT(*) AS n FROM track_audio_vectors
    `;
    const withAudioEmbedding = Number(audRow.n);

    const [updRow] = await sql<[{ t: string | null }]>`
      SELECT MAX(tagged_at) AS t FROM tracks
    `;
    const updatedAt = updRow.t ?? null;

    return {
      total,
      distinctArtists,
      byMood,
      byEnergy,
      byGenre,
      bySource,
      withEmbedding,
      withAudioEmbedding,
      updatedAt,
    };
  }
}
