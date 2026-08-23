'use client';

import type { QueryClient } from '@tanstack/react-query';
import {
  adminJson,
  type AdminFetch,
  useAdminQuery,
} from '../../lib/admin-query';

export interface AdminTheme {
  id: string;
  name: string;
  description?: string;
  mode: 'light' | 'dark';
  tokens: Record<string, string>;
  builtin?: boolean;
}

export interface AdminThemesData {
  themes: AdminTheme[];
  active: string;
}

export type AdminThemesResponse = {
  themes?: AdminTheme[];
  active?: string;
};

export const adminThemeKeys = {
  all: ['themes'] as const,
  detail: () => ['themes', 'admin'] as const,
};

function normalizeThemes(
  response: AdminThemesResponse,
  previous?: AdminThemesData,
): AdminThemesData {
  return {
    themes: Array.isArray(response.themes) ? response.themes : [],
    active: typeof response.active === 'string' ? response.active : (previous?.active ?? ''),
  };
}

export function patchAdminThemes(
  client: QueryClient,
  response: AdminThemesResponse,
): void {
  client.setQueryData<AdminThemesData>(
    adminThemeKeys.detail(),
    previous => normalizeThemes(response, previous),
  );
}

export function useAdminThemesQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<AdminThemesData>({
    key: adminThemeKeys.detail(),
    adminFetch,
    enabled,
    request: async (fetcher, signal) => normalizeThemes(
      await adminJson<AdminThemesResponse>(fetcher, '/themes', undefined, signal),
    ),
    toastOnError: false,
  });
}
