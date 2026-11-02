// Library-wide counts for the admin dashboard, cached because the aggregate scan
// is the most expensive read in this module.

import { SQL_HAS_MOODS, getDbNonce, requireDb } from './handle.js';
import type { LibraryStats } from './types.js';

// Aggregate scans, polled from several admin pages; uncached they block
// listener polls on the synchronous DB thread (#723). `token` is the
// changeToken() read before the compute: while it still matches, no
// connection has committed since, so the tallies cannot have moved and the
// cache holds past its TTL (#1937).
let statsCache: { at: number; token: string; value: LibraryStats } | null = null;
const STATS_TTL_MS = 5000;

// EMBEDDED tracks whose vector carries no musical signal, only the head line
// (#1246), so similarity ranks them by artist/album wording. The five predicates
// mirror formatTrackText's optional lines and must stay in step with it. Long TTL
// because it only moves when the tagger runs and is read on a pick path
// (picker/scope.ts); invalidateStats() clears it on a handle swap.
const LABEL_ONLY_TTL_MS = 5 * 60 * 1000;
let labelOnlyCache: { at: number; value: number } | null = null;

export function labelOnlyVectorCount(): number {
  const now = Date.now();
  if (labelOnlyCache && now - labelOnlyCache.at < LABEL_ONLY_TTL_MS) return labelOnlyCache.value;
  const value = computeLabelOnlyVectorCount();
  labelOnlyCache = { at: Date.now(), value };
  return value;
}

function computeLabelOnlyVectorCount(): number {
  return (requireDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM track_vectors v
         JOIN tracks t ON t.id = v.id
        WHERE (t.lastfm_tags   IS NULL OR t.lastfm_tags   = '' OR t.lastfm_tags   = '[]')
          AND (t.lyric_excerpt IS NULL OR t.lyric_excerpt = '')
          AND (t.audio_moods   IS NULL OR t.audio_moods   = '' OR t.audio_moods   = '[]')
          AND (t.bpm IS NULL OR t.bpm <= 0)
          AND (t.musical_key   IS NULL OR t.musical_key   = '')`,
    )
    .get() as { n: number }).n;
}

// Call on a DB handle swap so a fresh library never serves stale tallies.
export function invalidateStats(): void {
  statsCache = null;
  labelOnlyCache = null;
  pickStatsCache = null;
  if (pickStatsRefresh) {
    clearTimeout(pickStatsRefresh);
    pickStatsRefresh = null;
  }
}

// The five numbers a live pick reads (#1723), without the dashboard's ~9 full
// scans. stats() above expires after 5 s and picks are minutes apart, so every
// pick paid the whole dashboard bill on the synchronous DB thread (4.6 s on a
// 76k-track library, measured with trace.phase). These only move when the
// library is walked or tagged, and they size recency windows and gate show
// locks, so a few minutes of staleness is harmless. The tagged total and
// distinct artists come from a partial index; the coverage checks stop at the
// first matching row.
const PICK_STATS_TTL_MS = 10 * 60 * 1000;

export interface PickStats {
  total: number;              // tagged tracks
  mirrorTotal: number;        // every row
  distinctArtists: number;    // among tagged tracks
  withEmbedding: number;      // text vectors (tool registration + notes)
  withAudioEmbedding: number; // CLAP vectors
  hasMoodCoverage: boolean;
  hasEnergyCoverage: boolean;
  // Tagged tracks per mood, as stats().byMood: the picker registers a mood tool
  // only for covered moods (#1687's moodWildcard reads it), so leaving it out
  // silently drops that tool from every live pick.
  byMood: Record<string, number>;
}

// After the TTL a pick still gets the last numbers at once; the recompute runs
// off the pick path, a little later. Only the very first call (or the first
// after invalidateStats) computes inline.
const PICK_STATS_REFRESH_DELAY_MS = 15_000;

let pickStatsCache: { at: number; value: PickStats } | null = null;
let pickStatsRefresh: ReturnType<typeof setTimeout> | null = null;

function schedulePickStatsRefresh(): void {
  if (pickStatsRefresh) return;
  const nonce = getDbNonce();
  pickStatsRefresh = setTimeout(() => {
    pickStatsRefresh = null;
    // A handle swap in between already cleared the cache; the next call recomputes.
    if (getDbNonce() !== nonce || !pickStatsCache) return;
    try {
      pickStatsCache = { at: Date.now(), value: computePickStats() };
    } catch (err) {
      console.warn('[library-db] pick stats refresh failed:', (err as Error).message);
    }
  }, PICK_STATS_REFRESH_DELAY_MS);
  pickStatsRefresh.unref?.();
}

export function pickStats(): PickStats {
  const now = Date.now();
  if (pickStatsCache && now - pickStatsCache.at < PICK_STATS_TTL_MS) return pickStatsCache.value;
  // A fresh dashboard read (admin open) already holds every number: reuse it.
  if (statsCache && now - statsCache.at < STATS_TTL_MS) {
    const s = statsCache.value;
    const value: PickStats = {
      total: s.total,
      mirrorTotal: s.mirrorTotal,
      distinctArtists: s.distinctArtists,
      withEmbedding: s.withEmbedding,
      withAudioEmbedding: s.withAudioEmbedding,
      hasMoodCoverage: Object.keys(s.byMood ?? {}).length > 0,
      hasEnergyCoverage: Object.keys(s.byEnergy ?? {}).length > 0,
      byMood: { ...(s.byMood ?? {}) },
    };
    pickStatsCache = { at: now, value };
    return value;
  }
  if (pickStatsCache) {
    schedulePickStatsRefresh();
    return pickStatsCache.value;
  }
  const value = computePickStats();
  pickStatsCache = { at: Date.now(), value };
  return value;
}

// Tagged-track counts without the wide tracks rows (#1723): the tagged total and
// the distinct-artist count are answered from this covering index alone. The
// index condition is JSON-free on purpose: a partial index WHERE runs on every
// write, and json_array_length() there would refuse to save a row whose moods
// JSON is malformed. The JSON check runs at query time on the indexed moods
// copy instead. Created at open, outside the user_version chain so it never
// takes an upstream migration number; idempotent, built once (~1 s at 76k).
//
// The rest serve the admin console's counts (#1937). A tracks row carries
// kilobytes of analysis JSON, so any scan of the table reads close to the whole
// file, and the coverage meter alone ran four of them per poll (every 3 s
// during a tagging run). Each index answers its count without touching a row:
//   idx_tracks_analysed       analysedCount()       (bpm IS NOT NULL)
//   idx_tracks_vocal_measured vocalAnalyzedCount()  an expression index, not a
//     partial one: a partial index whose key isn't the predicate column stops
//     being chosen once ANALYZE has stats for it, and the column is a JSON blob
//   idx_tracks_fail_count     analysisFailedCount() (few rows; partial)
//   idx_tracks_stats          computeStats()' tagged scans, covering every
//     column they read so they skip the wide rows
// Every condition is JSON-free for the same reason as the index above.
//
// Accelerators, not schema: every count they serve is exact without them, only
// slower. So a build that fails must not fail open(). The first open after an
// upgrade builds them in whichever process opens first, and a rival opener
// (the tagger or analyzer child) waits on that build's write lock for the busy
// timeout and then gets SQLITE_BUSY. A full disk fails it the same way. Warn,
// keep what was built, and leave the rest to the next open.
//
// Each build is a full scan on the opener's thread, seconds on NAS-class
// storage, so it is logged with its time rather than looking like a hang. One
// sqlite_master read per open finds what is missing; with nothing missing,
// nothing is built or logged.
const STATS_INDEXES: Array<[name: string, sql: string]> = [
  ['idx_tracks_tagged_artist', 'CREATE INDEX IF NOT EXISTS idx_tracks_tagged_artist ON tracks(LOWER(TRIM(artist)), moods) WHERE moods IS NOT NULL'],
  ['idx_tracks_analysed', 'CREATE INDEX IF NOT EXISTS idx_tracks_analysed ON tracks(bpm) WHERE bpm IS NOT NULL'],
  ['idx_tracks_vocal_measured', 'CREATE INDEX IF NOT EXISTS idx_tracks_vocal_measured ON tracks((vocal_ranges_json IS NOT NULL))'],
  ['idx_tracks_fail_count', 'CREATE INDEX IF NOT EXISTS idx_tracks_fail_count ON tracks(analyze_fail_count) WHERE analyze_fail_count IS NOT NULL'],
  ['idx_tracks_stats', 'CREATE INDEX IF NOT EXISTS idx_tracks_stats ON tracks(energy, source, tagged_at, artist, genres, moods) WHERE moods IS NOT NULL'],
];

export function ensureStatsIndexes(): void {
  const d = requireDb();
  try {
    const names = STATS_INDEXES.map(([name]) => name);
    const present = new Set((d.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${names.map(() => '?').join(', ')})`,
    ).all(...names) as Array<{ name: string }>).map(r => r.name));
    const missing = STATS_INDEXES.filter(([name]) => !present.has(name));
    if (missing.length === 0) return;
    const started = performance.now();
    console.log(`[library-db] building count indexes (one-time, ${missing.length} missing)…`);
    // Still IF NOT EXISTS: a rival opener may have built one since the read.
    for (const [, sql] of missing) d.prepare(sql).run();
    console.log(`[library-db] count indexes built in ${Math.round(performance.now() - started)}ms`);
  } catch (err) {
    console.warn(
      `[library-db] count indexes not built (${(err as Error).message}); ` +
        'library counts stay correct but scan until the next open retries',
    );
  }
}

// pickStats() counts. Same rows as the tagged totals in computeStats()
// (tagged rows; distinct non-blank artists), but answered from
// idx_tracks_tagged_artist alone: the artist key must be the indexed
// expression, or SQLite falls back to reading every tracks row.
// `k != ''` drops blank artists; COUNT(DISTINCT) already skips NULL.
function countTagged(): number {
  return (requireDb().prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`).get() as { n: number }).n;
}

function countDistinctTaggedArtists(): number {
  return (requireDb()
    .prepare(
      `SELECT COUNT(DISTINCT k) AS n
         FROM (SELECT LOWER(TRIM(artist)) AS k FROM tracks WHERE ${SQL_HAS_MOODS})
        WHERE k != ''`,
    )
    .get() as { n: number }).n;
}

function computePickStats(): PickStats {
  const d = requireDb();
  const mirrorTotal = (d.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const distinctArtists = countDistinctTaggedArtists();
  const total = countTagged();
  const withEmbedding = (d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as { n: number }).n;
  const withAudioEmbedding = (d.prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as { n: number }).n;
  // The per-mood counts are one grouped pass over the moods JSON: the one scan
  // pickStats keeps, because a pick-time tool gate needs the counts, not just
  // a yes/no. It runs at most once per TTL and off the pick path after the
  // first call. Mood coverage follows from it; energy still stops at the
  // first hit.
  const byMood: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS mood, COUNT(*) AS n FROM tracks, json_each(tracks.moods)
       WHERE ${SQL_HAS_MOODS} GROUP BY value`,
    )
    .all() as Array<{ mood: string; n: number }>) {
    byMood[r.mood] = r.n;
  }
  const hasMoodCoverage = Object.keys(byMood).length > 0;
  // stats().byEnergy counts tagged rows only (#1732); coverage must agree.
  const hasEnergyCoverage = !!d.prepare(`SELECT 1 FROM tracks WHERE energy IS NOT NULL AND ${SQL_HAS_MOODS} LIMIT 1`).get();
  return { total, mirrorTotal, distinctArtists, withEmbedding, withAudioEmbedding, hasMoodCoverage, hasEnergyCoverage, byMood };
}

// `fresh` skips the TTL, never the token, so the value is never older than the
// last commit. For a caller that caches what it builds on a change token
// (genre-suggest, on genreInputsToken() since #1991): a TTL-held value from
// before a write, stored under a token read after it, would be served until
// the next write.
export function stats(opts: { fresh?: boolean } = {}): LibraryStats {
  const now = Date.now();
  if (!opts.fresh && statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  // Read before the compute, so a commit landing mid-compute leaves a token
  // the next call no longer matches.
  const token = changeToken();
  if (statsCache && statsCache.token === token) return statsCache.value;
  const value = computeStats();
  // Stamp AFTER the compute: a large library can exceed the TTL, and a
  // start-of-compute stamp would expire on store.
  statsCache = { at: Date.now(), token, value };
  return value;
}

// Opaque token that changes on any write, for the observatory ETag:
// `data_version` covers other connections (tagger/analyzer run concurrently),
// `total_changes()` this one's, the nonce handle swaps. Both reads are O(1).
export function changeToken(): string {
  const d = requireDb();
  const dataVersion = d.pragma('data_version', { simple: true }) as number;
  const ownChanges = (d.prepare('SELECT total_changes() AS c').get() as { c: number }).c;
  return `${getDbNonce()}.${dataVersion}.${ownChanges}`;
}

function computeStats(): LibraryStats {
  const d = requireDb();
  // The mirror count and the tagged totals are two reads, not one pass: a
  // single pass has to visit every wide row, while apart the mirror count
  // reads any small index and the tagged half reads idx_tracks_stats alone
  // (#1937). Empty moods, blank artists and untagged timestamps keep their
  // original exclusions.
  const { mirrorTotal } = d.prepare('SELECT COUNT(*) AS mirrorTotal FROM tracks').get() as
    Pick<LibraryStats, 'mirrorTotal'>;
  const tagged = d.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT LOWER(TRIM(artist))) FILTER (
             WHERE artist IS NOT NULL AND TRIM(artist) != ''
           ) AS distinctArtists,
           MAX(tagged_at) AS updatedAt
      FROM tracks WHERE ${SQL_HAS_MOODS}
  `).get() as Pick<LibraryStats, 'total' | 'distinctArtists' | 'updatedAt'>;
  const totals = { mirrorTotal, ...tagged };
  const byMood: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS mood, COUNT(*) AS n FROM tracks, json_each(tracks.moods)
       WHERE ${SQL_HAS_MOODS} GROUP BY value`,
    )
    .all() as Array<{ mood: string; n: number }>) {
    byMood[r.mood] = r.n;
  }
  const byEnergy: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const r of d.prepare(`
    SELECT energy, source, COUNT(*) AS n FROM tracks
     WHERE ${SQL_HAS_MOODS} GROUP BY energy, source
  `).all() as Array<{ energy: string | null; source: string | null; n: number }>) {
    if (r.energy !== null) byEnergy[r.energy] = (byEnergy[r.energy] ?? 0) + r.n;
    if (r.source !== null) {
      const previous = Object.hasOwn(bySource, r.source) ? bySource[r.source] : 0;
      bySource[r.source] = (previous ?? 0) + r.n;
    }
  }
  // Per-tag counts, not a partition: a track counts toward every genre it
  // carries, so the sum can exceed `total`.
  const byGenre: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS genre, COUNT(*) AS n FROM tracks, json_each(tracks.genres)
       WHERE ${SQL_HAS_MOODS} AND tracks.genres IS NOT NULL GROUP BY value`,
    )
    .all() as Array<{ genre: string; n: number }>) {
    byGenre[r.genre] = r.n;
  }
  const withEmbedding = (d.prepare('SELECT COUNT(*) AS n FROM track_vectors').get() as {
    n: number;
  }).n;
  const withAudioEmbedding = (
    d.prepare('SELECT COUNT(*) AS n FROM track_audio_vectors').get() as { n: number }
  ).n;
  return {
    ...totals, updatedAt: totals.updatedAt || null,
    byMood, byEnergy, byGenre, bySource, withEmbedding, withAudioEmbedding,
  };
}
