'use client';

import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { CommunityPersona } from './types';

export const personaKeys = {
  all: ['personas'] as const,
  community: () => ['personas', 'community'] as const,
};

export function useCommunityPersonas(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<CommunityPersona[]>({
    key: personaKeys.community(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const result = await adminJson<{ community?: CommunityPersona[] }>(
        fetcher,
        '/personas/community',
        undefined,
        signal,
      );
      return Array.isArray(result.community) ? result.community : [];
    },
    toastOnError: false,
  });
}
