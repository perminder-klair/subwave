// Play history: what actually went to air, appended by the queue.

import { requireDb } from './handle.js';
import { rowToTrack } from './rows.js';
import type { TrackRecord, TrackRow } from './types.js';

interface PlayRecord {
  id: number;
  trackId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  playedAt: string;
  source: string | null;       // 'ai' | 'request' | 'auto' at write time
  requestedBy: string | null;
  showId: string | null;
  showName: string | null;
}

export type PlayWrite = Omit<PlayRecord, 'id'>;

export function recordPlay(p: PlayWrite): void {
  requireDb().prepare(`
    INSERT INTO plays (track_id, title, artist, album, played_at, source, requested_by, show_id, show_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.trackId, p.title, p.artist, p.album, p.playedAt,
    p.source, p.requestedBy, p.showId, p.showName,
  );
}

// Last air time per track, keyed by id AND by recency.trackKey's lowercased
// "title|artist", so a duplicate shares its twin's history. Epoch ms. played_at
// is ISO-8601 with a fixed Z offset, so a lexicographic SQL MAX() is chronological.
export interface LastAiredIndex {
  byId: Map<string, number>;
  byKey: Map<string, number>;
  playStatsById: Map<string, TrackPlayStats>;
  playStatsByKey: Map<string, TrackPlayStats>;
}

// Two queries, not one GROUP BY over (track_id, title, artist): each half has its
// own covering index from schema v20 that a combined grouping could not use.
export function lastAiredIndex(): LastAiredIndex {
  const d = requireDb();
  const byId = new Map<string, number>();
  const byKey = new Map<string, number>();
  const playStatsById = new Map<string, TrackPlayStats>();
  const playStatsByKey = new Map<string, TrackPlayStats>();

  for (const r of d.prepare(`
    SELECT track_id, COUNT(*) AS n, MAX(played_at) AS last_at
    FROM plays WHERE track_id IS NOT NULL AND track_id != '' GROUP BY track_id
  `).all() as Array<{ track_id: string; n: number; last_at: string }>) {
    const at = Date.parse(r.last_at);
    if (!Number.isFinite(at)) continue;
    byId.set(r.track_id, at);
    playStatsById.set(r.track_id, { count: r.n, lastPlayedAtMs: at });
  }

  for (const r of d.prepare(`
    SELECT title, artist, COUNT(*) AS n, MAX(played_at) AS last_at
    FROM plays WHERE title IS NOT NULL AND title != '' GROUP BY title, artist
  `).all() as Array<{ title: string; artist: string | null; n: number; last_at: string }>) {
    const at = Date.parse(r.last_at);
    if (!Number.isFinite(at)) continue;
    // GROUP BY is on the raw columns while the key is lowercased+trimmed, so two
    // casings of one title collapse here and the later wins.
    const key = `${r.title.toLowerCase().trim()}|${(r.artist || '').toLowerCase().trim()}`;
    const prev = byKey.get(key);
    if (prev == null || at > prev) byKey.set(key, at);
    const prevStats = playStatsByKey.get(key);
    playStatsByKey.set(key, {
      count: (prevStats?.count ?? 0) + r.n,
      lastPlayedAtMs: Math.max(prevStats?.lastPlayedAtMs ?? 0, at),
    });
  }

  return { byId, byKey, playStatsById, playStatsByKey };
}

// Random sample of tracks never aired, or last aired before the cutoff. Id-level
// only; the caller's recency key filters catch a duplicate whose twin aired.
// Two steps on purpose: sampling ids first avoids materialising every fat row on
// the synchronous handle that also serves listener polls (#723). NOT EXISTS lets
// idx_plays_track_played answer per track without grouping the whole table.
export function deepCutTracks(cutoffIso: string, limit: number): TrackRecord[] {
  const d = requireDb();
  const ids = (d.prepare(`
    SELECT t.id FROM tracks t
    WHERE NOT EXISTS (
      SELECT 1 FROM plays p WHERE p.track_id = t.id AND p.played_at >= ?
    )
    ORDER BY RANDOM() LIMIT ?
  `).all(cutoffIso, Math.min(500, Math.max(1, Math.floor(limit)))) as Array<{ id: string }>).map((r) => r.id);
  if (!ids.length) return [];
  const rows = d.prepare(
    `SELECT * FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as TrackRow[];
  // IN () answers in storage order, so restore the sampled order or the caller's
  // slice isn't the random draw it asked for.
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is TrackRow => !!r).map(rowToTrack);
}

export interface TrackPlayStats {
  count: number;
  lastPlayedAtMs: number;
}

// Lifetime plays per artist, keyed by lowercased+trimmed name (the fold
// lastAiredIndex's key half uses); there is no artist id to group on.
export interface ArtistPlayStats {
  count: number;
  lastPlayedAtMs: number;
}

export function artistPlayIndex(): Map<string, ArtistPlayStats> {
  const d = requireDb();
  const out = new Map<string, ArtistPlayStats>();
  for (const r of d.prepare(`
    SELECT LOWER(TRIM(artist)) AS artist, COUNT(*) AS n, MAX(played_at) AS last_at
    FROM plays WHERE artist IS NOT NULL AND TRIM(artist) != ''
    GROUP BY LOWER(TRIM(artist))
  `).all() as Array<{ artist: string; n: number; last_at: string }>) {
    const at = Date.parse(r.last_at);
    if (!Number.isFinite(at)) continue;
    out.set(r.artist, { count: r.n, lastPlayedAtMs: at });
  }
  return out;
}

export function listPlays(opts: { limit?: number; offset?: number } = {}): { total: number; rows: PlayRecord[] } {
  const d = requireDb();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const total = (d.prepare('SELECT COUNT(*) AS n FROM plays').get() as { n: number }).n;
  const rows = (d.prepare(`
    SELECT id, track_id, title, artist, album, played_at, source, requested_by, show_id, show_name
    FROM plays ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    id: number; track_id: string | null; title: string | null; artist: string | null;
    album: string | null; played_at: string; source: string | null;
    requested_by: string | null; show_id: string | null; show_name: string | null;
  }>).map((r) => ({
    id: r.id,
    trackId: r.track_id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    playedAt: r.played_at,
    source: r.source,
    requestedBy: r.requested_by,
    showId: r.show_id,
    showName: r.show_name,
  }));
  return { total, rows };
}
