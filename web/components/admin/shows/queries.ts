'use client';

import { preparationStatusSchema } from '@/lib/schemas.generated';
import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminMutation, useAdminQuery } from '@/lib/admin-query';
import { settingsKeys } from '../settings/queries';
import type {
  CommunityShow,
  Schedule,
  SettingsResponse,
  Show,
  SkillOption,
} from './types';
import type { CandidateDiagnostic } from './candidate-diagnostic';
import { showPayload } from './lib';
import { writeTakeoverShows } from '../dash/queries';

export interface ShowPlaylist {
  id: string;
  name: string;
  songCount: number | null;
}

export const showKeys = {
  all: ['shows'] as const,
  settings: () => settingsKeys.detail(),
  skills: () => ['shows', 'skills'] as const,
  genres: () => ['shows', 'genres'] as const,
  playlists: () => ['shows', 'playlists'] as const,
  community: () => ['shows', 'community'] as const,
  preparation: () => ['shows', 'preparation'] as const,
  blocklist: () => ['shows', 'blocklist'] as const,
};

export function patchShowSettings(
  client: QueryClient,
  patch: { shows?: Array<Partial<Show>>; schedule?: Schedule },
): void {
  client.setQueryData<SettingsResponse>(settingsKeys.detail(), previous => {
    if (!previous?.values) return previous;
    return { ...previous, values: { ...previous.values, ...patch } };
  });
  if (patch.shows) writeTakeoverShows(client, patch.shows);
}

/** The Shows picker accepts only enabled skills with a stable runtime kind. */
export function showSkillsOf(skills: Array<Partial<SkillOption>> | undefined): SkillOption[] {
  if (!Array.isArray(skills)) return [];
  return skills.flatMap(skill => {
    const kind = typeof skill?.kind === 'string' && skill.kind
      ? skill.kind
      : typeof skill?.name === 'string' ? skill.name : '';
    return kind && skill.enabled !== false ? [{ ...skill, kind }] : [];
  });
}

export function useShowSkillsQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<SkillOption[]>({
    key: showKeys.skills(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ skills?: SkillOption[] }>(
        fetcher, '/dj/skills', undefined, signal,
      );
      return showSkillsOf(body.skills);
    },
    toastOnError: false,
  });
}

export function useShowGenresQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<string[]>({
    key: showKeys.genres(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ genres?: Array<{ value?: string }> }>(
        fetcher, '/library/genres', undefined, signal,
      );
      return Array.isArray(body.genres)
        ? body.genres.map(genre => genre.value || '').filter(Boolean)
        : [];
    },
    toastOnError: false,
  });
}

export function useShowPlaylistsQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<ShowPlaylist[]>({
    key: showKeys.playlists(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ results?: ShowPlaylist[] }>(
        fetcher, '/dj/playlists', undefined, signal,
      );
      if (!Array.isArray(body.results)) throw new Error('/dj/playlists returned no results');
      return body.results;
    },
    toastOnError: false,
  });
}

export function useCommunityShowsQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<CommunityShow[]>({
    key: showKeys.community(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ community?: CommunityShow[] }>(
        fetcher, '/shows/community', undefined, signal,
      );
      return Array.isArray(body.community) ? body.community : [];
    },
    toastOnError: false,
  });
}

export function useShowBlocklistQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<Array<{ showIds?: string[] }>>({
    key: showKeys.blocklist(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ rules?: Array<{ showIds?: string[] }> }>(
        fetcher, '/library/blocklist', undefined, signal,
      );
      return Array.isArray(body.rules) ? body.rules : [];
    },
    toastOnError: false,
  });
}

/** One-shot editor preview: deliberately imperative and never cached. */
export async function fetchShowCandidates(
  fetcher: AdminFetch,
  show: Show,
): Promise<CandidateDiagnostic> {
  const response = await fetcher('/shows/candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ show: showPayload(show) }),
  });
  const body = await response.json().catch(() => ({})) as CandidateDiagnostic & { error?: string };
  if (!response.ok) throw new Error(body.error || `failed (${response.status})`);
  return body;
}

export type PreparationStatus = z.output<typeof preparationStatusSchema>;
export function useShowPreparationQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<PreparationStatus>({
    key: showKeys.preparation(), adminFetch, enabled, refetchInterval: 5000,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ status: unknown }>(fetcher, '/dj/show-preparation', undefined, signal);
      return preparationStatusSchema.parse(body.status);
    }, toastOnError: false,
  });
}
export function useRetryShowPreparation(adminFetch: AdminFetch) {
  return useAdminMutation<PreparationStatus, void>({
    adminFetch,
    request: async (_vars, fetcher) => {
      const body = await adminJson<{ status: unknown }>(fetcher, '/dj/show-preparation/retry', { method: 'POST' });
      return preparationStatusSchema.parse(body.status);
    },
    onDone: (status, _vars, client) => { client.setQueryData(showKeys.preparation(), status); },
  });
}
