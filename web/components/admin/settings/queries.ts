'use client';

import { useCallback, useRef } from 'react';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
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
  refetchOnMount,
}: {
  adminFetch: AdminFetch;
  enabled: boolean;
  refetchInterval?: UseQueryOptions<T>['refetchInterval'];
  refetchOnMount?: UseQueryOptions<T>['refetchOnMount'];
}): UseQueryResult<T> {
  return useAdminQuery<T>({
    key: settingsKeys.detail(),
    adminFetch,
    enabled,
    request: (fetcher, signal) => adminJson<T>(fetcher, '/settings', undefined, signal),
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    ...(refetchOnMount !== undefined ? { refetchOnMount } : {}),
    toastOnError: false,
  });
}

export interface SettingsSaveReceipt {
  requiresRestart?: boolean;
  refreshError?: string;
}

export function patchSettingsAudio(
  client: QueryClient,
  patch: Record<string, unknown>,
): void {
  client.setQueryData<{ values?: { audio?: Record<string, unknown> } }>(
    settingsKeys.detail(),
    previous => (previous
      ? {
          ...previous,
          values: {
            ...previous.values,
            audio: { ...previous.values?.audio, ...patch },
          },
        }
      : previous),
  );
}

/**
 * Sensitive settings writes keep both the patch and the raw POST response out
 * of TanStack state. MutationCache sees void variables/data; the short-lived
 * refs are cleared in finally after one mandatory redacted GET. A committed
 * POST whose GET fails resolves with a partial-success receipt; callers must
 * re-baseline submitted fields and report the refresh failure honestly.
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
      const previous = client.getQueryData<TSettings>(settingsKeys.detail());
      const result = await adminJson<SettingsSaveResult>(adminFetch, '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      receiptRef.current = { requiresRestart: result.requiresRestart };
      try {
        // A 3s settings poll may already be in flight with a pre-write
        // envelope. Await its exact cancellation before starting the
        // authoritative read so fetchQuery cannot dedupe onto that promise.
        await client.cancelQueries(
          { queryKey: settingsKeys.detail(), exact: true },
          { silent: true },
        );
        await client.fetchQuery<TSettings>({
          queryKey: settingsKeys.detail(),
          queryFn: ({ signal }) => adminJson<TSettings>(adminFetch, '/settings', undefined, signal),
          staleTime: 0,
        });
      } catch (error) {
        // The POST committed. Keep the last redacted envelope usable, but mark
        // it stale so the next observer retries instead of treating it as a
        // fresh source of truth. Callers receive an honest partial-success
        // receipt and can re-baseline the exact fields they submitted.
        if (previous !== undefined) {
          client.setQueryData<TSettings>(settingsKeys.detail(), previous, { updatedAt: 0 });
        } else {
          client.removeQueries({ queryKey: settingsKeys.detail(), exact: true });
        }
        receiptRef.current = {
          ...receiptRef.current,
          refreshError: errorMessage(error),
        };
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
