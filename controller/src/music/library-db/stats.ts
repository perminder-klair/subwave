// Library-wide counts for the admin dashboard, cached because the aggregate scan
// is the most expensive read in this module.

import { SQL_HAS_MOODS, getDbNonce, requireDb } from './handle.js';
import type { LibraryStats } from './types.js';

// ~7 full-table scans, polled from several admin pages; uncached it blocks
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
}

export function stats(): LibraryStats {
  const now = Date.now();
  if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value;
  const value = computeStats();
  // Stamp AFTER the compute: it can exceed the TTL (~15s at 200k tracks), and a
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
  const total =
    (d.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE ${SQL_HAS_MOODS}`).get() as {
      n: number;
    }).n;
  // Every row, tagged or not. `total` counts only TAGGED tracks and is the wrong
  // denominator for the recency windows, no-repeat clamp and deepCuts gate.
  const mirrorTotal =
    (d.prepare(`SELECT COUNT(*) AS n FROM tracks`).get() as { n: number }).n;
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
  // Per-tag counts, not a partition: a track counts toward every genre it
  // carries, so the sum can exceed `total`.
  const byGenre: Record<string, number> = {};
  for (const r of d
    .prepare(
      `SELECT value AS genre, COUNT(*) AS n FROM tracks, json_each(tracks.genres)
       WHERE tracks.genres IS NOT NULL GROUP BY value`,
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
    total, mirrorTotal, distinctArtists, byMood, byEnergy, byGenre, bySource,
    withEmbedding, withAudioEmbedding, updatedAt,
  };
}


