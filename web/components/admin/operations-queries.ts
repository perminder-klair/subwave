'use client';

import type { QueryClient } from '@tanstack/react-query';
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

export function useWebhooksQuery(adminFetch: AdminFetch, enabled = true) {
  return useAdminQuery<WebhooksResponse>({
    key: operationKeys.webhooks(),
    adminFetch,
    enabled,
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
