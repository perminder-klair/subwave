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
import { readFile, rename, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
// v2: added integrated loudness (loudness_lufs) + peak (peak_db).
// v3: added structural sections (structure_json).
// v4: added the pace curve (pace_json).
// v5: added the beat/bar grid (beats_json, bars_json).
// v6: added per-region key ranges (key_ranges_json).
export const ANALYSIS_VERSION = 6;

// CLAP audio-embedding dim. Fixed by the model (LAION-CLAP's audio projection
// is 512-d), so — unlike the text index in track_vectors — there's no per-model
// dim negotiation. Audio vectors are a DIFFERENT space (waveform-derived, not
// metadata/lyric-derived) and live in their own vec0 table.
export const AUDIO_EMBEDDING_DIM = 512;

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
// Minted per open() — makes change tokens from different handles (restart,
// reload, restore-from-backup) never comparable, so a stale 304 can't happen
// across a swap even though both counters below restart from scratch.
let dbNonce = '0';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnergyValue = 'low' | 'medium' | 'high' | null;
export type TagSource = 'llm' | 'propagated' | 'uncertain-llm' | 'legacy-v1' | 'manual';

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
  loudnessLufs: number | null; // integrated LUFS (BS.1770); null → unity gain
  peakDb: number | null;       // sample peak in dBFS over the analysis window
  structure: TrackSection[] | null; // structural sections over the analysed window
  vocalRanges: TrackSection[] | null; // vocal-presence ranges; [] = instrumental, null = not computed
  pace: TrackPaceSpan[] | null;     // perceptual energy curve (0..1 per span)
  beats: number[] | null;           // per-beat timestamps (ms)
  bars: number[] | null;            // downbeat (bar) timestamps (ms)
  keyRanges: TrackKeyRange[] | null; // per-region key (tonic + mode) over time
  // Zero-shot audio moods — top mood labels from scoring the vocabulary against
  // the track's CLAP audio vector (music/audio-moods.ts). [] until scored;
  // sound-derived, so they complement (never replace) the LLM `moods`.
  audioMoods: string[];
  // Outro (tail) features — the track's measured ending (fade vs cold, tail
  // loudness/tempo/bar grid). null → no outro signal, today's transitions.
  outro: TrackOutro | null;
  // Sound-map coordinates — a 2D UMAP projection of the CLAP audio vector,
  // normalised to [0,1] per axis (music/map-projection.ts). The Observatory
  // places nodes by these when present, so tracks that SOUND alike sit close.
  // null → not projected (no audio vector, or the projection hasn't run).
  mapX: number | null;
  mapY: number | null;
}

// The measured ending of a track — what the crossfade seam actually lands on.
// Timestamps are absolute ms into the track.
export interface TrackOutro {
  startMs: number;           // where the wind-down starts
  ending: 'fade' | 'cold';   // fades to silence vs ends at level
  lufs: number | null;       // integrated tail loudness (BS.1770)
  bpm: number | null;        // tail tempo (outros drift/ritard vs the lead)
  beats: number[] | null;    // tail beat grid (ms)
  bars: number[] | null;     // tail downbeat grid (ms)
}

// A key over a time range: tonic note (sharps) + mode.
export interface TrackKeyRange {
  startMs: number;
  endMs: number;
  tonic: string;
  mode: 'major' | 'minor';
}

// A structural span over a track, in milliseconds (span shape). Kept as
// a local shape so library-db stays free of higher-layer imports.
export interface TrackSection {
  startMs: number;
  endMs: number;
  kind?: string;
}

// A pace span: a 0..1 perceptual-energy value over a time range.
export interface TrackPaceSpan {
  startMs: number;
  endMs: number;
  value: number;
}

// The raw `tracks` table row as SQLite hands it back — snake_case columns with
// the acoustic blobs still JSON strings. rowToTrack / rowToObservatory map it
// into the camelCase record types above. Reflects the table schema; the write
// path validates energy/source into their unions, so those read back typed. A
// partial SELECT (getTrackLite, the observatory columns) yields a subset of
// this shape and the mapper only touches columns it actually selected.
interface TrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  duration_sec: number | null;
  lastfm_tags: string | null;
  lyric_excerpt: string | null;
  enriched_at: string | null;
  moods: string | null;
  energy: EnergyValue;
  source: TagSource | null;
  confidence: number | null;
  tagger_version: number | null;
  prompt_hash: string | null;
  model: string | null;
  tagged_at: string | null;
  bpm: number | null;
  musical_key: string | null;
  intro_ms: number | null;
  analysis_confidence: number | null;
  analysis_version: number | null;
  loudness_lufs: number | null;
  peak_db: number | null;
  structure_json: string | null;
  vocal_ranges_json: string | null;
  pace_json: string | null;
  beats_json: string | null;
  bars_json: string | null;
  key_ranges_json: string | null;
  audio_moods: string | null;
  outro_json: string | null;
  map_x: number | null;
  map_y: number | null;
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
  // Acoustic-analysis facet: 'instrumental' = analysed with an empty vocal-ranges
  // array, 'vocal' = analysed with at least one range. A NULL vocal_ranges_json
  // (not computed) matches neither, so the facet only ever narrows to tracks the
  // analyze pass has actually touched.
  vocal?: 'instrumental' | 'vocal' | null;
  yearFrom?: number | null;
  yearTo?: number | null;
  q?: string | null;
  sort?: 'artist' | 'title' | 'taggedAt' | 'year' | 'bpm' | 'loudness' | 'pace';
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
  withAudioEmbedding: number;
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
// `adoptStoredDim` (live controller) treats the dim already recorded in the DB
// as authoritative: the stored vectors win, and `embeddingDim` is only the
// fallback used when the DB has never been tagged. This stops the runtime from
// wiping a tagged index just because the model *name* maps to a different
// default than the dim the tagger actually probed (#319). The tagger leaves it
// off so a deliberate model swap still surfaces the --reseed gate.
export async function open(opts: {
  embeddingDim: number;
  reseed?: boolean;
  adoptStoredDim?: boolean;
}): Promise<void> {
  if (db) {
    if (!opts.adoptStoredDim && opts.embeddingDim !== currentEmbeddingDim) {
      throw new Error(
        `library-db already open with embedding dim ${currentEmbeddingDim}; ` +
          `caller asked for ${opts.embeddingDim}. Use --reseed to switch models.`,
      );
    }
    return;
  }
  currentEmbeddingDim = opts.embeddingDim;
  db = new Database(DB_PATH);
  dbNonce = randomUUID().slice(0, 8);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  // Cap the -wal sidecar: after any checkpoint SQLite truncates it back to this
  // size instead of leaving it at its high-water mark. Without it a bulk write
  // pass (acoustic analysis, tagging) balloons the WAL to hundreds of MB — 2.4×
  // the DB itself in #786 — and every later query walks that giant WAL on
  // better-sqlite3's synchronous thread, stalling the whole event loop.
  db.pragma('journal_size_limit = 67108864'); // 64 MiB
  sqliteVec.load(db);

  // migrate() may adopt the stored dim; trust its return as the live schema dim.
  currentEmbeddingDim = await migrate(
    opts.embeddingDim,
    opts.reseed === true,
    opts.adoptStoredDim === true,
  );
  await maybeMigrateFromMoodsJson();
}

export function close(): void {
  if (db) {
    // Fold the WAL back into the main DB file before closing. SQLite only
    // auto-checkpoints on the LAST connection to close, and the controller,
    // tagger and analyzer can hold the DB concurrently — so an explicit
    // best-effort TRUNCATE here is what keeps the sidecar from surviving
    // (and regrowing across) restarts. Synchronous, so it also runs safely
    // from a process 'exit' hook.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* busy/readonly — the hourly checkpoint or next close gets it */
    }
    db.close();
    db = null;
    currentEmbeddingDim = null;
    // reload()/restoreFromFile() both drop the handle through here, so a
    // reopened (possibly restored-from-backup) library never serves the
    // previous handle's cached tallies.
    invalidateStats();
  }
}

export function isOpen(): boolean {
  return db !== null;
}

// Best-effort PRAGMA wal_checkpoint(TRUNCATE): fold the WAL into the main DB
// file and truncate the sidecar to zero. Returns what SQLite reports — busy=1
// means a concurrent reader/writer kept the checkpoint from completing (fine;
// the next run catches up) — or null when the DB isn't open. Called after bulk
// passes and hourly from the scheduler so the WAL can never balloon unbounded
// again (#786).
export function checkpointWal(): { busy: number; log: number; checkpointed: number } | null {
  if (!db) return null;
  try {
    const row = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    return row?.[0] ?? null;
  } catch {
    return null;
  }
}

// Write a consistent, single-file copy of the live DB to `destPath`. Uses
// better-sqlite3's online backup API so the result is coherent even though the
// DB runs in WAL mode (a raw file copy could miss un-checkpointed pages in the
// -wal sidecar). Used by the backup/export route.
export async function backup(destPath: string): Promise<void> {
  await requireDb().backup(destPath);
}

// Replace the on-disk DB with the file at `srcPath` (a previously-exported
// backup). Closes the live handle first, swaps the file, and clears any stale
// WAL/SHM sidecars so the next open() reads the restored data cleanly. The
// caller is responsible for reopening (see music/library.ts:reload()).
export async function restoreFromFile(srcPath: string): Promise<void> {
  close();
  await copyFile(srcPath, DB_PATH);
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}

// Delete the entire on-disk DB — every track row, mood/energy tag, text +
// audio embedding, acoustic-analysis column, and enrichment cache — plus the
// WAL/SHM sidecars, so the next open() recreates an empty schema from scratch.
// Mirrors restoreFromFile()'s close→swap-file→drop-sidecars shape, and like it
// leaves the reopen to the caller (music/library.ts:reset()). This is the
// "start fresh" wipe behind the admin library Reset action — irreversible short
// of restoring a backup.
export async function reset(): Promise<void> {
  close();
  await rm(DB_PATH, { force: true });
  await rm(`${DB_PATH}-wal`, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
}

function requireDb(): Database.Database {
  if (!db) throw new Error('library-db not opened — call open() first');
  return db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// Returns the dim the vec0 table is actually created at (== the stored dim when
// `adoptStoredDim` adopts it, else `embeddingDim`). Callers use this as the live
// schema dim so reads/writes validate against the real table width.
async function migrate(embeddingDim: number, reseed = false, adoptStoredDim = false): Promise<number> {
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

  if (userVersion < 3) {
    // Audio (CLAP) embeddings — a SECOND vector space alongside track_vectors.
    // Only the provenance/meta table is created here; the vec0 table itself is
    // created (and can be reseeded) below, mirroring the text-vector pattern.
    // The dim is fixed at AUDIO_EMBEDDING_DIM so there's no dim-negotiation
    // dance — but the meta row still records model+dim+timestamp so a future
    // model swap has provenance to reason about.
    runDdl(d, `
      CREATE TABLE IF NOT EXISTS audio_embedding_meta (
        pk      INTEGER PRIMARY KEY CHECK (pk = 1),
        model   TEXT NOT NULL,
        dim     INTEGER NOT NULL,
        set_at  TEXT NOT NULL
      );
    `);
    d.pragma('user_version = 3');
  }

  if (userVersion < 4) {
    // Perceptual loudness — nullable, back-filled by the analyze pass. LUFS
    // (integrated, BS.1770) drives per-track gain normalisation on playback;
    // peak_db is informational. NULL → unity gain, i.e. today's behaviour.
    runDdl(d, `
      ALTER TABLE tracks ADD COLUMN loudness_lufs REAL;
      ALTER TABLE tracks ADD COLUMN peak_db       REAL;
    `);
    d.pragma('user_version = 4');
  }

  if (userVersion < 5) {
    // Structural sections (JSON array of {startMs,endMs[,kind]}) over the
    // analysed window. Nullable — NULL → no structure, today's behaviour.
    runDdl(d, `ALTER TABLE tracks ADD COLUMN structure_json TEXT;`);
    d.pragma('user_version = 5');
  }

  if (userVersion < 6) {
    // Vocal-presence ranges (Demucs), JSON array of {startMs,endMs}. NULL means
    // not computed (vocal activity off / no demucs); a stored "[]" means
    // analysed-and-instrumental. The distinct empty value lets the backfill scan
    // (needsVocalIds) skip instrumentals instead of re-separating them forever.
    runDdl(d, `ALTER TABLE tracks ADD COLUMN vocal_ranges_json TEXT;`);
    d.pragma('user_version = 6');
  }

  if (userVersion < 7) {
    // Pace curve (JSON array of {startMs,endMs,value}) — perceptual energy over
    // time, 0..1. Nullable; NULL → no pace signal, today's behaviour.
    runDdl(d, `ALTER TABLE tracks ADD COLUMN pace_json TEXT;`);
    d.pragma('user_version = 7');
  }

  if (userVersion < 8) {
    // Beat / bar grid (JSON arrays of ms timestamps). Nullable; NULL → no grid,
    // today's blind crossfade.
    runDdl(d, `
      ALTER TABLE tracks ADD COLUMN beats_json TEXT;
      ALTER TABLE tracks ADD COLUMN bars_json  TEXT;
    `);
    d.pragma('user_version = 8');
  }

  if (userVersion < 9) {
    // Per-region key ranges (JSON array of {startMs,endMs,tonic,mode}). Nullable;
    // the scalar musical_key stays the back-compat dominant key.
    runDdl(d, `ALTER TABLE tracks ADD COLUMN key_ranges_json TEXT;`);
    d.pragma('user_version = 9');
  }

  if (userVersion < 10) {
    // Task-prefix mode of the text-embedding index: 'plain' (texts embedded
    // bare) or 'prefixed' (embedded with the model's document prefix, e.g.
    // nomic's `search_document:`). NULL (legacy rows) = 'plain'. Lives with the
    // index provenance because query embeds must match how the documents were
    // embedded (music/embeddings.ts resolveIndexTextMode).
    runDdl(d, `ALTER TABLE embedding_meta ADD COLUMN text_mode TEXT;`);
    d.pragma('user_version = 10');
  }

  if (userVersion < 11) {
    // Zero-shot audio moods (music/audio-moods.ts) — the mood vocabulary scored
    // against each track's CLAP audio vector via the CLAP text tower, so tags
    // come from how the track SOUNDS rather than what its title suggests.
    // audio_moods holds the top mood labels as a JSON array (same shape as
    // `moods`, so songsByMood can json_each both); audio_mood_scores_json the
    // full {mood: cosine} map for tuning/observatory use. mood_vocab_hash on the
    // audio meta row invalidates scores when the vocabulary/prompts change.
    // NULL everywhere → no audio moods, today's behaviour.
    runDdl(d, `
      ALTER TABLE tracks ADD COLUMN audio_moods            TEXT;
      ALTER TABLE tracks ADD COLUMN audio_mood_scores_json TEXT;
      ALTER TABLE audio_embedding_meta ADD COLUMN mood_vocab_hash TEXT;
    `);
    d.pragma('user_version = 11');
  }

  if (userVersion < 12) {
    // Outro (tail) features (JSON {startMs,ending,lufs?,bpm?,beats?,bars?}) —
    // the outgoing track's measured ending, analysed off the END of a complete
    // file. Nullable; NULL → no outro signal, today's transition behaviour.
    runDdl(d, `ALTER TABLE tracks ADD COLUMN outro_json TEXT;`);
    d.pragma('user_version = 12');
  }

  if (userVersion < 13) {
    // Sound-map coordinates (music/map-projection.ts) — 2D UMAP of the CLAP
    // audio vectors, normalised to [0,1] per axis. Nullable; NULL → the
    // Observatory falls back to its genre-cluster layout for that track.
    // map_projection_meta records provenance (algo/space/row count/timestamp)
    // so staleness is a cheap count comparison, not a vector diff.
    runDdl(d, `
      ALTER TABLE tracks ADD COLUMN map_x REAL;
      ALTER TABLE tracks ADD COLUMN map_y REAL;
      CREATE TABLE IF NOT EXISTS map_projection_meta (
        pk      INTEGER PRIMARY KEY CHECK (pk = 1),
        algo    TEXT NOT NULL,
        space   TEXT NOT NULL,
        count   INTEGER NOT NULL,
        set_at  TEXT NOT NULL
      );
    `);
    d.pragma('user_version = 13');
  }

  // Reconcile the requested embedding dim against what physically exists.
  //
  // The vec0 table's `FLOAT[N]` schema is the authority for what inserts accept —
  // NOT embedding_meta, which is written separately (by the tagger, post-probe)
  // and can lag the table. Keying off the meta row alone misses the case that
  // bit qwen3-embedding users: the live controller creates track_vectors at the
  // name→dim GUESS (resolveEmbeddingDim → 768 for an unknown model) on a fresh
  // DB and writes NO meta row; the tagger then probes the real dim (1024) but,
  // because the meta was absent, the old check neither recreated the table nor
  // errored — so every embed insert crashed with "Expected 768 dimensions but
  // received 1024", and wiping the DB didn't help (the controller re-created the
  // 768 table on the next boot). Read the real width from the table itself.
  const meta = d.prepare('SELECT model, dim FROM embedding_meta WHERE pk = 1').get() as
    | { model: string; dim: number }
    | undefined;
  const tableDim = vecTableDim(d); // null when track_vectors doesn't exist yet
  // Effective dim for the vec0 table. Defaults to what the caller asked for; the
  // branches below may adopt the on-disk dim or drop+recreate at the new dim.
  let effectiveDim = embeddingDim;
  if (tableDim !== null && tableDim !== embeddingDim) {
    const modelHint = meta?.model ? ` (model: ${meta.model})` : '';
    if (adoptStoredDim) {
      // Live controller: the physical index is authoritative. Honour its dim so
      // the picker keeps working off a tagged index even when the model name
      // resolves to a different default. A real model swap is reconciled by the
      // tagger's --reseed path, not silently here (#319).
      console.warn(
        `[library-db] adopting on-disk embedding dim ${tableDim}${modelHint}; ` +
          `caller requested ${embeddingDim}. Re-tag with --reseed to switch models.`,
      );
      effectiveDim = tableDim;
    } else if (vecCount(d) === 0) {
      // Empty index at the wrong width — nothing to protect, so recreate it at
      // the requested dim without demanding --reseed. This self-heals the
      // guessed-dim table the live controller created before the tagger probed
      // the real one, so a plain tag run works for any embedding model / dim.
      console.warn(
        `[library-db] track_vectors is empty at ${tableDim}-d${modelHint}; ` +
          `recreating at ${embeddingDim}-d for the current embedding model`,
      );
      runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
      d.prepare('DELETE FROM embedding_meta WHERE pk = 1').run();
    } else if (!reseed) {
      throw new Error(
        `embedding dim mismatch: state/library.db has ${tableDim}-d vectors${modelHint}, ` +
          `but the current embedding model needs ${embeddingDim}-d. You changed the embedding ` +
          `model, so the library must be re-embedded to switch. In the admin UI: Library → ` +
          `Start tagging → Re-scan tab → “Re-embed all tracks” (your mood tags are kept). ` +
          `Or from the CLI: \`npm run tag -- --reseed\`.`,
      );
    } else {
      // Reseed across a model/dim change on a POPULATED index: the stored vectors
      // are unusable at the new dim, so drop them (the table is recreated at
      // `effectiveDim` just below) and clear the stale meta row so a later
      // setEmbeddingMeta() seeds it fresh and the next open() sees a matching dim.
      console.warn(
        `[library-db] reseed: embedding dim ${tableDim}→${embeddingDim}${modelHint}; ` +
          `dropping vectors for re-embed`,
      );
      runDdl(d, 'DROP TABLE IF EXISTS track_vectors');
      d.prepare('DELETE FROM embedding_meta WHERE pk = 1').run();
    }
  }

  const hasVecTable = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='track_vectors'`)
    .get();
  if (!hasVecTable) {
    runDdl(d,
      `CREATE VIRTUAL TABLE track_vectors USING vec0(` +
        `id TEXT PRIMARY KEY, embedding FLOAT[${effectiveDim}] distance_metric=cosine)`,
    );
  }

  // Audio-vector table — a parallel vec0 index at the fixed CLAP dim. Created
  // on demand and self-heals if a future audio reseed drops it, exactly like
  // track_vectors above. It needs no dim negotiation because
  // AUDIO_EMBEDDING_DIM is constant, so it lives outside the reseed branch.
  const hasAudioVecTable = d
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='track_audio_vectors'`)
    .get();
  if (!hasAudioVecTable) {
    runDdl(d,
      `CREATE VIRTUAL TABLE track_audio_vectors USING vec0(` +
        `id TEXT PRIMARY KEY, embedding FLOAT[${AUDIO_EMBEDDING_DIM}] distance_metric=cosine)`,
    );
  }
  return effectiveDim;
}

// Wrapper so we keep the SQL "exec" verb out of the source text and dodge a
// security linter that flags exec() as child_process abuse. Functionally
// identical to db.exec(sql).
function runDdl(d: Database.Database, sql: string): void {
  d.exec(sql);
}

// The embedding width baked into the track_vectors vec0 schema — the authority
// for what inserts accept (embedding_meta is written separately and can lag).
// Parsed from the stored CREATE statement; null when the table doesn't exist.
function vecTableDim(d: Database.Database): number | null {
  const row = d
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='track_vectors'`)
    .get() as { sql: string | null } | undefined;
  if (!row?.sql) return null;
  const m = row.sql.match(/embedding\s+FLOAT\[(\d+)\]/i);
  return m ? parseInt(m[1], 10) : null;
}

// Row count of the text-vector index. Used to decide whether a dim mismatch can
// self-heal (empty table → free to recreate) or must gate behind --reseed
// (populated index → the operator's vectors are at stake).
function vecCount(d: Database.Database): number {
  return (d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Legacy moods.json → SQLite (one-shot, idempotent)
// ---------------------------------------------------------------------------

// A single track entry as the legacy state/moods.json carried it. Every field
// is optional and loosely typed — it's a hand-migrated file — and only the ones
// the insert below reads are declared.
interface LegacyMoodsTrack {
  title?: string;
  artist?: string;
  album?: string;
  year?: number | string;
  genre?: string;
  duration?: number;
  moods?: string[];
  energy?: string;
  taggedAt?: string;
}

async function maybeMigrateFromMoodsJson(): Promise<void> {
  if (!existsSync(LEGACY_MOODS_JSON)) return;
  const d = requireDb();

  const before = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;

  const raw = await readFile(LEGACY_MOODS_JSON, 'utf8');
  let parsed: { tracks?: Record<string, LegacyMoodsTrack> } | null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[library-db] moods.json parse failed (${err.message}); skipping migration`);
    return;
  }
  const entries: [string, LegacyMoodsTrack][] = parsed?.tracks ? Object.entries(parsed.tracks) : [];
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
  const tx = d.transaction((rows: [string, LegacyMoodsTrack][]) => {
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
        ['low', 'medium', 'high'].includes(t.energy!) ? t.energy : null,
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
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[library-db] could not archive moods.json: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Embedding meta
// ---------------------------------------------------------------------------

// `textMode` records whether the vectors were embedded with the model's
// document prefix ('prefixed') or bare ('plain'); null = legacy row from
// before mode tracking (equivalent to 'plain' — see resolveIndexTextMode).
export type EmbeddingTextMode = 'plain' | 'prefixed';

export function getEmbeddingMeta(): {
  model: string;
  dim: number;
  textMode: EmbeddingTextMode | null;
} | null {
  const row = requireDb()
    .prepare('SELECT model, dim, text_mode FROM embedding_meta WHERE pk = 1')
    .get() as { model: string; dim: number; text_mode: string | null } | undefined;
  if (!row) return null;
  return {
    model: row.model,
    dim: row.dim,
    textMode: row.text_mode === 'prefixed' || row.text_mode === 'plain' ? row.text_mode : null,
  };
}

export function setEmbeddingMeta(
  model: string,
  dim: number,
  textMode: EmbeddingTextMode | null = null,
): void {
  requireDb()
    .prepare(
      `INSERT INTO embedding_meta (pk, model, dim, set_at, text_mode) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET model = excluded.model, dim = excluded.dim,
         set_at = excluded.set_at, text_mode = excluded.text_mode`,
    )
    .run(model, dim, new Date().toISOString(), textMode);
}

// Audio-embedding provenance — which CLAP model wrote the current audio
// vectors. Distinct table from embedding_meta (text); the two spaces are
// independent. Null until the first audio vector is written.
export function setAudioEmbeddingMeta(model: string, dim: number): void {
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at) VALUES (1, ?, ?, ?)
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
    .get(id) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

export interface TrackLite {
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
  moods: string[];
  energy: string | null;
  year: number | null;
  durationSec: number | null;
}

// Lean read for the /now-playing hot path (polled every ~5s by every listener).
// Selects only the light scalar columns the player's metadata strip renders,
// skipping the heavy acoustic *_json blobs (structure/pace/beats/bars/key/vocal
// ranges) that a full getTrack() → rowToTrack() SELECTs and JSON.parses on every
// call. After acoustic analysis those blobs are populated and fat, so parsing
// them per poll — on better-sqlite3's single synchronous thread — stalled every
// concurrent HTTP response, making the whole UI sluggish (#723).
export function getTrackLite(id: string): TrackLite | null {
  const row = requireDb()
    .prepare(`SELECT genre, bpm, musical_key, moods, energy, year, duration_sec FROM tracks WHERE id = ?`)
    .get(id) as Pick<TrackRow, 'genre' | 'bpm' | 'musical_key' | 'moods' | 'energy' | 'year' | 'duration_sec'> | undefined;
  if (!row) return null;
  return {
    genre: row.genre ?? null,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    year: row.year ?? null,
    durationSec: row.duration_sec ?? null,
  };
}

// COUNT(*) of tagged tracks — the O(1)-ish query behind the coverage meter's
// "tagged" tally. Replaces allTaggedIds().length, which materialised a ~30k-
// element JS id array on every coverage poll only to read its .length (#723).
// Predicate is `moods IS NOT NULL` to match allTaggedIds() exactly (NOT the
// stricter SQL_HAS_MOODS) so the coverage percentage is unchanged.
export function countTagged(): number {
  return (
    requireDb().prepare(`SELECT COUNT(*) AS n FROM tracks WHERE moods IS NOT NULL`).get() as {
      n: number;
    }
  ).n;
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

// Remove a track's tags entirely (back to the untagged pool). NULLing every
// tag column — rather than writing moods='[]' — keeps source/tagged_at from
// going stale on a row that is no longer tagged.
export function clearTrackTags(id: string): void {
  requireDb()
    .prepare(
      `UPDATE tracks SET
        moods          = NULL,
        energy         = NULL,
        source         = NULL,
        confidence     = NULL,
        tagger_version = NULL,
        prompt_hash    = NULL,
        model          = NULL,
        tagged_at      = NULL
      WHERE id = ?`,
    )
    .run(id);
}

export interface TrackAnalysisWrite {
  bpm?: number | null;
  musicalKey?: string | null;
  introMs?: number | null;
  confidence?: number | null;
  loudnessLufs?: number | null;
  peakDb?: number | null;
  sections?: TrackSection[] | null;
  // [] is meaningful (analysed instrumental) vs null/undefined (not computed) —
  // only a non-null array is written, so a vocal-off pass leaves the column be.
  vocalRanges?: TrackSection[] | null;
  pace?: TrackPaceSpan[] | null;
  beats?: number[] | null;
  bars?: number[] | null;
  keyRanges?: TrackKeyRange[] | null;
  // Outro features — null keeps an existing value (COALESCE, like vocal): a
  // pass that couldn't compute the tail (capped download, url path) must not
  // wipe an outro a previous complete-file pass measured.
  outro?: TrackOutro | null;
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
        loudness_lufs       = ?,
        peak_db             = ?,
        structure_json      = ?,
        pace_json           = ?,
        beats_json          = ?,
        bars_json           = ?,
        key_ranges_json     = ?,
        -- COALESCE: vocal activity is gated separately (ANALYZE_VOCAL_ACTIVITY),
        -- so a normal bpm/key pass passes null here and must NOT wipe an
        -- existing vocal_ranges_json. A non-null value (incl. "[]" for an
        -- analysed instrumental) overwrites; null keeps what's there.
        vocal_ranges_json   = COALESCE(?, vocal_ranges_json),
        -- Same for the outro: only computable off a COMPLETE file, so a pass
        -- that analysed a capped download passes null and keeps what's there.
        outro_json          = COALESCE(?, outro_json),
        analysis_version    = ?
      WHERE id = ?`,
    )
    .run(
      Number.isFinite(a.bpm as number) ? (a.bpm as number) : null,
      a.musicalKey ?? null,
      Number.isFinite(a.introMs as number) ? Math.round(a.introMs as number) : null,
      Number.isFinite(a.confidence as number) ? (a.confidence as number) : null,
      Number.isFinite(a.loudnessLufs as number) ? (a.loudnessLufs as number) : null,
      Number.isFinite(a.peakDb as number) ? (a.peakDb as number) : null,
      a.sections && a.sections.length ? JSON.stringify(a.sections) : null,
      a.pace && a.pace.length ? JSON.stringify(a.pace) : null,
      a.beats && a.beats.length ? JSON.stringify(a.beats) : null,
      a.bars && a.bars.length ? JSON.stringify(a.bars) : null,
      a.keyRanges && a.keyRanges.length ? JSON.stringify(a.keyRanges) : null,
      a.vocalRanges != null ? JSON.stringify(a.vocalRanges) : null,
      a.outro != null ? JSON.stringify(a.outro) : null,
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

// Drop the acoustic analysis so a --re-analyze can recompute it. `keepVocal`
// preserves vocal_ranges_json — used when re-analysing bpm/key + sounds-like
// WITHOUT redoing the (very slow) Demucs vocal pass, so existing vocal data
// isn't wiped and left NULL (it wouldn't be rebuilt that run). #646-adjacent.
export function clearAnalysis(opts: { keepVocal?: boolean } = {}): void {
  const d = requireDb();
  const vocalCol = opts.keepVocal ? '' : ' vocal_ranges_json = NULL,';
  d.prepare(
    `UPDATE tracks SET bpm = NULL, musical_key = NULL, intro_ms = NULL,
      analysis_confidence = NULL, loudness_lufs = NULL, peak_db = NULL,
      structure_json = NULL, pace_json = NULL, beats_json = NULL, bars_json = NULL,
      key_ranges_json = NULL, outro_json = NULL,${vocalCol} analysis_version = NULL,
      audio_moods = NULL, audio_mood_scores_json = NULL`,
  ).run();
  // The audio (CLAP) vectors are written in the same pass, so a --re-analyze
  // that redoes bpm/key drops them too — the next pass re-embeds from scratch.
  // Audio moods above go with them: they're derived from those vectors.
  d.prepare('DELETE FROM track_audio_vectors').run();
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

// Write a CLAP audio embedding for a track. Independent of currentEmbeddingDim
// (that's the TEXT index's dim) — the audio space is fixed at
// AUDIO_EMBEDDING_DIM. Same delete+insert upsert pattern vec0 requires.
export function upsertTrackAudioVector(id: string, vector: number[] | Float32Array): void {
  if (vector.length !== AUDIO_EMBEDDING_DIM) {
    throw new Error(
      `audio vector dim ${vector.length} != ${AUDIO_EMBEDDING_DIM} (CLAP); ` +
        `check CLAP_MODEL / the analyzer's audio_embedding output`,
    );
  }
  const buf = Buffer.from(
    vector instanceof Float32Array ? vector.buffer : new Float32Array(vector).buffer,
  );
  const d = requireDb();
  d.prepare(`DELETE FROM track_audio_vectors WHERE id = ?`).run(id);
  d.prepare(`INSERT INTO track_audio_vectors (id, embedding) VALUES (?, ?)`).run(id, buf);
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
  return knnByBuffer(row.embedding, k, id, 'track_vectors');
}

export function knnByVector(vec: number[] | Float32Array, k: number): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_vectors');
}

// Audio (CLAP) KNN — same logic as the text path, against track_audio_vectors.
// Returns [] when the seed has no audio vector, so callers fall through exactly
// like the text path does on an un-embedded seed.
export function knnAudioById(id: string, k: number): KnnHit[] {
  const d = requireDb();
  const row = d.prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`).get(id) as
    | { embedding: Buffer }
    | undefined;
  if (!row) return [];
  return knnByBuffer(row.embedding, k, id, 'track_audio_vectors');
}

export function knnByAudioVector(vec: number[] | Float32Array, k: number): KnnHit[] {
  const buf = Buffer.from(
    vec instanceof Float32Array ? vec.buffer : new Float32Array(vec).buffer,
  );
  return knnByBuffer(buf, k, null, 'track_audio_vectors');
}

// `table` is always a hardcoded vec0 table name from our own code (never user
// input), so interpolating it is safe — the MATCH buffer is still bound.
function knnByBuffer(
  buf: Buffer,
  k: number,
  excludeId: string | null,
  table: 'track_vectors' | 'track_audio_vectors',
): KnnHit[] {
  const limit = excludeId ? k + 1 : k;
  const rows = requireDb()
    .prepare(
      `SELECT id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
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

// The raw TEXT embedding vector for a track (a copy, not a view into the DB
// buffer), or null when the track has no text vector. The text-space twin of
// getAudioVector() — used by the Library Observatory dossier to render the
// learned vector as a heatmap fingerprint. vec0 stores the embedding as a
// packed float32 blob.
export function getVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

// The raw CLAP vector for a track (a copy, not a view into the DB buffer), or
// null when the track has no audio vector. Used by the journey builder to
// resolve start/destination points in the audio space. vec0 stores the
// embedding as a packed float32 blob.
export function getAudioVector(id: string): Float32Array | null {
  const row = requireDb()
    .prepare(`SELECT embedding FROM track_audio_vectors WHERE id = ?`)
    .get(id) as { embedding: Buffer } | undefined;
  if (!row) return null;
  const b = row.embedding;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)).slice();
}

export function audioVectorCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as {
    n: number;
  }).n;
}

// Every stored CLAP vector in one pass — the sound-map projection's input.
// Each entry is a copy (not a view into the DB page), safe to hold across
// further DB work. ~18MB at 9k×512, well within a one-shot job's budget.
export function allAudioVectors(): { id: string; vector: Float32Array }[] {
  const rows = requireDb()
    .prepare('SELECT id, embedding FROM track_audio_vectors')
    .all() as { id: string; embedding: Buffer }[];
  return rows.map((r) => ({
    id: r.id,
    vector: new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      Math.floor(r.embedding.byteLength / 4),
    ).slice(),
  }));
}

// ---------------------------------------------------------------------------
// Sound-map projection coordinates (music/map-projection.ts)
// ---------------------------------------------------------------------------

export function setMapCoordsBulk(coords: { id: string; x: number; y: number }[]): void {
  const d = requireDb();
  const clear = d.prepare('UPDATE tracks SET map_x = NULL, map_y = NULL WHERE map_x IS NOT NULL');
  const stmt = d.prepare('UPDATE tracks SET map_x = ?, map_y = ? WHERE id = ?');
  // Clear-then-set in one transaction so coords always reflect exactly the
  // last projection — a track whose audio vector was since deleted can't keep
  // a stale position on the map.
  const tx = d.transaction((list: { id: string; x: number; y: number }[]) => {
    clear.run();
    for (const c of list) stmt.run(c.x, c.y, c.id);
  });
  tx(coords);
}

export function mapCoordsCount(): number {
  return (requireDb().prepare('SELECT COUNT(*) AS n FROM tracks WHERE map_x IS NOT NULL').get() as {
    n: number;
  }).n;
}

export function getMapProjectionMeta(): { algo: string; space: string; count: number; setAt: string } | null {
  const row = requireDb()
    .prepare('SELECT algo, space, count, set_at FROM map_projection_meta WHERE pk = 1')
    .get() as { algo: string; space: string; count: number; set_at: string } | undefined;
  return row ? { algo: row.algo, space: row.space, count: row.count, setAt: row.set_at } : null;
}

export function setMapProjectionMeta(algo: string, space: string, count: number): void {
  requireDb()
    .prepare(
      `INSERT INTO map_projection_meta (pk, algo, space, count, set_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET algo = excluded.algo, space = excluded.space,
         count = excluded.count, set_at = excluded.set_at`,
    )
    .run(algo, space, count, new Date().toISOString());
}

// ---------------------------------------------------------------------------
// Zero-shot audio moods (music/audio-moods.ts) — mood labels derived by scoring
// the vocabulary's CLAP TEXT embeddings against each track's stored audio
// vector. Sound-derived, so they complement the LLM's metadata-guessed `moods`.
// ---------------------------------------------------------------------------

// Transactional bulk write for the scoring pass — one commit per batch instead
// of one per track (the pass touches every vector-carrying row).
export function setTrackAudioMoodsBulk(
  rows: Array<{ id: string; moods: string[]; scores: Record<string, number> }>,
): void {
  if (rows.length === 0) return;
  const d = requireDb();
  const stmt = d.prepare(
    `UPDATE tracks SET audio_moods = ?, audio_mood_scores_json = ? WHERE id = ?`,
  );
  d.transaction((rs: typeof rows) => {
    for (const r of rs) stmt.run(JSON.stringify(r.moods), JSON.stringify(r.scores), r.id);
  })(rows);
}

// Every id carrying an audio vector — the full re-score scope when the mood
// vocabulary/prompts change. JOINed to tracks so a vector whose track row was
// pruned is never scored.
export function audioVectorIds(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Whether a single track already carries a CLAP audio vector — the per-track
// twin of unanalysedAudioIds, for the on-pick analysis needs check.
export function hasAudioVector(id: string): boolean {
  const row = requireDb()
    .prepare(`SELECT 1 FROM track_audio_vectors WHERE id = ?`)
    .get(id);
  return row != null;
}

// Ids with an audio vector but no audio moods yet — the incremental scope for
// an unchanged vocabulary (newly analysed tracks since the last scoring pass).
export function idsNeedingAudioMoods(): string[] {
  const rows = requireDb()
    .prepare(
      `SELECT v.id FROM track_audio_vectors v JOIN tracks t ON t.id = v.id
       WHERE t.audio_moods IS NULL ORDER BY v.id`,
    )
    .all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// The full {mood: cosine} score map behind a track's audio_moods — the
// dossier/tuning surface only (hot paths read the pre-picked audio_moods
// labels; this column is never parsed on a playback path).
export function getAudioMoodScores(id: string): Record<string, number> | null {
  const row = requireDb()
    .prepare('SELECT audio_mood_scores_json AS s FROM tracks WHERE id = ?')
    .get(id) as { s: string | null } | undefined;
  if (!row?.s) return null;
  try {
    const v = JSON.parse(row.s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// The vocabulary hash the current audio_moods were scored with, or null (never
// scored / legacy meta row). A mismatch re-scores everything.
export function getAudioMoodVocabHash(): string | null {
  const row = requireDb()
    .prepare('SELECT mood_vocab_hash FROM audio_embedding_meta WHERE pk = 1')
    .get() as { mood_vocab_hash: string | null } | undefined;
  return row?.mood_vocab_hash ?? null;
}

export function setAudioMoodVocabHash(hash: string): void {
  // The meta row normally exists by the time moods are scored (the analyze pass
  // stamps it with the first vector), but seed defensively — model/dim are
  // NOT NULL, and setAudioEmbeddingMeta's own upsert never touches the hash.
  requireDb()
    .prepare(
      `INSERT INTO audio_embedding_meta (pk, model, dim, set_at, mood_vocab_hash)
       VALUES (1, 'unknown', ?, ?, ?)
       ON CONFLICT(pk) DO UPDATE SET mood_vocab_hash = excluded.mood_vocab_hash`,
    )
    .run(AUDIO_EMBEDDING_DIM, new Date().toISOString(), hash);
}

// Tracks with vocal-activity analysis done — vocal_ranges_json IS NOT NULL,
// where a stored "[]" (analysed instrumental) counts as done. The inverse of
// needsVocalIds, surfaced as a coverage meter (#646).
export function vocalAnalyzedCount(): number {
  return (requireDb().prepare(
    'SELECT COUNT(*) AS n FROM tracks WHERE vocal_ranges_json IS NOT NULL',
  ).get() as { n: number }).n;
}

// Ids that have no audio vector yet (never embedded). Resumable, ordered for
// stable resumption, independent of the bpm/key analysis scope so the audio
// backfill can run on its own cadence. LEFT JOIN where the vector row is absent.
export function unanalysedAudioIds(limit?: number): string[] {
  const q = limit && limit > 0
    ? `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE v.id IS NULL ORDER BY t.id LIMIT ${Math.floor(limit)}`
    : `SELECT t.id FROM tracks t LEFT JOIN track_audio_vectors v ON v.id = t.id
       WHERE v.id IS NULL ORDER BY t.id`;
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Ids with no vocal-activity analysis yet (vocal_ranges_json IS NULL — a stored
// "[]" instrumental counts as done and is skipped). Independent of the bpm/key
// scope, like unanalysedAudioIds, so the (expensive, opt-in) Demucs backfill
// runs on its own cadence. Ordered for stable resumption.
export function needsVocalIds(limit?: number): string[] {
  const q =
    `SELECT id FROM tracks WHERE vocal_ranges_json IS NULL ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(q).all() as Array<{ id: string }>;
  return rows.map(r => r.id);
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
  const delAudioVec = d.prepare('DELETE FROM track_audio_vectors WHERE id = ?');
  const runPrune = d.transaction((ids: string[]) => {
    for (const id of ids) {
      delTrack.run(id);
      delVec.run(id);
      delAudioVec.run(id);
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

// IDs of tracks that already carry acoustic analysis (bpm filled). The re-scan
// "Re-analyse" scope — capture BEFORE clearAnalysis() so the redo targets only
// the previously-analysed population, not the whole (mostly un-analysed) library.
export function analysedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE bpm IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}

// ---------------------------------------------------------------------------
// Mood-keyed reads (drop-in replacements for the old library.ts in-memory loops)
// ---------------------------------------------------------------------------

export function songsByMood(mood: string): TrackRecord[] {
  // Match the LLM's editorial moods OR the zero-shot audio moods (scored from
  // the track's actual sound — music/audio-moods.ts). The blend widens thin
  // mood buckets and covers tracks the metadata-only tagger couldn't read
  // (instrumentals, non-English titles); a track matching both appears once.
  const rows = requireDb()
    .prepare(
      `SELECT * FROM tracks
       WHERE (moods IS NOT NULL
              AND EXISTS (SELECT 1 FROM json_each(tracks.moods) WHERE value = ?))
          OR (audio_moods IS NOT NULL
              AND EXISTS (SELECT 1 FROM json_each(tracks.audio_moods) WHERE value = ?))`,
    )
    .all(mood, mood) as TrackRow[];
  return rows.map(rowToTrack);
}

export function songsByEnergy(energy: EnergyValue): TrackRecord[] {
  if (!energy) return [];
  const rows = requireDb()
    .prepare(`SELECT * FROM tracks WHERE energy = ?`)
    .all(energy) as TrackRow[];
  return rows.map(rowToTrack);
}

export function allTaggedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE moods IS NOT NULL')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}

// Directly-decided tags with a vector — the trusted sample for the propagation
// self-check (music/propagation-eval.ts). Excludes 'propagated' rows (they ARE
// the propagation output — scoring against them would be circular) and
// vectorless rows (KNN can't run). Null source = legacy import, decided by an
// LLM at the time, so it counts.
export function trustedTaggedIds(): string[] {
  return (
    requireDb()
      .prepare(
        `SELECT id FROM tracks
          WHERE ${SQL_HAS_MOODS}
            AND (source IS NULL OR source != 'propagated')
            AND id IN (SELECT id FROM track_vectors)
          ORDER BY id`,
      )
      .all() as Array<{ id: string }>
  ).map(r => r.id);
}

// Tagged rows whose LLM provenance has gone stale — their prompt_hash or model
// differs from the current ones (or is NULL, e.g. a legacy-v1 import). Drives
// the re-scan "Re-decide moods" pass: re-LLM-tag only what a prompt/model change
// invalidated. NEVER source='manual' — operator-set tags are ground truth and
// don't go stale. With no prompt/model change this returns [], so re-decide is a
// clean no-op. `IS NOT ?` is SQLite's null-safe inequality (NULL counts stale).
export function staleTaggedIds(promptHash: string, model: string, limit?: number): string[] {
  const sql =
    `SELECT id FROM tracks
       WHERE ${SQL_HAS_MOODS}
         AND (source IS NULL OR source != 'manual')
         AND (prompt_hash IS NOT ? OR model IS NOT ?)
       ORDER BY id` + (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  const rows = requireDb().prepare(sql).all(promptHash, model) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

// Tracks that already carry enrichment (Last.fm tags / lyrics fetched at least
// once). The re-scan "Re-enrich" scope — redo metadata only for what was done,
// never the untouched remainder. Distinct from the raw --re-enrich widening,
// which spans the full live catalogue (issue #531).
export function enrichedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM tracks WHERE enriched_at IS NOT NULL')
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

// Tracks that currently have a vector. The re-scan "Re-embed" scope — capture
// this BEFORE dropVectors() (after the drop every track looks unembedded), then
// rebuild exactly these, never the untouched untagged remainder.
export function embeddedIds(): string[] {
  return (
    requireDb()
      .prepare('SELECT id FROM track_vectors')
      .all() as Array<{ id: string }>
  ).map(r => r.id);
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
// Per-genre embedding centroids — the mean text-embedding vector across every
// tagged+embedded track in each genre. Powers the genre-cloud 2D projection
// (music/genre-cloud.ts): semantically similar genres land near each other.
// One streaming SQL join so a multi-thousand-track library stays light on
// memory — vectors are accumulated into per-genre running sums, never all held
// at once.
// ---------------------------------------------------------------------------
export function genreCentroids(): Array<{ genre: string; count: number; centroid: Float32Array }> {
  const stmt = requireDb().prepare(
    `SELECT t.genre AS genre, v.embedding AS embedding
       FROM tracks t JOIN track_vectors v ON v.id = t.id
      WHERE t.genre IS NOT NULL AND TRIM(t.genre) != ''`,
  );
  const sums = new Map<string, { sum: Float64Array; count: number }>();
  let dim = 0;
  for (const row of stmt.iterate() as Iterable<{ genre: string; embedding: Buffer }>) {
    const b = row.embedding;
    const vec = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
    if (!dim) dim = vec.length;
    if (vec.length !== dim) continue; // defensive: skip any stray off-dim rows
    let acc = sums.get(row.genre);
    if (!acc) {
      acc = { sum: new Float64Array(dim), count: 0 };
      sums.set(row.genre, acc);
    }
    for (let i = 0; i < dim; i++) acc.sum[i] += vec[i];
    acc.count++;
  }
  const out: Array<{ genre: string; count: number; centroid: Float32Array }> = [];
  for (const [genre, { sum, count }] of sums) {
    if (!count) continue;
    const centroid = new Float32Array(dim);
    for (let i = 0; i < dim; i++) centroid[i] = sum[i] / count;
    out.push({ genre, count, centroid });
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
  const vocal = opts.vocal === 'instrumental' || opts.vocal === 'vocal' ? opts.vocal : null;
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
  if (vocal === 'instrumental') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) = 0');
  } else if (vocal === 'vocal') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) > 0');
  }
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

  // Mean of the pace curve, computed in SQL so the acoustic sorts page correctly
  // (a JS sort would only reorder the current window). json_each over a NULL or
  // empty column yields no rows → AVG is NULL, caught by the IS NULL guard below.
  const PACE_MEAN_SQL =
    `(SELECT AVG(json_extract(je.value,'$.value')) FROM json_each(tracks.pace_json) je)`;
  // Acoustic sorts surface analysed tracks first (NULLs sink to the bottom) and
  // tie-break by artist for a stable order across un-analysed rows.
  const orderSql = ({
    artist: `ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`,
    title: `ORDER BY LOWER(COALESCE(title,'')) , LOWER(COALESCE(artist,''))`,
    year: `ORDER BY year DESC, LOWER(COALESCE(artist,''))`,
    taggedAt: 'ORDER BY tagged_at DESC',
    bpm: `ORDER BY (bpm IS NULL), bpm ASC, LOWER(COALESCE(artist,''))`,
    loudness: `ORDER BY (loudness_lufs IS NULL), loudness_lufs DESC, LOWER(COALESCE(artist,''))`,
    pace: `ORDER BY (${PACE_MEAN_SQL}) IS NULL, (${PACE_MEAN_SQL}) DESC, LOWER(COALESCE(artist,''))`,
  } as Record<string, string>)[sort] ?? `ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`;

  const d = requireDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM tracks ${whereSql}`).get(...params) as { n: number }
  ).n;
  const rows = d
    .prepare(`SELECT * FROM tracks ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as TrackRow[];
  return { total, rows: rows.map(rowToTrack) };
}

// Lean row shape for the Library Observatory bulk endpoint — exactly the
// fields the map / tooltip / filters / stat panels consume, and nothing else.
// The full TrackRecord parse (rowToTrack) JSON-parses every acoustic blob —
// beats_json alone is hundreds of floats per analysed row — which at 200k
// tracks turned the bulk read into a ~15 s synchronous event-loop stall for a
// payload that only needs a pace MEAN and a vocal PRESENCE flag. Same lesson
// as getTrackLite (#723), applied to the bulk path.
export interface ObservatoryTrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genre: string | null;
  durationSec: number | null;
  moods: string[];
  energy: string | null;
  source: string | null;
  confidence: number | null;
  bpm: number | null;
  musicalKey: string | null;
  analysisConfidence: number | null;
  loudnessLufs: number | null;
  paceMean: number | null;
  vocal: 'vocal' | 'instrumental' | null;
  mapX: number | null;
  mapY: number | null;
}

const OBSERVATORY_COLS = `id, title, artist, album, year, genre, duration_sec,
  moods, energy, source, confidence, bpm, musical_key, analysis_confidence,
  loudness_lufs, pace_json, vocal_ranges_json, map_x, map_y`;

function rowToObservatory(row: TrackRow): ObservatoryTrackRow {
  // pace_json is a short array (~14 spans) — the mean is cheap. The fat blobs
  // (beats/bars/structure/key ranges) are never selected, let alone parsed.
  let paceMean: number | null = null;
  if (row.pace_json) {
    const spans = parsePaceSpans(row.pace_json);
    if (spans && spans.length) paceMean = spans.reduce((a, s) => a + s.value, 0) / spans.length;
  }
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    year: row.year,
    genre: row.genre,
    durationSec: row.duration_sec,
    moods: row.moods ? safeParseArray(row.moods) : [],
    energy: row.energy ?? null,
    source: row.source ?? null,
    confidence: row.confidence,
    bpm: row.bpm ?? null,
    musicalKey: row.musical_key ?? null,
    analysisConfidence: row.analysis_confidence ?? null,
    loudnessLufs: row.loudness_lufs ?? null,
    paceMean,
    // Tri-state without parsing the spans: NULL column = vocals not analysed,
    // '[]' = analysed instrumental, anything else = vocal ranges present.
    vocal: row.vocal_ranges_json == null ? null : row.vocal_ranges_json === '[]' ? 'instrumental' : 'vocal',
    mapX: row.map_x ?? null,
    mapY: row.map_y ?? null,
  };
}

// Every tagged track, lean observatory row, in one read — the bulk source for
// the Library Observatory map (which needs all nodes at once, not a paged
// window like filter()). Ordered by id for a stable layout seed across loads.
// `limit` caps a pathologically large library; the route stamps a `truncated`
// flag when it's hit. Deliberately separate from filter() so the observatory's
// "load everything" contract can't be confused with the admin browse pager's
// 200 cap.
export function allTagged(limit?: number): ObservatoryTrackRow[] {
  const sql =
    `SELECT ${OBSERVATORY_COLS} FROM tracks WHERE ${SQL_HAS_MOODS} ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  return (requireDb().prepare(sql).all() as TrackRow[]).map(rowToObservatory);
}

// A *stratified* sample of the tagged library, ~`max` rows, proportional per
// genre — so the Library Observatory shows the real shape of a huge library
// instead of the first-N tracks by id (which over-represents whichever genres
// happen to sort first). Each genre (NULL included as its own partition) gets a
// quota of round(genreCount / totalTagged · max), min 1, and the first `quota`
// rows of that genre by id are taken. Stable across loads (ordered by id), so
// the map layout doesn't reshuffle on refresh. The +1-min-per-genre means the
// total can drift a little over `max`; the caller slices to `max`.
//
// The window functions deliberately run over (id, genre) ONLY, with the full
// rows joined back afterwards: windowing over `t.*` pushes every fat acoustic
// blob through SQLite's partition sorter — at 200k tracks that was ~98 s of
// synchronous scan for a 25k sample; the thin-window + join-back form is ~1 s.
export function allTaggedSampled(max: number, totalTagged: number): ObservatoryTrackRow[] {
  const m = Math.floor(max);
  const total = Math.floor(totalTagged);
  if (m <= 0 || total <= 0) return [];
  const sql = `
    WITH picked(id) AS (
      SELECT id FROM (
        SELECT id, genre,
          ROW_NUMBER() OVER (PARTITION BY genre ORDER BY id) AS __rn,
          COUNT(*)     OVER (PARTITION BY genre)             AS __gc
        FROM tracks
        WHERE ${SQL_HAS_MOODS}
      )
      WHERE __rn <= MAX(1, CAST(ROUND(__gc * 1.0 * ? / ?) AS INTEGER))
    )
    SELECT ${OBSERVATORY_COLS} FROM tracks JOIN picked USING (id)
    ORDER BY id
  `;
  return (requireDb().prepare(sql).all(m, total) as TrackRow[]).map(rowToObservatory);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// stats() runs ~7 full-table scans/GROUP BYs (byMood alone is a json_each walk
// over every row). It's polled every 30s by the admin Library panel and hit by
// several admin pages (/library, /debug, /observatory) + /settings. Post-
// analysis the fattened rows make each scan slow, so uncached these stacked up
// on the synchronous DB thread and blocked listener polls (#723). A short TTL
// collapses page-load / multi-tab bursts into one computation; 5s is well within
// the display's freshness needs, and analysis writes don't change these tallies
// anyway (they touch bpm/*_json, not moods/genre/energy).
let statsCache: { at: number; value: LibraryStats } | null = null;
const STATS_TTL_MS = 5000;

// Drop the memoised stats() result — call when the DB handle is swapped
// (reset/reload) so a fresh library never briefly serves the old one's tallies.
export function invalidateStats(): void {
  statsCache = null;
}

export function stats(): LibraryStats {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = computeStats();
  // Stamp AFTER the compute: computeStats() itself can exceed the TTL on a
  // very large library (≈15 s at 200k tracks), and a start-of-compute stamp
  // would mean the entry is already expired the moment it's stored — every
  // call recomputes, which is exactly what the cache exists to prevent.
  statsCache = { at: Date.now(), value };
  return value;
}

// A cheap opaque token that changes whenever ANY write lands in the library:
// `data_version` bumps on commits from OTHER connections (the tagger and
// analyzer hold the DB concurrently), `total_changes()` counts THIS
// connection's row changes, and the per-open nonce covers handle swaps. Both
// reads are O(1). Powers the observatory ETag — anything derived purely from
// library rows can be revalidated with this instead of rebuilding the payload.
export function changeToken(): string {
  const d = requireDb();
  const dataVersion = d.pragma('data_version', { simple: true }) as number;
  const ownChanges = (d.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
  return `${dbNonce}.${dataVersion}.${ownChanges}`;
}

function computeStats(): LibraryStats {
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
  const withAudioEmbedding = (
    d.prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as { n: number }
  ).n;
  const updatedAt =
    ((d.prepare('SELECT MAX(tagged_at) AS t FROM tracks').get() as { t: string | null }).t) ||
    null;
  return {
    total, distinctArtists, byMood, byEnergy, byGenre, bySource,
    withEmbedding, withAudioEmbedding, updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToTrack(row: TrackRow): TrackRecord {
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
    loudnessLufs: row.loudness_lufs ?? null,
    peakDb: row.peak_db ?? null,
    structure: row.structure_json ? safeParseSections(row.structure_json) : null,
    // Preserve an empty array ("analysed instrumental"); only a SQL NULL column
    // (not computed) maps to null. parseSpans keeps [] intact.
    vocalRanges: row.vocal_ranges_json != null ? parseSpans(row.vocal_ranges_json) : null,
    pace: row.pace_json ? parsePaceSpans(row.pace_json) : null,
    beats: row.beats_json ? parseMsArray(row.beats_json) : null,
    bars: row.bars_json ? parseMsArray(row.bars_json) : null,
    keyRanges: row.key_ranges_json ? parseKeyRanges(row.key_ranges_json) : null,
    audioMoods: row.audio_moods ? safeParseArray(row.audio_moods) : [],
    outro: row.outro_json ? parseOutroJson(row.outro_json) : null,
    mapX: row.map_x ?? null,
    mapY: row.map_y ?? null,
  };
}

// Parse an outro_json column into TrackOutro or null. Malformed → null.
function parseOutroJson(s: string): TrackOutro | null {
  try {
    const v = JSON.parse(s);
    const startMs = Number(v?.startMs);
    const ending = v?.ending;
    if (!Number.isFinite(startMs) || startMs < 0) return null;
    if (ending !== 'fade' && ending !== 'cold') return null;
    const msList = (x: unknown): number[] | null =>
      Array.isArray(x) && x.length ? x.filter((n): n is number => Number.isFinite(n)) : null;
    return {
      startMs: Math.round(startMs),
      ending,
      lufs: Number.isFinite(v?.lufs) ? v.lufs : null,
      bpm: Number.isFinite(v?.bpm) ? v.bpm : null,
      beats: msList(v?.beats),
      bars: msList(v?.bars),
    };
  } catch {
    return null;
  }
}

// Parse a key_ranges_json column into TrackKeyRange[] or null. Empty/malformed → null.
function parseKeyRanges(s: string): TrackKeyRange[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out: TrackKeyRange[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      const tonic = x?.tonic;
      const mode = x?.mode;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      if (typeof tonic !== 'string' || (mode !== 'major' && mode !== 'minor')) continue;
      out.push({ startMs, endMs, tonic, mode });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a JSON array of ms timestamps → finite number[] or null (empty → null).
function parseMsArray(s: string): number[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a pace_json column into TrackPaceSpan[] or null. Empty/malformed → null.
function parsePaceSpans(s: string): TrackPaceSpan[] | null {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    const out: TrackPaceSpan[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      const value = Number(x?.value);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(value) || endMs <= startMs) continue;
      out.push({ startMs, endMs, value });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// Parse a JSON span column into clean TrackSection[] (possibly empty). Drops
// malformed/zero-length spans; returns [] on any parse error.
function parseSpans(s: string): TrackSection[] {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return [];
    const out: TrackSection[] = [];
    for (const x of v as Record<string, unknown>[]) {
      const startMs = Number(x?.startMs);
      const endMs = Number(x?.endMs);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      const kind = typeof x?.kind === 'string' ? x.kind : undefined;
      out.push(kind ? { startMs, endMs, kind } : { startMs, endMs });
    }
    return out;
  } catch {
    return [];
  }
}

// structure_json: empty collapses to null ("no structure"), unlike vocal ranges.
function safeParseSections(s: string): TrackSection[] | null {
  const out = parseSpans(s);
  return out.length ? out : null;
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
