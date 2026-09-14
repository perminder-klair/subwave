// The open database handle and shared constants. lifecycle.ts owns open/close;
// everyone else reaches the handle through requireDb(). Keeps library-db/ acyclic.

import Database from 'better-sqlite3';
import { STATE_DIR } from '../../config.js';


export const DB_PATH = `${STATE_DIR}/library.db`;
export const LEGACY_MOODS_JSON = `${STATE_DIR}/moods.json`;

// Stored on every row the tagger writes. Bump when the on-disk shape changes;
// upgrade scripts filter on WHERE tagger_version < N.
export const TAGGER_VERSION = 3;

// Stored on every row the analyze pass writes, independent of TAGGER_VERSION.
// Bump when the analysis shape or method changes.
// v2: added integrated loudness (loudness_lufs) + peak (peak_db).
// v3: added structural sections (structure_json).
// v4: added the pace curve (pace_json).
// v5: added the beat/bar grid (beats_json, bars_json).
// v6: added per-region key ranges (key_ranges_json).
// v7: added edge dead air (lead_silence_ms, tail_silence_ms, tail_start_ms).
export const ANALYSIS_VERSION = 7;

// CLAP audio-embedding dim, fixed by the model — no per-model negotiation, and a
// different space from the text vectors, in its own vec0 table.
export const AUDIO_EMBEDDING_DIM = 512;

// A track is "tagged" only with at least one mood. '[]' is written by the legacy
// migration, by the tagger on an empty LLM answer and by analysis-only rows, so
// `moods IS NOT NULL` alone would count those. Gate on a non-empty array.
export const SQL_HAS_MOODS = `moods IS NOT NULL AND json_array_length(moods) > 0`;
export const SQL_NO_MOODS = `(moods IS NULL OR json_array_length(moods) = 0)`;

let db: Database.Database | null = null;
let currentEmbeddingDim: number | null = null;
// Minted per open(), so change tokens from different handles are never
// comparable and a stale 304 can't survive a swap.
let dbNonce = '0';

// For callers distinguishing "never opened" from "open"; otherwise use requireDb().
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

// Written only by lifecycle.ts's open()/close(); it lives here so nothing else has
// to import lifecycle to reach the handle.
export function setHandle(next: {
  db?: Database.Database | null;
  embeddingDim?: number | null;
  nonce?: string;
}): void {
  if ('db' in next) db = next.db ?? null;
  if ('embeddingDim' in next) currentEmbeddingDim = next.embeddingDim ?? null;
  if (next.nonce !== undefined) dbNonce = next.nonce;
}


