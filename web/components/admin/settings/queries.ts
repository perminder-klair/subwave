'use client';

import { useCallback, useRef } from 'react';
import {
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  adminJson,
  type AdminFetch,
} from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import { errorMessage } from '@/lib/notify';

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

export interface SettingsSaveReceipt {
  requiresRestart?: boolean;
}

/**
 * Sensitive settings writes keep both the patch and the raw POST response out
 * of TanStack state. MutationCache sees void variables/data; the short-lived
 * refs are cleared in finally after one mandatory, throwing redacted GET.
 */
export function useSettingsMutation<TSettings>({
  adminFetch,
}: {
  adminFetch: AdminFetch;
}): {
  isPending: boolean;
  mutateAsync: (patch: Record<string, unknown>) => Promise<SettingsSaveReceipt>;
} {
  const client = useQueryClient();
  const patchRef = useRef<Record<string, unknown> | null>(null);
  const receiptRef = useRef<SettingsSaveReceipt | null>(null);
  const mutation = useMutation<void, Error, void>({
    mutationKey: ['settings', 'save'],
    mutationFn: async () => {
      const patch = patchRef.current;
      if (!patch) throw new Error('settings save payload unavailable');
      let posted = false;
      try {
        const result = await adminJson<SettingsSaveResult>(adminFetch, '/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        posted = true;
        receiptRef.current = { requiresRestart: result.requiresRestart };
        await client.fetchQuery<TSettings>({
          queryKey: settingsKeys.detail(),
          queryFn: ({ signal }) => adminJson<TSettings>(adminFetch, '/settings', undefined, signal),
          staleTime: 0,
        });
      } catch (error) {
        if (posted) {
          throw new Error(`settings were saved, but refresh failed: ${errorMessage(error)}`);
        }
        throw error;
      }
    },
  });
  const runMutation = mutation.mutateAsync;
  const mutateAsync = useCallback(async (patch: Record<string, unknown>) => {
    if (patchRef.current) throw new Error('settings save already in progress');
    patchRef.current = patch;
    receiptRef.current = null;
    try {
      await runMutation();
      return receiptRef.current ?? {};
    } finally {
      patchRef.current = null;
      receiptRef.current = null;
    }
  }, [runMutation]);
  return { isPending: mutation.isPending, mutateAsync };
}
