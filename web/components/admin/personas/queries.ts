'use client';

import type { QueryClient } from '@tanstack/react-query';
import { adminJson, type AdminFetch } from '@/lib/admin-query';
import { useAdminQuery } from '@/lib/admin-query';
import type { ScheduleOverride } from '@/lib/schemas.generated';
import { settingsKeys } from '../settings/queries';
import { patchShowSettings } from '../shows/queries';
import type { Schedule, Show } from '../shows/types';
import { dashKeys } from '../dash/queries';
import { scheduleKeys } from '../schedule/queries';
import type { CommunityPersona, Persona, SettingsResponse } from './types';

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

/** DELETE /personas/:id's receipt: the persisted state after the cascade. */
export interface PersonaDeleteResult {
  personas?: Array<Partial<Persona>>;
  activePersonaId?: string;
  shows?: Array<Partial<Show>>;
  schedule?: Schedule;
  scheduleOverride?: ScheduleOverride | null;
}

// A persona delete cascades into shows, the grid and possibly a takeover, so
// its receipt reaches every cache projecting those. The settings envelope takes
// the roster; shows and the grid go through patchShowSettings, the Shows
// reconciler, which also feeds the Dashboard takeover picker. Both takeover
// views are invalidated rather than written: either may not be cached at all,
// and writeTakeoverOverride would seed the Dashboard's with an empty picker.
// `onAir` naming the deleted persona means its own show was on air and is now
// gone, so the default persona has the hour.
export function patchPersonaDelete(client: QueryClient, result: PersonaDeleteResult): void {
  client.setQueryData<SettingsResponse>(settingsKeys.detail(), previous => {
    if (!previous?.values || !Array.isArray(result.personas)) return previous;
    const ids = result.personas.map(p => p.id);
    const activePersonaId = result.activePersonaId ?? previous.values.activePersonaId;
    const onAirGone = !!previous.onAir?.personaId && !ids.includes(previous.onAir.personaId);
    return {
      ...previous,
      ...(onAirGone ? { onAir: { personaId: activePersonaId ?? '', show: null } } : {}),
      values: { ...previous.values, personas: result.personas, activePersonaId },
    };
  });
  patchShowSettings(client, {
    ...(Array.isArray(result.shows) ? { shows: result.shows } : {}),
    ...(result.schedule ? { schedule: result.schedule } : {}),
  });
  void client.invalidateQueries({ queryKey: scheduleKeys.override(), exact: true });
  void client.invalidateQueries({ queryKey: dashKeys.takeover() });
}
