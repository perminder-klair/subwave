'use client';

import type { QueryClient, UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import {
  adminJson,
  type AdminFetch,
} from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';

export const settingsKeys = {
  all: ['settings'] as const,
  detail: () => ['settings', 'detail'] as const,
  genreSuggestions: () => ['settings', 'genre-suggestions'] as const,
};

export interface SettingsSaveResult<TSaved = Record<string, unknown>> {
  saved?: TSaved;
  requiresRestart?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

export function useSettingsQuery<T>({
  adminFetch,
  enabled,
  refetchInterval,
}: {
  adminFetch: AdminFetch;
  enabled: boolean;
  refetchInterval?: UseQueryOptions<T>['refetchInterval'];
}): UseQueryResult<T> {
  return useAdminQuery<T>({
    key: settingsKeys.detail(),
    adminFetch,
    enabled,
    request: (fetcher, signal) => adminJson<T>(fetcher, '/settings', undefined, signal),
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    toastOnError: false,
  });
}

/**
 * POST /settings may contain raw write-only secrets and omits GET-only derived
 * fields. Never cache it: one redacted GET refreshes the complete envelope.
 */
export async function applySettingsSave(
  client: QueryClient,
  _result: SettingsSaveResult,
): Promise<void> {
  await client.invalidateQueries({
    queryKey: settingsKeys.detail(),
    exact: true,
    refetchType: 'active',
  });
}
