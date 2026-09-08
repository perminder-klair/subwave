// The admin library browse panel's filter query and the Observatory's
// wide-row projection.

import { SQL_HAS_MOODS, requireDb } from './handle.js';
import type { FilterOpts, TrackRecord, TrackRow } from './types.js';
import { parsePaceSpans, rowToTrack, safeParseArray } from './rows.js';

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

  // Tagged tracks only, else rows the metadata/analysis walk inserted show up here.
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
  // Any-of over the multi-genre array, matching show-filter/picker semantics.
  if (genre) {
    where.push(`EXISTS (SELECT 1 FROM json_each(tracks.genres) WHERE value = ?)`);
    params.push(genre);
  }
  if (vocal === 'instrumental') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) = 0');
  } else if (vocal === 'vocal') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) > 0');
  }
  // SQL twin of show-filter's resolveEraYear (#842/#1418); the OR is
  // `yearUntrusted`'s composition and the two must move together.
  const ERA_YEAR_SQL =
    `COALESCE(original_year, CASE WHEN is_compilation = 1 OR era_untrusted = 1 THEN NULL ELSE year END)`;
  if (yearFrom != null) { where.push(`${ERA_YEAR_SQL} >= ?`); params.push(yearFrom); }
  if (yearTo != null) { where.push(`${ERA_YEAR_SQL} <= ?`); params.push(yearTo); }
  if (q) {
    where.push(
      `(LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(artist,'')) LIKE ? OR LOWER(COALESCE(album,'')) LIKE ?)`,
    );
    const pat = `%${q}%`;
    params.push(pat, pat, pat);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Mean pace in SQL so acoustic sorts page correctly; json_each over a NULL
  // column yields no rows, so AVG is NULL and the IS NULL guards below catch it.
  const PACE_MEAN_SQL =
    `(SELECT AVG(json_extract(je.value,'$.value')) FROM json_each(tracks.pace_json) je)`;
  const DEFAULT_ORDER =
    `ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`;
  // Null-prototype so an unknown `sort` can only miss: `sort` is unchecked query
  // input, and `__proto__`/`toString` off a literal would reach the SQL.
  const ORDER_BY: Record<string, string> = Object.assign(Object.create(null), {
    artist: DEFAULT_ORDER,
    title: `ORDER BY LOWER(COALESCE(title,'')) , LOWER(COALESCE(artist,''))`,
    year: `ORDER BY year DESC, LOWER(COALESCE(artist,''))`,
    taggedAt: 'ORDER BY tagged_at DESC',
    bpm: `ORDER BY (bpm IS NULL), bpm ASC, LOWER(COALESCE(artist,''))`,
    loudness: `ORDER BY (loudness_lufs IS NULL), loudness_lufs DESC, LOWER(COALESCE(artist,''))`,
    pace: `ORDER BY (${PACE_MEAN_SQL}) IS NULL, (${PACE_MEAN_SQL}) DESC, LOWER(COALESCE(artist,''))`,
  });
  const orderSql = ORDER_BY[sort] ?? DEFAULT_ORDER;

  const d = requireDb();
  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM tracks ${whereSql}`).get(...params) as { n: number }
  ).n;
  const rows = d
    .prepare(`SELECT * FROM tracks ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as TrackRow[];
  return { total, rows: rows.map(rowToTrack) };
}

// Lean row shape for the Observatory bulk endpoint. rowToTrack would JSON-parse
// every acoustic blob (~15s synchronous at 200k tracks) for a payload needing only
// a pace mean and a vocal flag (#723).
interface ObservatoryTrackRow {
  id: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  year: number | null;
  genres: string[];
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

const OBSERVATORY_COLS = `id, title, artist, album, year, genres, genre, duration_sec,
  moods, energy, source, confidence, bpm, musical_key, analysis_confidence,
  loudness_lufs, pace_json, vocal_ranges_json, map_x, map_y`;

export function rowToObservatory(row: TrackRow): ObservatoryTrackRow {
  // ~14 spans, so the mean is cheap; the fat blobs are never selected.
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
    genres: row.genres ? safeParseArray(row.genres) : [],
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
    // NULL = not analysed, '[]' = instrumental, anything else = vocal.
    vocal: row.vocal_ranges_json == null ? null : row.vocal_ranges_json === '[]' ? 'instrumental' : 'vocal',
    mapX: row.map_x ?? null,
    mapY: row.map_y ?? null,
  };
}

// Every tagged track in one read: the Observatory map needs all nodes at once.
// Ordered by id for a stable layout seed; `limit` caps a huge library and the
// route stamps `truncated`. Separate from filter() so the 200-row browse cap
// can't be confused with this contract.
export function allTagged(limit?: number): ObservatoryTrackRow[] {
  const sql =
    `SELECT ${OBSERVATORY_COLS} FROM tracks WHERE ${SQL_HAS_MOODS} ORDER BY id` +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : '');
  return (requireDb().prepare(sql).all() as TrackRow[]).map(rowToObservatory);
}

// Stratified sample of ~`max` rows, proportional per genre (NULL is its own
// partition), each taking its first round(gc/total*max) rows by id, min 1 — so the
// total can exceed `max` and the caller slices. Window functions run over
// (id, genre) ONLY with rows joined back: windowing over `t.*` pushes every fat
// acoustic blob through SQLite's partition sorter (~98s at 200k tracks vs ~1s).
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


