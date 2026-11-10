'use client';

import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { PlaylistSummary, RawTrackRow } from './types';

export type PlaylistSearchPurpose = 'seed' | 'add' | 'artist';

export interface PlaylistDetail {
  entries: RawTrackRow[];
}

export const playlistKeys = {
  all: ['playlists'] as const,
  index: () => ['playlists', 'index'] as const,
  detail: (id: string) => ['playlists', 'detail', id] as const,
  genres: () => ['playlists', 'genres'] as const,
  search: (purpose: PlaylistSearchPurpose, term: string) =>
    ['playlists', 'search', purpose, term] as const,
};

const SEARCH_LIMITS: Record<PlaylistSearchPurpose, number> = {
  seed: 8,
  add: 10,
  artist: 20,
};

export function usePlaylistSearchQuery(
  adminFetch: AdminFetch,
  purpose: PlaylistSearchPurpose,
  term: string,
) {
  return useAdminQuery<RawTrackRow[]>({
    key: playlistKeys.search(purpose, term),
    adminFetch,
    enabled: Boolean(term),
    request: async (fetcher, signal) => {
      const body = await adminJson<{
        results?: RawTrackRow[];
        songs?: RawTrackRow[];
        tracks?: RawTrackRow[];
      }>(
        fetcher,
        `/dj/search?q=${encodeURIComponent(term)}&limit=${SEARCH_LIMITS[purpose]}`,
        undefined,
        signal,
      );
      const rows = body.results ?? body.songs ?? body.tracks;
      return Array.isArray(rows) ? rows : [];
    },
    toastOnError: false,
  });
}

export function usePlaylistGenresQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<Array<{ value: string; songCount: number }>>({
    key: playlistKeys.genres(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{
        genres?: Array<{ value: string; songCount: number }>;
      }>(fetcher, '/library/genres', undefined, signal);
      return Array.isArray(body.genres) ? body.genres : [];
    },
    toastOnError: false,
  });
}

export function usePlaylistIndexQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<PlaylistSummary[]>({
    key: playlistKeys.index(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ playlists?: PlaylistSummary[] }>(
        fetcher, '/playlists', undefined, signal,
      );
      return Array.isArray(body.playlists) ? body.playlists : [];
    },
    toastOnError: false,
  });
}

export function fetchPlaylistDetail(
  adminFetch: AdminFetch,
  id: string,
  signal: AbortSignal,
): Promise<PlaylistDetail> {
  return adminJson<PlaylistDetail>(
    adminFetch, `/playlists/${encodeURIComponent(id)}`, undefined, signal,
  ).then(body => ({ entries: Array.isArray(body.entries) ? body.entries : [] }));
}
