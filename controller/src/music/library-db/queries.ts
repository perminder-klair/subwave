// Mood- and tag-keyed reads — the drop-in replacements for the old in-memory
// loops in library.ts — plus the per-genre embedding centroids.

import { SQL_HAS_MOODS, SQL_NO_MOODS, requireDb } from './handle.js';
import type { EnergyValue, TrackRecord, TrackRow } from './types.js';
import { rowToTrack, safeParseArray } from './rows.js';

// ---------------------------------------------------------------------------
// Blocklist-rule match counting (admin Blocked tab)
// ---------------------------------------------------------------------------

// Every row, projected down to exactly the fields blocklist-rules.ruleMatches
// reads. Deliberately NOT rowToTrack (which parses the full analysis surface):
// GET /library/blocklist runs this over the whole library per request to show
// per-rule match counts, and the slim projection keeps that a one-shot scan.
export function ruleMatchRows(): Array<{
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  genres: string[] | null;
  genre: string | null;
  moods: string[] | null;
  audioMoods: string[] | null;
  lastfmTags: string[] | null;
}> {
  const rows = requireDb()
    .prepare(`SELECT id, title, artist, album, genres, genre, moods, audio_moods, lastfm_tags FROM tracks`)
    .all() as Array<Record<string, any>>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? null,
    artist: r.artist ?? null,
    album: r.album ?? null,
    genres: r.genres ? safeParseArray(r.genres) : null,
    genre: r.genre ?? null,
    moods: r.moods ? safeParseArray(r.moods) : null,
    audioMoods: r.audio_moods ? safeParseArray(r.audio_moods) : null,
    lastfmTags: r.lastfm_tags ? safeParseArray(r.lastfm_tags) : null,
  }));
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
// stratify so rare-mood corners of the library each get a seed pick. The CASE
// is the SQL twin of era-year.resolveEraYear: original wins, an unresolved
// compilation/anthology is unknown, then a trusted file year may fall through.
export function trackIdsByGenreDecade(): Map<string, string[]> {
  const rows = requireDb()
    .prepare(
      `SELECT id, COALESCE(genre, '') AS g,
              CASE
                WHEN original_year > 0 THEN (original_year / 10) * 10
                WHEN is_compilation = 1 OR era_untrusted = 1 THEN 0
                WHEN year > 0 THEN (year / 10) * 10
                ELSE 0
              END AS decade
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
// tagged+embedded track in each genre, so semantically similar genres land near
// each other. Consumed by music/genre-suggest.ts. One streaming SQL join keeps a
// multi-thousand-track library light on memory — vectors accumulate into
// per-genre running sums rather than all being held at once.
// ---------------------------------------------------------------------------
export function genreCentroids(): Array<{ genre: string; count: number; centroid: Float32Array }> {
  // json_each over the multi-genre array: a Hip-Hop + Rap track contributes
  // its vector to BOTH centroids — each genre's centroid should reflect every
  // track that carries the tag, not just those where it happens to be primary.
  const stmt = requireDb().prepare(
    `SELECT je.value AS genre, v.embedding AS embedding
       FROM tracks t
       JOIN track_vectors v ON v.id = t.id, json_each(t.genres) je
      WHERE je.value IS NOT NULL AND TRIM(je.value) != ''`,
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
// Lean, whole-library projection for the explicit Show-editor candidate
// diagnostic. It avoids the heavyweight analysis JSON that full track reads
// carry while retaining every field used by the strict show locks.
export function candidateFilterTracks(): Array<{
  id: string;
  title: string | null;
  artist: string | null;
  year: number | null;
  originalYear: number | null;
  isCompilation: boolean | null;
  yearUntrusted: boolean | null;
  genres: string[];
  genre: string | null;
  moods: string[];
  audioMoods: string[];
  energy: EnergyValue;
  vocalRanges: unknown[] | null;
}> {
  type CandidateFilterRow = {
    id: string;
    title: string | null;
    artist: string | null;
    year: number | null;
    original_year: number | null;
    is_compilation: number | null;
    era_untrusted: number | null;
    genres: string | null;
    genre: string | null;
    moods: string | null;
    audio_moods: string | null;
    energy: EnergyValue;
    vocal_range_count: number | null;
  };
  const rows = requireDb().prepare(`SELECT id, title, artist, year, original_year,
    is_compilation, era_untrusted, genres, genre, moods, audio_moods, energy,
    CASE
      WHEN vocal_ranges_json IS NULL THEN NULL
      WHEN json_valid(vocal_ranges_json) AND json_type(vocal_ranges_json) = 'array'
        THEN json_array_length(vocal_ranges_json)
      ELSE NULL
    END AS vocal_range_count
    FROM tracks`).all() as CandidateFilterRow[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? null,
    artist: row.artist ?? null,
    year: row.year ?? null,
    originalYear: row.original_year ?? null,
    isCompilation: row.is_compilation == null ? null : !!row.is_compilation,
    yearUntrusted: (row.is_compilation === 1 || row.era_untrusted === 1)
      ? true
      : (row.is_compilation == null && row.era_untrusted == null ? null : false),
    genres: row.genres ? safeParseArray(row.genres) : [],
    genre: row.genre ?? null,
    moods: row.moods ? safeParseArray(row.moods) : [],
    audioMoods: row.audio_moods ? safeParseArray(row.audio_moods) : [],
    energy: row.energy ?? null,
    // The show filter only reads this field's tri-state: null = unmeasured,
    // [] = instrumental, non-empty = vocal. Keep the projection lean by
    // carrying presence rather than parsing every stored span object.
    vocalRanges: row.vocal_range_count == null
      ? null
      : row.vocal_range_count === 0 ? [] : [{}],
  }));
}
