'use client';

import {
  QueryObserver,
  type FetchQueryOptions,
  type QueryClient,
} from '@tanstack/react-query';
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

function normalizeThemes(response: AdminThemesResponse): AdminThemesData {
  return {
    themes: Array.isArray(response.themes) ? response.themes : [],
    active: typeof response.active === 'string' ? response.active : '',
  };
}

export async function fetchAdminThemes(
  adminFetch: AdminFetch,
  signal: AbortSignal,
): Promise<AdminThemesData> {
  return normalizeThemes(
    await adminJson<AdminThemesResponse>(adminFetch, '/themes', undefined, signal),
  );
}

// Theme mutation receipts intentionally omit `active`. Always replace the
// shared entry with the authoritative GET before another route can consume it;
// preserving the previous id can leave Shows pointing at a removed theme.
export async function refetchAdminThemes(
  client: QueryClient,
  adminFetch: AdminFetch,
): Promise<AdminThemesData> {
  const options: FetchQueryOptions<AdminThemesData> = {
    queryKey: adminThemeKeys.detail(),
    queryFn: ({ signal }) => fetchAdminThemes(adminFetch, signal),
    staleTime: 0,
  };
  // A settings save can re-render/unmount ThemeSection while this read is in
  // flight. Keep one disabled observer attached so TanStack does not abort the
  // exact-key fetch when the UI observer disappears; the request still owns
  // and consumes Query's AbortSignal. Cancel first so a pre-write GET cannot be
  // deduped as the mutation's authoritative result.
  await client.cancelQueries(
    { queryKey: adminThemeKeys.detail(), exact: true },
    { silent: true },
  );
  const observer = new QueryObserver<AdminThemesData>(client, {
    queryKey: adminThemeKeys.detail(),
    enabled: false,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    return await client.fetchQuery<AdminThemesData>(options);
  } finally {
    unsubscribe();
  }
}

export async function reconcileAdminThemesAfterWrite(
  client: QueryClient,
  adminFetch: AdminFetch,
  refreshPublic: (() => Promise<void>) | undefined,
): Promise<
  | { ok: true; data: AdminThemesData }
  | { ok: false; error: unknown }
> {
  try {
    return { ok: true, data: await refetchAdminThemes(client, adminFetch) };
  } catch (error) {
    // The write has committed, but the old exact entry is no longer truthful.
    // Public ThemeProvider owns the painted/listener-facing reconciliation and
    // deliberately swallows network errors while retaining its last good CSS.
    client.removeQueries({ queryKey: adminThemeKeys.detail(), exact: true });
    await refreshPublic?.();
    return { ok: false, error };
  }
}

export function useAdminThemesQuery(adminFetch: AdminFetch, enabled: boolean) {
  return useAdminQuery<AdminThemesData>({
    key: adminThemeKeys.detail(),
    adminFetch,
    enabled,
    request: fetchAdminThemes,
    toastOnError: false,
  });
}
