import type { QueryClient } from '@tanstack/react-query';
import type { SessionTurn } from '../../../lib/types';
import { AdminResponseError, adminJson, type AdminFetch } from '../../../lib/admin-query';
import type { ScheduleOverride } from '../../../lib/schemas.generated';
import type {
  ActResponse,
  ConnectionsState,
  DashStatus,
  HealthStats,
  QueueState,
  RequestEntry,
} from './types';
import { scheduleKeys, type ScheduleLiveData } from '../schedule/queries';

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

async function degradedJson<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    // Dashboard status is deliberately best-effort across three independently
    // rolling resources. Preserve a controller error envelope as that slice's
    // data; transport and abort failures still reject the combined poll.
    if (error instanceof AdminResponseError) return error.body as T;
    throw error;
  }
}

export async function fetchDashStatus(fetcher: AdminFetch, signal: AbortSignal): Promise<DashStatus> {
  const [nowPlaying, state, session] = await Promise.all([
    degradedJson(adminJson<Partial<DashStatus>>(fetcher, '/now-playing', undefined, signal)),
    degradedJson(adminJson<QueueState>(fetcher, '/state', undefined, signal)),
    degradedJson(adminJson<{ messages?: SessionTurn[] }>(fetcher, '/session', undefined, signal)),
  ]);
  return { ...nowPlaying, queue: state ?? {}, sessionMessages: session?.messages ?? [] };
}

export async function fetchConnections(fetcher: AdminFetch, signal: AbortSignal): Promise<ConnectionsState> {
  const body = await adminJson<Partial<ConnectionsState>>(
    fetcher, '/listeners/connections', undefined, signal,
  );
  return { count: body?.count ?? 0, connections: body?.connections ?? [] };
}

export function fetchHealthStats(fetcher: AdminFetch, signal: AbortSignal): Promise<HealthStats> {
  return adminJson(fetcher, '/stats', undefined, signal);
}

export async function fetchRequests(fetcher: AdminFetch, signal: AbortSignal): Promise<RequestEntry[]> {
  const body = await adminJson<{ requests?: RequestEntry[] }>(
    fetcher, '/requests', undefined, signal,
  );
  return body?.requests ?? [];
}

export async function fetchSuggestions(fetcher: AdminFetch, signal: AbortSignal): Promise<string[] | null> {
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

/** One `/schedule/override` write owns both route-specific views of the pin. */
export function writeTakeoverOverride(
  client: QueryClient,
  override: ScheduleOverride | null,
): void {
  client.setQueryData<TakeoverData>(dashKeys.takeover(), current => ({
    shows: current?.shows ?? [],
    override,
  }));
  client.setQueryData<ScheduleLiveData>(scheduleKeys.override(), { override });
}

/** Patch the Dashboard picker when Shows returns its authoritative roster. */
export function writeTakeoverShows(
  client: QueryClient,
  rawShows: Array<{ id?: string; name?: string }>,
): void {
  const shows = rawShows.flatMap(show => (
    typeof show?.id === 'string' && show.id
      ? [{ id: show.id, name: typeof show.name === 'string' ? show.name : '' }]
      : []
  ));
  client.setQueryData<TakeoverData>(dashKeys.takeover(), current => (
    current ? { ...current, shows } : current
  ));
}

export async function fetchTakeover(fetcher: AdminFetch, signal: AbortSignal): Promise<TakeoverData> {
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
  return adminJson(fetcher, '/doctor/navidrome', undefined, signal);
}

export async function fetchMusicStarved(fetcher: AdminFetch, signal: AbortSignal): Promise<boolean> {
  const body = await adminJson<{ musicStarved?: boolean }>(fetcher, '/state', undefined, signal);
  return body.musicStarved === true;
}
