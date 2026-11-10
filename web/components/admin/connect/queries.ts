'use client';

import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { Catalog } from './types';

export const connectKeys = {
  all: ['connect'] as const,
  catalog: () => ['connect', 'catalog'] as const,
};

export function useConnectCatalogQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<Catalog>({
    key: connectKeys.catalog(),
    adminFetch,
    enabled,
    request: (fetcher, signal) => adminJson<Catalog>(
      fetcher, '/connect/catalog', undefined, signal,
    ),
    toastOnError: false,
  });
}
