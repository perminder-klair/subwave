// The admin library browse panel's filter query and the Observatory's
// wide-row projection.

import { SQL_HAS_MOODS, requireDb } from './handle.js';
import type { FilterOpts, TrackRecord, TrackRow } from './types.js';
import { parsePaceSpans, rowToTrack, safeParseArray } from './rows.js';

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
  // Any-of over the multi-genre array, so a track tagged Hip-Hop + Rap shows
  // under either filter — matching the show-filter/picker semantics.
  if (genre) {
    where.push(`EXISTS (SELECT 1 FROM json_each(tracks.genres) WHERE value = ?)`);
    params.push(genre);
  }
  if (vocal === 'instrumental') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) = 0');
  } else if (vocal === 'vocal') {
    where.push('vocal_ranges_json IS NOT NULL AND json_array_length(vocal_ranges_json) > 0');
  }
  // Era-year semantics (issue #842/#1418): the resolved original year wins; a
  // plain `year` only counts when the album's own year is TRUSTED — i.e. it is
  // neither flagged a compilation nor judged an anthology by
  // music/era-suspect.ts at walk time. Mirrors show-filter's resolveEraYear
  // (which reads the composed `yearUntrusted`) so SQL-side and JS-side era
  // filtering agree; the OR here IS that composition, and the two must move
  // together.
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

  // Mean of the pace curve, computed in SQL so the acoustic sorts page correctly
  // (a JS sort would only reorder the current window). json_each over a NULL or
  // empty column yields no rows → AVG is NULL, caught by the IS NULL guard below.
  const PACE_MEAN_SQL =
    `(SELECT AVG(json_extract(je.value,'$.value')) FROM json_each(tracks.pace_json) je)`;
  // Acoustic sorts surface analysed tracks first (NULLs sink to the bottom) and
  // tie-break by artist for a stable order across un-analysed rows.
  const DEFAULT_ORDER =
    `ORDER BY LOWER(COALESCE(artist,'')) , LOWER(COALESCE(album,'')) , LOWER(COALESCE(title,''))`;
  // Null-prototype so an unknown `sort` can only ever miss. `sort` reaches here
  // from req.query.sort cast straight to a string union with no runtime check
  // (routes/library.ts), and a plain object literal would resolve the reserved
  // names — `sort=constructor`, `__proto__`, `toString` — to something truthy
  // off Object.prototype, skipping the `??` fallback and interpolating it into
  // the SQL below. Today that only yields invalid SQL and a 500 on an
  // admin-gated read, but it is one refactor away from being a real sink.
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

// Lean row shape for the Library Observatory bulk endpoint — exactly the
// fields the map / tooltip / filters / stat panels consume, and nothing else.
// The full TrackRecord parse (rowToTrack) JSON-parses every acoustic blob —
// beats_json alone is hundreds of floats per analysed row — which at 200k
// tracks turned the bulk read into a ~15 s synchronous event-loop stall for a
// payload that only needs a pace MEAN and a vocal PRESENCE flag. Same lesson
// as getTrackLite (#723), applied to the bulk path.
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


