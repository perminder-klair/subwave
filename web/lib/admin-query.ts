'use client';

import { useEffect, useRef } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { errorMessage, notify } from './notify';

export type AdminFetch = (path: string, init?: RequestInit) => Promise<Response>;

export class AdminResponseError<TBody = {
  error?: unknown;
  message?: unknown;
  fieldErrors?: Record<string, string>;
}> extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: TBody,
  ) {
    super(message);
    this.name = 'AdminResponseError';
  }
}

export async function adminResponse(
  adminFetch: AdminFetch,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  // React StrictMode immediately tears down and remounts effects once in
  // development. Yield before starting I/O so TanStack can abort that
  // throwaway observer without sending a duplicate request to the controller.
  if (signal) {
    await Promise.resolve();
    signal.throwIfAborted();
  }
  const response = await adminFetch(path, { ...init, ...(signal ? { signal } : {}) });
  if (response.ok) return response;

  const body = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown };
  const actionable = typeof body.error === 'string' && body.error
    ? body.error
    : typeof body.message === 'string' && body.message
      ? body.message
      : '';
  const detail = actionable ? `: ${actionable}` : '';
  throw new AdminResponseError(`${path} failed (${response.status})${detail}`, response.status, body);
}

export async function adminJson<T>(
  adminFetch: AdminFetch,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const response = await adminResponse(adminFetch, path, init, signal);
  return response.json() as Promise<T>;
}

export interface AdminQueryOpts<T> {
  key: readonly unknown[];
  adminFetch: AdminFetch;
  request: (fetcher: AdminFetch, signal: AbortSignal) => Promise<T>;
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: UseQueryOptions<T>['refetchInterval'];
  placeholderData?: UseQueryOptions<T>['placeholderData'];
  refetchOnMount?: UseQueryOptions<T>['refetchOnMount'];
  toastOnError?: boolean;
}

/** Toasts one notification per distinct query error. */
export function useQueryErrorToast(error: unknown, enabled: boolean): void {
  const lastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !error) {
      lastRef.current = null;
      return;
    }
    const message = errorMessage(error);
    if (lastRef.current === message) return;
    lastRef.current = message;
    notify.err(message);
  }, [error, enabled]);
}

export function useAdminQuery<T>(opts: AdminQueryOpts<T>): UseQueryResult<T> {
  const query = useQuery({
    queryKey: opts.key,
    queryFn: ({ signal }) => opts.request(opts.adminFetch, signal),
    enabled: opts.enabled ?? true,
    ...(opts.staleTime !== undefined ? { staleTime: opts.staleTime } : {}),
    ...(opts.refetchInterval !== undefined ? { refetchInterval: opts.refetchInterval } : {}),
    ...(opts.placeholderData !== undefined ? { placeholderData: opts.placeholderData } : {}),
    ...(opts.refetchOnMount !== undefined ? { refetchOnMount: opts.refetchOnMount } : {}),
  });
  useQueryErrorToast(query.error, opts.toastOnError ?? false);
  return query;
}

export interface AdminMutationOpts<TData, TVars> {
  adminFetch: AdminFetch;
  request: (vars: TVars, fetcher: AdminFetch) => Promise<TData>;
  onDone?: (data: TData, vars: TVars, client: QueryClient) => void | Promise<void>;
  toastOnError?: boolean;
}

export function useAdminMutation<TData, TVars>(
  opts: AdminMutationOpts<TData, TVars>,
): UseMutationResult<TData, Error, TVars> {
  const client = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: vars => opts.request(vars, opts.adminFetch),
    onSuccess: (data, vars) => opts.onDone?.(data, vars, client),
    onError: error => {
      if (opts.toastOnError !== false) notify.err(errorMessage(error));
    },
  });
}
