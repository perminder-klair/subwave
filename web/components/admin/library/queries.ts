'use client';

import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { BlockRef, Energy, LikedSort, SearchMode, Sort, TagEvent, Track, Vocal } from './types';

// The query-key factory and the cache-wide row operations. Deliberately imports
// nothing from LibraryContext — the two hooks that need adminFetch live in
// useAdminQuery.ts, so this file stays free of the cycle that would otherwise
// run context → queries → context.

export interface BrowseKeyFilters {
  moods: string[]; energy: Energy; vocal: Vocal; genre: string;
  yearFrom: string; yearTo: string; q: string; sort: Sort; page: number;
}

// Keys nest so a filter matches a family. ['library','rows'] is the one that
// matters most: every cached list of Tracks sits under it, which is how a block
// re-stamp or a tag edit reaches all of them in one setQueriesData call without
// knowing which tabs are mounted. Never file a list here that holds anything but
// Tracks (history rows are PlayEntry, blocklist rows are BlockEntry).
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
  playlists: () => ['library', 'playlists'] as const,
  rulePlaylists: () => ['library', 'rule-playlists'] as const,
};

/**
 * Toasts a query error once per distinct error.
 *
 * v5 removed useQuery's onError, and the toast-vs-silence split on this page is
 * deliberate and documented per call site — the polls that swallow failures
 * (coverage, tagger, settings, likeIndex) pass enabled=false. A global
 * QueryCache onError would toast all of them.
 */
// --- cross-list cache patching ----------------------------------------------
// The three shapes below are the whole contract between the row lists and the
// operations that reach across them. All three are real and all three must be
// handled: a plain list endpoint caches a bare Track[] (recent), an offset-paged
// one caches { rows, total, … } (browse, liked), and useInfiniteQuery caches
// { pages: [...] } (search, untagged). Miss one and a cross-tab update silently
// no-ops — nothing throws, the rows just never change.

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

/**
 * Patches every cached list of Tracks — plain, offset-paged and infinite alike —
 * in one call. The cache already knows which lists are loaded, so nothing has to
 * register itself.
 */
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

/**
 * Stamp fresh blockedBy marks across every cached list. Ids absent from the map
 * are left alone — the check only reports on rows it was asked about.
 */
export function applyBlockMarks(qc: QueryClient, marks: Record<string, BlockRef | null>) {
  patchAllRows(qc, t => (t.id in marks ? { ...t, blockedBy: marks[t.id] } : t));
}

/**
 * A manual era-year override landed (#1418). The endpoint returns every track
 * id it actually updated, so cache targeting uses those ids rather than album
 * titles — album titles are not identities, and unrelated artists commonly
 * publish namesakes. `originalYear: null` is the CLEAR: the source goes back to
 * null too, which returns the row to "the file's own year" in eraSourceNote.
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
 * A manual tag save or a single-track retag landed. Each list means something
 * different by it, so the plain patch is followed by the two exceptions.
 * `source` mirrors what the server stamped: 'manual' for the inline editor,
 * 'llm' for a single-track retag.
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
  // Browse REFETCHES rather than patching: it is the one list whose MEMBERSHIP
  // can change from a tag edit (a mood filter may stop matching).
  void qc.invalidateQueries({ queryKey: libraryKeys.browseAll });
}

/**
 * A song's like state settled server-side; `next` null means none remain.
 *
 * Deliberately touches only the Liked list. TrackTable's likeStateFor prefers a
 * row's INLINE like fields over the shared index, so stamping them onto a browse
 * row would pin it to a snapshot and stop it tracking later index refreshes.
 * Only Liked carries them inline, and only Liked drops a row at zero.
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
