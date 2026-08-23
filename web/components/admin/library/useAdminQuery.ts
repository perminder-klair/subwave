'use client';

import type { QueryClient, UseMutationResult, UseQueryResult } from '@tanstack/react-query';
import {
  adminJson,
  useAdminMutation as useSharedAdminMutation,
  useAdminQuery as useSharedAdminQuery,
  type AdminFetch,
  type AdminMutationOpts as SharedMutationOpts,
} from '../../../lib/admin-query';
import { useLibrary } from './LibraryContext';

// The two hooks that bind TanStack to the page's ONE adminFetch. Split from
// queries.ts so the key factory and the cache helpers stay importable from
// LibraryContext without an import cycle.

export type { AdminFetch } from '../../../lib/admin-query';

export interface AdminQueryOpts<T> {
  key: readonly unknown[];
  path: string | (() => string);
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
  /** Toast the error. Omit for the polls that deliberately fail silently. */
  toastOnError?: boolean;
  /**
   * Normalise the raw response into the shape callers use. Runs inside the
   * queryFn, NOT as `select`, deliberately: `select` transforms only what an
   * observer sees, while setQueriesData writes the RAW cached value — so a
   * `select` that unwrapped `{ results: [...] }` would leave patchAllRows
   * staring at a shape no component ever names. Normalising here makes the
   * cache the one true shape, which is what lets patchAllRows enumerate three
   * shapes rather than one per endpoint.
   */
  parse?: (raw: unknown) => T;
}

export function useAdminQuery<T>({
  key, path, enabled = true, staleTime, refetchInterval, toastOnError = false, parse,
}: AdminQueryOpts<T>): UseQueryResult<T> {
  const { adminFetch, ready } = useLibrary();
  return useSharedAdminQuery({
    key,
    adminFetch,
    request: async (fetcher, signal) => {
      const p = typeof path === 'function' ? path() : path;
      const raw = await adminJson<unknown>(fetcher, p, undefined, signal);
      return (parse ? parse(raw) : raw) as T;
    },
    enabled: enabled && ready,
    // Spread only when set. An explicit `staleTime: undefined` is a KEY on the
    // options object, and defaulting is a spread — so passing it through
    // unconditionally overwrote the client's 30s default with undefined (= 0)
    // and every list refetched on every remount, which is exactly the cache
    // reuse this change exists to get.
    ...(staleTime !== undefined ? { staleTime } : {}),
    ...(refetchInterval !== undefined ? { refetchInterval } : {}),
    toastOnError,
  });
}

export interface AdminMutationOpts<TData, TVars> {
  request: (vars: TVars, fetcher: AdminFetch) => Promise<TData>;
  onDone?: (data: TData, vars: TVars, qc: QueryClient) => void | Promise<void>;
  toastOnError?: boolean;
}

export function useAdminMutation<TData, TVars>(opts: AdminMutationOpts<TData, TVars>): UseMutationResult<TData, Error, TVars> {
  const { adminFetch } = useLibrary();
  return useSharedAdminMutation({ ...opts, adminFetch } satisfies SharedMutationOpts<TData, TVars>);
}
