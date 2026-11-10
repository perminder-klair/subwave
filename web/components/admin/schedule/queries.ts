'use client';

import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { ScheduleOverride } from '@/lib/schemas.generated';

export interface ScheduleLiveData {
  override: ScheduleOverride | null;
}

export const scheduleKeys = {
  all: ['schedule'] as const,
  override: () => ['schedule', 'override'] as const,
};

export function useScheduleOverrideQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<ScheduleLiveData>({
    key: scheduleKeys.override(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => {
      const body = await adminJson<{ override?: ScheduleOverride | null }>(
        fetcher, '/schedule', undefined, signal,
      );
      return { override: body.override ?? null };
    },
    toastOnError: false,
  });
}
