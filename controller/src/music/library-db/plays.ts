// Play history: what actually went to air, appended by the queue.

import { requireDb } from './handle.js';
import { rowToTrack } from './rows.js';
import type { TrackRecord, TrackRow } from './types.js';
import type { MixDropReason } from '../../schemas/transitions.js';
import type { TransitionEffect } from '../../settings/vocab.js';

// One armed gesture that did not reach air (broadcast/queue/types.ts MixDrop),
// restated structurally so this module stays free of broadcast imports.
export interface PlayMixDrop {
  effect: TransitionEffect;
  reason: MixDropReason;
  auto?: true;
}

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
  // The seam record (#1829) — all null on rows written before it existed.
  transition: string | null;            // seam label into this play, as armed
  transitionAsk: string | null;         // the DJ's ask on this pick, before any strip
  transitionDrops: PlayMixDrop[] | null; // armed gestures a strip took back
}

// The seam fields are optional on write so a caller that predates them (or a
// test) still records a play; absent is stored as NULL.
export type PlayWrite = Omit<PlayRecord, 'id' | 'transition' | 'transitionAsk' | 'transitionDrops'>
  & Partial<Pick<PlayRecord, 'transition' | 'transitionAsk' | 'transitionDrops'>>;

export function recordPlay(p: PlayWrite): void {
  requireDb().prepare(`
    INSERT INTO plays (track_id, title, artist, album, played_at, source, requested_by, show_id, show_name,
                       transition, transition_ask, transition_drops)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.trackId, p.title, p.artist, p.album, p.playedAt,
    p.source, p.requestedBy, p.showId, p.showName,
    p.transition ?? null, p.transitionAsk ?? null,
    p.transitionDrops?.length ? JSON.stringify(p.transitionDrops) : null,
  );
}

// A stored drops column back to its array. A malformed value (a hand edit, a
// truncated write) reads as no drops rather than failing the whole listing.
function parseDrops(raw: string | null): PlayMixDrop[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(d => d && typeof d.effect === 'string' && typeof d.reason === 'string') : null;
  } catch {
    return null;
  }
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
    SELECT id, track_id, title, artist, album, played_at, source, requested_by, show_id, show_name,
           transition, transition_ask, transition_drops
    FROM plays ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{
    id: number; track_id: string | null; title: string | null; artist: string | null;
    album: string | null; played_at: string; source: string | null;
    requested_by: string | null; show_id: string | null; show_name: string | null;
    transition: string | null; transition_ask: string | null; transition_drops: string | null;
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
    transition: r.transition,
    transitionAsk: r.transition_ask,
    transitionDrops: parseDrops(r.transition_drops),
  }));
  return { total, rows };
}

// Durable rollup of the seam record over the last `days` (the Stats panel's
// Transitions card). Counted in JS over the window's rows rather than in SQL:
// the drops column is a JSON list, and a week of plays is a few thousand rows.
export interface TransitionStats {
  days: number;
  since: string;
  seams: number;
  bySeam: Record<string, number>;
  asked: number;
  byAsk: Record<string, number>;
  dropped: number;
  byReason: Partial<Record<MixDropReason, number>>;
  byEffect: Partial<Record<TransitionEffect, Partial<Record<MixDropReason, number>>>>;
}

export function transitionStats(days = 7, now = Date.now()): TransitionStats {
  const since = new Date(now - days * 86_400_000).toISOString();
  const rows = requireDb().prepare(`
    SELECT transition, transition_ask, transition_drops FROM plays
    WHERE played_at >= ? AND (transition IS NOT NULL OR transition_ask IS NOT NULL OR transition_drops IS NOT NULL)
  `).all(since) as Array<{ transition: string | null; transition_ask: string | null; transition_drops: string | null }>;
  const out: TransitionStats = {
    days, since, seams: 0, bySeam: {}, asked: 0, byAsk: {}, dropped: 0, byReason: {}, byEffect: {},
  };
  for (const r of rows) {
    if (r.transition) {
      out.seams++;
      out.bySeam[r.transition] = (out.bySeam[r.transition] ?? 0) + 1;
    }
    if (r.transition_ask) {
      out.asked++;
      out.byAsk[r.transition_ask] = (out.byAsk[r.transition_ask] ?? 0) + 1;
    }
    for (const d of parseDrops(r.transition_drops) ?? []) {
      out.dropped++;
      out.byReason[d.reason] = (out.byReason[d.reason] ?? 0) + 1;
      const per = (out.byEffect[d.effect] ??= {});
      per[d.reason] = (per[d.reason] ?? 0) + 1;
    }
  }
  return out;
}
