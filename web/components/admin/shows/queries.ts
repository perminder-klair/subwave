'use client';

import { preparationStatusSchema, type GeneratedShowPlan } from '@/lib/schemas.generated';
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

import { showKeys } from './keys';
export { showKeys } from './keys';

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

export interface GeneratedEpisodeHistory {
  occurrence: { id: string; showId: string; source: 'scheduled' | 'takeover'; startsAt: number; endsAt: number };
  template: string;
  hostPersonaId: string;
  guestPersonaIds: string[];
  status: 'ready' | 'failed';
  savedShowId?: string | null;
  canShuffle?: boolean;
  plan?: GeneratedShowPlan;
  generatedAt?: number;
  reason?: string;
  attempts?: number;
}

export function useGeneratedEpisodeHistoryQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<GeneratedEpisodeHistory[]>({
    key: showKeys.generated(),
    adminFetch,
    enabled,
    refetchInterval: 30_000,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ episodes?: GeneratedEpisodeHistory[] }>(
        fetcher, '/shows/generated?limit=100', undefined, signal,
      );
      return Array.isArray(body.episodes) ? body.episodes : [];
    },
    toastOnError: false,
  });
}

export function useRegenerateGeneratedEpisodeMutation(adminFetch: AdminFetch) {
  return useAdminMutation<{ ok: boolean }, string | { occurrenceId: string; castSeed: string; cast: { hostPersonaId: string; guestPersonaIds: string[] } }>({
    adminFetch,
    toastOnError: false,
    request: (input, fetcher) => adminJson<{ ok: boolean }>(fetcher, '/shows/generated/regenerate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(typeof input === 'string' ? { occurrenceId: input } : input),
    }),
    onDone: async (_data, _id, client) => {
      await client.cancelQueries({ queryKey: showKeys.generated(), exact: true });
      await client.invalidateQueries({ queryKey: showKeys.generated(), exact: true });
    },
  });
}

export interface GeneratedShowDraft { show: Show; saved: boolean; generatedAt: number }
export interface ShuffledEpisodeCast { castSeed: string; hostPersonaId: string; guestPersonaIds: string[] }

export function useGeneratedShowDraftMutation(adminFetch: AdminFetch) {
  return useAdminMutation<GeneratedShowDraft, string>({
    adminFetch,
    request: (occurrenceId, fetcher) => adminJson(fetcher, '/shows/generated/save-draft', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occurrenceId }),
    }),
  });
}

export function useShuffleGeneratedEpisodeMutation(adminFetch: AdminFetch) {
  return useAdminMutation<ShuffledEpisodeCast, string>({
    adminFetch,
    toastOnError: false,
    request: (occurrenceId, fetcher) => adminJson(fetcher, '/shows/generated/shuffle', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ occurrenceId }),
    }),
  });
}

export function useSaveGeneratedShowMutation(adminFetch: AdminFetch) {
  return useAdminMutation<{ show: Show; shows: Show[] }, { show: Show; occurrenceId: string; generatedAt: number; saved: boolean }>({
    adminFetch,
    request: (input, fetcher) => adminJson(fetcher, input.saved ? '/shows' : '/shows/generated/save', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...input, show: showPayload(input.show) }),
    }),
    onDone: async (data, _input, client) => {
      patchShowSettings(client, { shows: data.shows });
      await Promise.all([
        client.invalidateQueries({ queryKey: showKeys.settings(), exact: true }),
        client.invalidateQueries({ queryKey: showKeys.generated(), exact: true }),
      ]);
    },
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

/** Play in order: where a saved show's walk through its playlist stands. */
export interface PlaylistPosition {
  /** The SAVED show plays in order. False while the switch is only on in the draft. */
  inOrder: boolean;
  /** The track its next in-order pick would choose; index is 0-based. */
  next: { index: number; total: number; title: string | null; artist: string | null } | null;
  /** Why there is no next track (anchor unresolved, everything filtered out…). */
  reason?: string;
}

export function usePlaylistPositionQuery(adminFetch: AdminFetch, showId: string, enabled: boolean) {
  return useAdminQuery<PlaylistPosition>({
    key: showKeys.playlistPosition(showId),
    adminFetch,
    enabled,
    refetchInterval: 5000,
    request: (fetcher, signal) => adminJson<PlaylistPosition>(
      fetcher, `/shows/${encodeURIComponent(showId)}/playlist-position`, undefined, signal,
    ),
    toastOnError: false,
  });
}

/** Back to the top: the show's next in-order pick is track 1. */
export function useResetPlaylistPositionMutation(adminFetch: AdminFetch) {
  return useAdminMutation<{ ok: boolean }, string>({
    adminFetch,
    request: (showId, fetcher) => adminJson<{ ok: boolean }>(
      fetcher, `/shows/${encodeURIComponent(showId)}/playlist-position`, { method: 'DELETE' },
    ),
    onDone: async (_data, showId, client) => {
      await client.invalidateQueries({ queryKey: showKeys.playlistPosition(showId), exact: true });
    },
  });
}
