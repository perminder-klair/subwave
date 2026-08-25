// The open database handle and the constants every other library-db module
// shares. This is the seam that keeps the rest of library-db/ free of an import
// cycle: lifecycle.ts owns opening and closing the handle, everyone else reaches
// it through requireDb().

import Database from 'better-sqlite3';
import { STATE_DIR } from '../../config.js';


export const DB_PATH = `${STATE_DIR}/library.db`;
export const LEGACY_MOODS_JSON = `${STATE_DIR}/moods.json`;

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
// v7: added edge dead air (lead_silence_ms, tail_silence_ms, tail_start_ms).
export const ANALYSIS_VERSION = 7;

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
export const SQL_HAS_MOODS = `moods IS NOT NULL AND json_array_length(moods) > 0`;
export const SQL_NO_MOODS = `(moods IS NULL OR json_array_length(moods) = 0)`;

let db: Database.Database | null = null;
let currentEmbeddingDim: number | null = null;
// Minted per open() — makes change tokens from different handles (restart,
// reload, restore-from-backup) never comparable, so a stale 304 can't happen
// across a swap even though both counters below restart from scratch.
let dbNonce = '0';

// The handle, null included — for callers that need to distinguish "never
// opened" from "open". Everyone who needs a live handle wants requireDb().
export function getDb(): Database.Database | null {
  return db;
}

export function requireDb(): Database.Database {
  if (!db) throw new Error('library-db not opened — call open() first');
  return db;
}

export function getEmbeddingDim(): number | null {
  return currentEmbeddingDim;
}

export function getDbNonce(): string {
  return dbNonce;
}

// Written only by lifecycle.ts's open()/close(). It lives here rather than
// there so no other module has to import lifecycle just to reach the handle,
// which is what would reintroduce the cycle.
export function setHandle(next: {
  db?: Database.Database | null;
  embeddingDim?: number | null;
  nonce?: string;
}): void {
  if ('db' in next) db = next.db ?? null;
  if ('embeddingDim' in next) currentEmbeddingDim = next.embeddingDim ?? null;
  if (next.nonce !== undefined) dbNonce = next.nonce;
}


