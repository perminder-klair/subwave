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
import { resetGeminiLibraryDefaults } from '../tts/geminiLibraryQueries';

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
  /** Revision of the authoritative redacted GET, absent when it failed. */
  refreshedAt?: number;
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
 * The one authoritative redacted GET after a COMMITTED settings write. A 3s
 * settings poll may already be in flight with a pre-write envelope, so its
 * exact cancellation is awaited before the read starts and fetchQuery cannot
 * dedupe onto that promise. If the read (or `before`) fails, the write still
 * committed: the last redacted envelope stays usable but is marked stale so the
 * next observer retries instead of treating it as a fresh source of truth, and
 * the caller gets an honest partial-success receipt to re-baseline from.
 */
async function readAfterCommittedWrite<TSettings>(
  client: QueryClient,
  adminFetch: AdminFetch,
  previous: TSettings | undefined,
  before?: () => Promise<void>,
): Promise<Pick<SettingsSaveReceipt, 'refreshedAt' | 'refreshError'>> {
  try {
    await before?.();
    await client.cancelQueries(
      { queryKey: settingsKeys.detail(), exact: true },
      { silent: true },
    );
    await client.fetchQuery<TSettings>({
      queryKey: settingsKeys.detail(),
      queryFn: ({ signal }) => adminJson<TSettings>(adminFetch, '/settings', undefined, signal),
      staleTime: 0,
    });
    return { refreshedAt: client.getQueryState(settingsKeys.detail())?.dataUpdatedAt };
  } catch (error) {
    if (previous !== undefined) {
      client.setQueryData<TSettings>(settingsKeys.detail(), previous, { updatedAt: 0 });
    } else {
      client.removeQueries({ queryKey: settingsKeys.detail(), exact: true });
    }
    return { refreshError: errorMessage(error) };
  }
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
      const read = await readAfterCommittedWrite<TSettings>(client, adminFetch, previous, async () => {
        // This POST committed even if the redacted refresh below fails. Reset
        // default-dependent catalogue pages before another browse can reuse a
        // cursor from the old language. Rejected saves never reach this step.
        const ttsPatch = patch.tts as { gemini?: { libraryLanguage?: unknown } } | undefined;
        if (ttsPatch?.gemini?.libraryLanguage !== undefined) {
          await resetGeminiLibraryDefaults(client);
        }
      });
      receiptRef.current = { ...receiptRef.current, ...read };
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

export interface LlmSwapReceipt extends SettingsSaveReceipt {
  /** Embedding fields the swap pinned (they were inheriting the primary's). */
  pinned?: string[];
  /** The inherited chat key was too long for the Library tagger to hold. */
  keyNotPinned?: boolean;
}

/**
 * "Swap with primary": POST /settings/llm/swap, then the same authoritative
 * read a settings save gets. The controller builds and saves the swap (the
 * browser only ever sees a leg's headers redacted), so the caller re-baselines
 * the swapped form keys from that read (form-reconciliation adoptServerPaths).
 * The receipt carries no secrets — the route answers only it.
 */
export function useLlmSwapMutation<TSettings>({
  adminFetch,
}: {
  adminFetch: AdminFetch;
}): {
  isPending: boolean;
  mutateAsync: () => Promise<LlmSwapReceipt>;
} {
  const client = useQueryClient();
  const mutation = useMutation<LlmSwapReceipt, Error, void>({
    mutationKey: ['settings', 'llm-swap'],
    mutationFn: async () => {
      const previous = client.getQueryData<TSettings>(settingsKeys.detail());
      const result = await adminJson<Omit<LlmSwapReceipt, 'refreshedAt' | 'refreshError'>>(
        adminFetch, '/settings/llm/swap', { method: 'POST' },
      );
      const read = await readAfterCommittedWrite<TSettings>(client, adminFetch, previous);
      return {
        requiresRestart: result.requiresRestart,
        pinned: result.pinned,
        keyNotPinned: result.keyNotPinned,
        ...read,
      };
    },
  });
  const runMutation = mutation.mutateAsync;
  const mutateAsync = useCallback(() => runMutation(), [runMutation]);
  return { isPending: mutation.isPending, mutateAsync };
}
