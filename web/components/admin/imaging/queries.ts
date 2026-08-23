'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { BedsData, SfxData, VoiceData } from './types';
import type { JingleEntry } from '../settings/shared';

export interface JinglesData { jingles?: JingleEntry[] }

export const imagingKeys = {
  all: ['imaging'] as const,
  jingles: () => ['imaging', 'jingles'] as const,
  sfx: () => ['imaging', 'sfx'] as const,
  beds: () => ['imaging', 'beds'] as const,
  voices: () => ['imaging', 'voices'] as const,
};

function useImagingResource<T>(
  key: readonly unknown[],
  path: string,
  adminFetch: AdminFetch,
  enabled: boolean,
): UseQueryResult<T> {
  return useAdminQuery<T>({
    key,
    adminFetch,
    enabled,
    refetchInterval: 3_000,
    request: (fetcher, signal) => adminJson<T>(fetcher, path, undefined, signal),
    toastOnError: false,
  });
}

export const useJinglesQuery = (adminFetch: AdminFetch, enabled: boolean) =>
  useImagingResource<JinglesData>(imagingKeys.jingles(), '/jingles', adminFetch, enabled);
export const useSfxQuery = (adminFetch: AdminFetch, enabled: boolean) =>
  useImagingResource<SfxData>(imagingKeys.sfx(), '/sfx', adminFetch, enabled);
export const useBedsQuery = (adminFetch: AdminFetch, enabled: boolean) =>
  useImagingResource<BedsData>(imagingKeys.beds(), '/beds', adminFetch, enabled);
export const useVoicesQuery = (adminFetch: AdminFetch, enabled: boolean) =>
  useImagingResource<VoiceData>(imagingKeys.voices(), '/voices', adminFetch, enabled);
