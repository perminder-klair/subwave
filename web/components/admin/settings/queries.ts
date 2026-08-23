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

/** POST /settings returns the complete authoritative values object on success. */
export function applySettingsSave<TData extends { values?: unknown }>(
  client: QueryClient,
  result: SettingsSaveResult,
): void {
  if (!result.saved) {
    void client.invalidateQueries({ queryKey: settingsKeys.all });
    return;
  }
  client.setQueryData<TData>(settingsKeys.detail(), current => ({
    ...(current || {} as TData),
    values: result.saved,
  }) as TData);
}
