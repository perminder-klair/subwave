import type { SessionTurn } from '../../../lib/types';
import { adminJson, type AdminFetch } from '../../../lib/admin-query';
import type { ScheduleOverride } from '../../../lib/schemas.generated';
import type {
  ActResponse,
  ConnectionsState,
  DashStatus,
  HealthStats,
  QueueState,
  RequestEntry,
} from './types';

export const dashKeys = {
  all: ['dash'] as const,
  status: () => ['dash', 'status'] as const,
  connections: () => ['dash', 'connections'] as const,
  stats: () => ['dash', 'stats'] as const,
  requests: () => ['dash', 'requests'] as const,
  suggestions: () => ['dash', 'suggestions'] as const,
  takeover: () => ['dash', 'takeover'] as const,
  navidrome: () => ['dash', 'banner', 'navidrome'] as const,
  musicStarved: () => ['dash', 'banner', 'music-starved'] as const,
};

export async function fetchDashStatus(fetcher: AdminFetch, signal: AbortSignal): Promise<DashStatus> {
  const [nowPlaying, state, session] = await Promise.all([
    // admin-query-owned: GET /now-playing
    adminJson<Partial<DashStatus>>(fetcher, '/now-playing', undefined, signal),
    // admin-query-owned: GET /state
    adminJson<QueueState>(fetcher, '/state', undefined, signal),
    // admin-query-owned: GET /session
    adminJson<{ messages?: SessionTurn[] }>(fetcher, '/session', undefined, signal),
  ]);
  return { ...nowPlaying, queue: state, sessionMessages: session.messages ?? [] };
}

export async function fetchConnections(fetcher: AdminFetch, signal: AbortSignal): Promise<ConnectionsState> {
  // admin-query-owned: GET /listeners/connections
  const body = await adminJson<Partial<ConnectionsState>>(
    fetcher, '/listeners/connections', undefined, signal,
  );
  return { count: body?.count ?? 0, connections: body?.connections ?? [] };
}

export function fetchHealthStats(fetcher: AdminFetch, signal: AbortSignal): Promise<HealthStats> {
  // admin-query-owned: GET /stats
  return adminJson(fetcher, '/stats', undefined, signal);
}

export async function fetchRequests(fetcher: AdminFetch, signal: AbortSignal): Promise<RequestEntry[]> {
  // admin-query-owned: GET /requests
  const body = await adminJson<{ requests?: RequestEntry[] }>(
    fetcher, '/requests', undefined, signal,
  );
  return body?.requests ?? [];
}

export async function fetchSuggestions(fetcher: AdminFetch, signal: AbortSignal): Promise<string[] | null> {
  // admin-query-owned: GET /generate/say-suggestions
  const body = await adminJson<{ suggestions?: string[] | null }>(
    fetcher, '/generate/say-suggestions', undefined, signal,
  );
  return Array.isArray(body?.suggestions) && body.suggestions.length ? body.suggestions : null;
}

export async function runDashAction(
  fetcher: AdminFetch,
  path: string,
  body: Record<string, unknown> | null,
): Promise<ActResponse> {
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const result = await response.json().catch(() => ({})) as ActResponse;
  if (!response.ok) throw new Error(result.error || `failed (${response.status})`);
  return result;
}

export interface TakeoverShow {
  id: string;
  name: string;
}

export interface TakeoverData {
  shows: TakeoverShow[];
  override: ScheduleOverride | null;
}

export async function fetchTakeover(fetcher: AdminFetch, signal: AbortSignal): Promise<TakeoverData> {
  // admin-query-owned: GET /schedule
  const body = await adminJson<{
    shows?: TakeoverShow[];
    override?: ScheduleOverride | null;
  }>(fetcher, '/schedule', undefined, signal);
  return {
    shows: Array.isArray(body.shows)
      ? body.shows.filter(show => show && typeof show.id === 'string' && show.id)
      : [],
    override: body.override ?? null,
  };
}

export interface NavidromeStatus {
  ok: boolean;
  reason?: string;
  url?: string;
}

export function fetchNavidromeStatus(fetcher: AdminFetch, signal: AbortSignal): Promise<NavidromeStatus> {
  // admin-query-owned: GET /doctor/navidrome
  return adminJson(fetcher, '/doctor/navidrome', undefined, signal);
}

export async function fetchMusicStarved(fetcher: AdminFetch, signal: AbortSignal): Promise<boolean> {
  // admin-query-owned: GET /state
  const body = await adminJson<{ musicStarved?: boolean }>(fetcher, '/state', undefined, signal);
  return body.musicStarved === true;
}
