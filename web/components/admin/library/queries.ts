'use client';

import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { BlockRef, Energy, LikedSort, SearchMode, Sort, TagEvent, Track, Vocal } from './types';

// Query-key factory plus the cache-wide row operations. Imports nothing from
// LibraryContext: that would be a context → queries → context cycle.

export interface BrowseKeyFilters {
  moods: string[]; energy: Energy; vocal: Vocal; genre: string;
  yearFrom: string; yearTo: string; q: string; sort: Sort; page: number;
}

// Keys nest so a filter matches a family. Every cached list of Tracks sits under
// ['library','rows'], so one setQueriesData reaches all of them. Never file a
// non-Track list there (history rows are PlayEntry, blocklist rows BlockEntry).
export const libraryKeys = {
  all: ['library'] as const,
  rows: ['library', 'rows'] as const,
  browse: (f: BrowseKeyFilters) => ['library', 'rows', 'browse', f] as const,
  browseAll: ['library', 'rows', 'browse'] as const,
  search: (q: string, mode: SearchMode) => ['library', 'rows', 'search', q, mode] as const,
  untagged: () => ['library', 'rows', 'untagged'] as const,
  recent: () => ['library', 'rows', 'recent'] as const,
  liked: (sort: LikedSort, page: number) => ['library', 'rows', 'liked', sort, page] as const,
  likedAll: ['library', 'rows', 'liked'] as const,
  history: (page: number) => ['library', 'history', page] as const,
  blocked: () => ['library', 'blocked'] as const,
  blockRules: () => ['library', 'block-rules'] as const,
  likeIndex: () => ['library', 'likeIndex'] as const,
  coverage: () => ['library', 'coverage'] as const,
  tagger: () => ['library', 'tagger'] as const,
  analysisFailures: () => ['library', 'analysis-failures'] as const,
  moodVocab: () => ['library', 'mood-vocab'] as const,
  genres: () => ['library', 'genres'] as const,
  // The curatable genre vocabulary with its consolidation rules (#1577). Unlike
  // `genres`, it excludes Navidrome's own index: only what the mirror holds.
  scenes: () => ['library', 'scenes'] as const,
  // What a staged merge would orphan (#1593). Keyed on the merge itself.
  sceneReferences: (from: readonly string[], to: string) =>
    ['library', 'scene-references', [...from].sort().join('\u0000'), to] as const,
  playlists: () => ['library', 'playlists'] as const,
  rulePlaylists: () => ['library', 'rule-playlists'] as const,
};

// Row lists cache in three shapes and all three must be handled here: a bare
// Track[] (recent), { rows, total } (browse, liked) and useInfiniteQuery's
// { pages } (search, untagged). Miss one and a cross-list update silently no-ops.

type PagedRows = InfiniteData<{ rows: Track[] }>;

function hasKey(v: unknown, k: string): boolean {
  return typeof v === 'object' && v !== null && k in v;
}

/** Read every Track out of one cached list. The read-side twin of patchAllRows. */
export function rowsOf(data: unknown): Track[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as Track[];
  if (hasKey(data, 'pages')) return (data as PagedRows).pages.flatMap(p => p.rows || []);
  if (hasKey(data, 'rows')) return (data as { rows: Track[] }).rows || [];
  return [];
}

/** Patches every cached list of Tracks, in all three shapes, in one call. */
export function patchAllRows(qc: QueryClient, fn: (t: Track) => Track) {
  qc.setQueriesData<unknown>({ queryKey: libraryKeys.rows }, (prev: unknown) => {
    if (!prev) return prev;
    if (Array.isArray(prev)) return (prev as Track[]).map(fn);
    if (hasKey(prev, 'pages')) {
      const inf = prev as PagedRows;
      return { ...inf, pages: inf.pages.map(p => ({ ...p, rows: (p.rows || []).map(fn) })) };
    }
    if (hasKey(prev, 'rows')) {
      const o = prev as { rows: Track[] };
      return { ...o, rows: (o.rows || []).map(fn) };
    }
    return prev;
  });
}

/** Stamp blockedBy marks across every cached list; ids absent from the map are left alone. */
export function applyBlockMarks(qc: QueryClient, marks: Record<string, BlockRef | null>) {
  patchAllRows(qc, t => (t.id in marks ? { ...t, blockedBy: marks[t.id] } : t));
}

/**
 * A manual era-year override landed (#1418). Targets the ids the endpoint
 * updated, never album titles, which are not identities. `originalYear: null`
 * clears the override, so the source goes back to null too.
 */
export function applyEraYearEvent(qc: QueryClient, ev: {
  originalYear: number | null;
  trackIds: string[];
}) {
  const trackIds = new Set(ev.trackIds);

  patchAllRows(qc, r => (!trackIds.has(r.id) ? r : {
    ...r,
    originalYear: ev.originalYear,
    originalYearSource: ev.originalYear == null ? null : 'manual',
  }));
}

/**
 * A manual tag save or single-track retag landed; two lists need more than the
 * plain patch. `source` mirrors the server stamp: 'manual' inline, 'llm' retag.
 */
export function applyTagEvent(qc: QueryClient, ev: TagEvent) {
  const hits = (r: Track) =>
    r.id === ev.track.id || (ev.applyToAlbum && !!ev.track.album && r.album === ev.track.album);

  patchAllRows(qc, r => (!hits(r) ? r
    : ev.cleared
      ? { ...r, moods: [], energy: null, source: null }
      : { ...r, moods: ev.moods, energy: ev.energy, source: ev.source }));

  // Needs-tags: a newly tagged track is no longer untagged; a cleared one stays.
  if (!ev.cleared) {
    qc.setQueriesData<InfiniteData<{ rows: Track[]; nextCursor: string | null }>>(
      { queryKey: libraryKeys.untagged() },
      prev => (prev
        ? { ...prev, pages: prev.pages.map(p => ({ ...p, rows: p.rows.filter(r => !hits(r)) })) }
        : prev),
    );
  }
  // Browse refetches rather than patches: a tag edit can change its membership.
  void qc.invalidateQueries({ queryKey: libraryKeys.browseAll });
}

/**
 * A song's like state settled server-side; `next` null means none remain. Touches
 * only Liked: inline like fields outrank the shared index in likeStateFor, so
 * stamping them on other lists would pin those rows to a snapshot.
 */
export function applyLikeChange(
  qc: QueryClient, songId: string, next: { count: number; operator: boolean } | null,
) {
  qc.setQueriesData<{ rows: Track[]; total: number }>({ queryKey: libraryKeys.likedAll }, prev => {
    if (!prev) return prev;
    if (next) {
      return {
        ...prev,
        rows: prev.rows.map(t => (t.id === songId
          ? { ...t, likeCount: next.count, likedByOperator: next.operator } : t)),
      };
    }
    // A track nobody likes any more is no longer in this list.
    if (!prev.rows.some(t => t.id === songId)) return prev;
    return { rows: prev.rows.filter(t => t.id !== songId), total: Math.max(0, prev.total - 1) };
  });
}
