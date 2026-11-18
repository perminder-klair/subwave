import type { QueryClient } from '@tanstack/react-query';
import type { SessionTurn } from '../../../lib/types';
import { AdminResponseError, adminJson, type AdminFetch } from '../../../lib/admin-query';
import type { ScheduleOverride, Steer } from '../../../lib/schemas.generated';
import {
  UNKNOWN_TRUSTED_PROXIES,
  type ActResponse,
  type ConnectionsState,
  type DashStatus,
  type HealthStats,
  type NowPlayingFile,
  type QueueState,
  type RequestEntry,
} from './types';
import { scheduleKeys, type ScheduleLiveData } from '../schedule/queries';
import { toConnectionsState } from './connections';

export const dashKeys = {
  all: ['dash'] as const,
  status: () => ['dash', 'status'] as const,
  connections: () => ['dash', 'connections'] as const,
  stats: () => ['dash', 'stats'] as const,
  requests: () => ['dash', 'requests'] as const,
  suggestions: () => ['dash', 'suggestions'] as const,
  takeover: () => ['dash', 'takeover'] as const,
  // Nested under takeover() on purpose: a pin write invalidates that prefix,
  // and the preview it invalidates alongside is stale the moment one lands.
  takeoverWindow: () => ['dash', 'takeover', 'window'] as const,
  steer: () => ['dash', 'steer'] as const,
  navidrome: () => ['dash', 'banner', 'navidrome'] as const,
  musicStarved: () => ['dash', 'banner', 'music-starved'] as const,
  // Keyed by the track the request names (?id=): the format of one file never
  // changes, so a known one is fetched once per track.
  nowPlayingFile: (id: string) => ['dash', 'now-playing-file', id] as const,
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

/**
 * Drop a queued row from the cached status ahead of its DELETE; the poll
 * confirms. An in-flight status read is cancelled first so it cannot land over
 * the patch with the row still in it. The write is stamped like a fresh read
 * but carries everything else the cache held, now-playing included, so never
 * judge what is on air from this cache after a refetch: never-play's skip
 * reads the fetch's own answer instead (`refetchOnAirId`, #2018).
 */
export async function removeQueuedRow(client: QueryClient, id: string): Promise<void> {
  await client.cancelQueries({ queryKey: dashKeys.status(), exact: true }, { silent: true });
  client.setQueryData<DashStatus>(dashKeys.status(), current => current
    ? {
        ...current,
        queue: {
          ...(current.queue || {}),
          upcoming: (current.queue?.upcoming || []).filter(item => item.subsonic_id !== id),
        },
      }
    : current);
}

export async function fetchConnections(fetcher: AdminFetch, signal: AbortSignal): Promise<ConnectionsState> {
  const body = await adminJson<Partial<ConnectionsState>>(
    fetcher, '/listeners/connections', undefined, signal,
  );
  return toConnectionsState(body, UNKNOWN_TRUSTED_PROXIES);
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
  // Same message as ever; the status rides along so a caller can tell an
  // answer (the targeted skip's 409) from a failure.
  if (!response.ok) throw new AdminResponseError(result.error || `failed (${response.status})`, response.status, result);
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

/**
 * What `until: 'schedule-change'` would resolve to right now (#1601) — the
 * concrete end time the dialog shows before the operator commits.
 *
 * Advisory: POST /schedule/override resolves it again at its own `startedAt`,
 * so this is what the pin would be, never what it is. `source` says which rule
 * decided — the grid's own change (however near it is: there is no floor on
 * this path), or the ceiling, under either of its two meanings.
 */
export interface TakeoverWindow {
  expiresAt: number;
  minutes: number;
  source: 'schedule' | 'maximum' | 'ceiling';
  nextChangeAt: number | null;
}

export function fetchTakeoverWindow(fetcher: AdminFetch, signal: AbortSignal): Promise<TakeoverWindow> {
  return adminJson(fetcher, '/schedule/next-change', undefined, signal);
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

export interface SteerTrack {
  id: string;
  title: string;
  artist: string;
}

export interface SteerData {
  steer: Steer | null;
  /** The steer's opening tracks still to air. Operator-only: the public queue does not mark them. */
  queued: (SteerTrack & { sent: boolean })[];
  /** The token budget tier, so the card can say what a steer is worth now. */
  budgetMode: 'normal' | 'soft' | 'hard';
}

export async function fetchSteer(fetcher: AdminFetch, signal: AbortSignal): Promise<SteerData> {
  const body = await adminJson<Partial<SteerData>>(fetcher, '/steer', undefined, signal);
  return { steer: body.steer ?? null, budgetMode: body.budgetMode ?? 'normal', queued: body.queued ?? [] };
}

export function writeSteer(client: QueryClient, steer: Steer | null, queued: SteerTrack[] = []): void {
  client.setQueryData<SteerData>(dashKeys.steer(), current => ({
    steer,
    budgetMode: current?.budgetMode ?? 'normal',
    queued: steer ? queued.map(t => ({ ...t, sent: false })) : [],
  }));
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

export function fetchNowPlayingFile(fetcher: AdminFetch, id: string, signal: AbortSignal): Promise<NowPlayingFile> {
  return adminJson(fetcher, `/now-playing/file?id=${encodeURIComponent(id)}`, undefined, signal);
}
