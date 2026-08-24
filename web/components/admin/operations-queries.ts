'use client';

import { useCallback, useRef } from 'react';
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { Webhook, WebhookEvent } from '@/lib/schemas.generated';

export interface StationRow {
  id: string | null;
  name: string;
  configured: boolean;
  createdAt: string | null;
  active: boolean;
}

export interface StationsResponse {
  multiStation: boolean;
  activeId: string | null;
  limit?: number;
  stations: StationRow[];
}

export interface WebhooksResponse {
  events: WebhookEvent[];
  webhooks: Webhook[];
  trackPlayListenerGated?: boolean;
}

export interface ArchiveEntry {
  path: string;
  date: string;
  hour: number;
  bytes: number;
  mtime: string;
}

export interface RestorableFile {
  name: string;
  size: number;
  mtime: string;
}

export interface RestorableBackups {
  files: RestorableFile[];
  stateDir: string | null;
}

export const operationKeys = {
  stations: () => ['operations', 'stations'] as const,
  webhooks: () => ['operations', 'webhooks'] as const,
  archives: () => ['operations', 'archives'] as const,
  restorableBackups: () => ['operations', 'restorable-backups'] as const,
};

export function useStationsQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<StationsResponse>({
    key: operationKeys.stations(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<StationsResponse>(fetcher, '/stations', undefined, signal);
      return { ...response, stations: Array.isArray(response.stations) ? response.stations : [] };
    },
    toastOnError: false,
  });
}

export function useWebhooksQuery(
  adminFetch: AdminFetch,
  enabled = true,
  refetchOnMount?: UseQueryOptions<WebhooksResponse>['refetchOnMount'],
) {
  return useAdminQuery<WebhooksResponse>({
    key: operationKeys.webhooks(),
    adminFetch,
    enabled,
    ...(refetchOnMount !== undefined ? { refetchOnMount } : {}),
    request: async (fetcher, signal) => {
      const response = await adminJson<WebhooksResponse>(fetcher, '/webhooks', undefined, signal);
      return {
        ...response,
        events: Array.isArray(response.events) ? response.events : [],
        webhooks: Array.isArray(response.webhooks) ? response.webhooks : [],
        trackPlayListenerGated: !!response.trackPlayListenerGated,
      };
    },
    toastOnError: false,
  });
}

export function patchWebhooks(
  client: QueryClient,
  patch: Partial<Pick<WebhooksResponse, 'webhooks' | 'trackPlayListenerGated'>>,
): void {
  client.setQueryData<WebhooksResponse>(operationKeys.webhooks(), previous => (
    previous ? { ...previous, ...patch } : previous
  ));
}

/**
 * Authorization headers must exist only long enough to build the request.
 * TanStack receives void variables/data; the short-lived refs are cleared in
 * finally, and only the redacted response is allowed into the shared cache.
 */
export function useSensitiveWebhooksMutation<TWebhook extends { authHeader?: string }>(adminFetch: AdminFetch): {
  isPending: boolean;
  mutateAsync: (webhooks: TWebhook[]) => Promise<Partial<WebhooksResponse>>;
} {
  const client = useQueryClient();
  const payloadRef = useRef<TWebhook[] | null>(null);
  const receiptRef = useRef<Partial<WebhooksResponse> | null>(null);
  const mutation = useMutation<void, Error, void>({
    mutationKey: [...operationKeys.webhooks(), 'save'],
    mutationFn: async () => {
      const webhooks = payloadRef.current;
      if (!webhooks) throw new Error('webhook save payload unavailable');
      const receipt = await adminJson<Partial<WebhooksResponse>>(adminFetch, '/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhooks }),
      });
      const safeReceipt: Partial<WebhooksResponse> = {
        ...(Array.isArray(receipt.events) ? { events: receipt.events } : {}),
        ...(typeof receipt.trackPlayListenerGated === 'boolean'
          ? { trackPlayListenerGated: receipt.trackPlayListenerGated }
          : {}),
        ...(Array.isArray(receipt.webhooks) ? {
          webhooks: receipt.webhooks.map(webhook => ({
            ...webhook,
            authHeader: webhook.authHeader ? 'set' : '',
          })),
        } : {}),
      };
      receiptRef.current = safeReceipt;
      if (safeReceipt.webhooks) patchWebhooks(client, { webhooks: safeReceipt.webhooks });
    },
  });
  const runMutation = mutation.mutateAsync;
  const mutateAsync = useCallback(async (webhooks: TWebhook[]) => {
    if (payloadRef.current) throw new Error('webhook save already in progress');
    payloadRef.current = webhooks;
    receiptRef.current = null;
    try {
      await runMutation();
      return receiptRef.current ?? {};
    } finally {
      payloadRef.current = null;
      receiptRef.current = null;
    }
  }, [runMutation]);
  return { isPending: mutation.isPending, mutateAsync };
}

export function useArchivesQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<ArchiveEntry[]>({
    key: operationKeys.archives(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<{ archives?: ArchiveEntry[] }>(
        fetcher, '/archives', undefined, signal,
      );
      return Array.isArray(response.archives) ? response.archives : [];
    },
    toastOnError: false,
  });
}

export function useRestorableBackupsQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<RestorableBackups>({
    key: operationKeys.restorableBackups(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const response = await adminJson<{ files?: RestorableFile[]; stateDir?: string }>(
        fetcher, '/backup/restorable', undefined, signal,
      );
      return {
        files: Array.isArray(response.files) ? response.files : [],
        stateDir: response.stateDir || null,
      };
    },
    toastOnError: false,
  });
}
