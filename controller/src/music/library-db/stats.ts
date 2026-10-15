// Library-wide counts for the admin dashboard, cached because the aggregate scan
// is the most expensive read in this module.

import { SQL_HAS_MOODS, getDbNonce, requireDb } from './handle.js';
import type { LibraryStats } from './types.js';

// Aggregate scans, polled from several admin pages; uncached they block
// listener polls on the synchronous DB thread (#723).
let statsCache: { at: number; value: LibraryStats } | null = null;
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
export function ensureStatsIndexes(): void {
  requireDb()
    .prepare(
      'CREATE INDEX IF NOT EXISTS idx_tracks_tagged_artist ON tracks(LOWER(TRIM(artist)), moods) WHERE moods IS NOT NULL',
    )
    .run();
}

// pickStats() counts. Same rows as the single-pass totals in computeStats()
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

export function stats(): LibraryStats {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = computeStats();
  // Stamp AFTER the compute: a large library can exceed the TTL, and a
  // start-of-compute stamp would expire on store.
  statsCache = { at: Date.now(), value };
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
  // Count the whole mirror and the tagged subset in one pass. Empty moods,
  // blank artists and untagged timestamps keep their original exclusions.
  const totals = d.prepare(`
    SELECT COUNT(*) AS mirrorTotal,
           COUNT(*) FILTER (WHERE ${SQL_HAS_MOODS}) AS total,
           COUNT(DISTINCT LOWER(TRIM(artist))) FILTER (
             WHERE ${SQL_HAS_MOODS} AND artist IS NOT NULL AND TRIM(artist) != ''
           ) AS distinctArtists,
           MAX(tagged_at) FILTER (WHERE ${SQL_HAS_MOODS}) AS updatedAt
      FROM tracks
  `).get() as Pick<LibraryStats, 'mirrorTotal' | 'total' | 'distinctArtists' | 'updatedAt'>;
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
