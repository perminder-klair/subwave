// The Hotline's admin reads and writes (docs/plans/hotline.md): one resource,
// GET /hotline/admin, polled while a page shows it, and the three operator
// commands that change it (end the Call, add or lift a ban).
import { adminJson, useAdminMutation, useAdminQuery, type AdminFetch } from '../../../lib/admin-query';

export interface HotlineBan { id: string; deviceId: string; ip: string; name: string; at: string }

export interface HotlineRecentCall {
  id: string;
  at: string;
  name: string;
  showName: string | null;
  durationSec: number;
  outcome: 'granted' | 'declined' | 'chat' | 'dropped';
  track: string | null;
  endedBy: string;
}

export interface HotlineAdmin {
  state: 'closed' | 'open' | 'busy';
  reason: 'provider' | 'requests' | 'show' | 'minutes' | null;
  providerReady: boolean;
  provider: string;
  call: {
    id: string;
    name: string;
    showName: string | null;
    startedAt: string;
    elapsedSec: number;
    capSec: number;
    granted: { title: string; artist: string } | null;
    declined: boolean;
  } | null;
  today: { day: string; secondsUsed: number; dailyMinutes: number; secondsLeft: number };
  bans: HotlineBan[];
  recent: HotlineRecentCall[];
}

export const hotlineKeys = {
  all: ['hotline'] as const,
  admin: () => ['hotline', 'admin'] as const,
};

export function useHotlineAdminQuery(adminFetch: AdminFetch, { enabled = true, poll = false } = {}) {
  return useAdminQuery<HotlineAdmin>({
    key: hotlineKeys.admin(),
    adminFetch,
    enabled,
    request: (fetcher, signal) => adminJson<HotlineAdmin>(fetcher, '/hotline/admin', undefined, signal),
    ...(poll ? { refetchInterval: 5000 } : {}),
  });
}

type HotlineCommand =
  | { kind: 'end' }
  | { kind: 'ban'; callId: string }
  | { kind: 'unban'; banId: string };

export function useHotlineCommand(adminFetch: AdminFetch) {
  return useAdminMutation<unknown, HotlineCommand>({
    adminFetch,
    request: (cmd, fetcher) => {
      if (cmd.kind === 'end') return adminJson(fetcher, '/hotline/admin/end', { method: 'POST' });
      if (cmd.kind === 'ban') {
        return adminJson(fetcher, '/hotline/admin/bans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId: cmd.callId }),
        });
      }
      return adminJson(fetcher, `/hotline/admin/bans/${encodeURIComponent(cmd.banId)}`, { method: 'DELETE' });
    },
    onDone: (_data, _vars, client) => client.invalidateQueries({ queryKey: hotlineKeys.admin() }),
  });
}
