// The runtime station base is the site root, with /api and stream mounts
// on the same origin (docker/Caddyfile).

import { mountFor, type StreamFormat } from './streamFormat';
import {
  normalizeStationBase,
  resolveStationConnection,
  type StationCredentials,
} from './station-credentials';
import type {
  DjPublic,
  LikeResult,
  LikeStatus,
  NowPlayingResponse,
  RequestResult,
  SchedulePayload,
  SessionPayload,
  StationState,
  ThemesPayload,
} from './types';

export interface RequestBody {
  text: string;
  name?: string;
}

/** POST /beacon payload. An app has no referrer or UTM query, so callers
 *  report the platform via `utmSource`. */
export interface BeaconBody {
  referrer?: string;
  path?: string;
  utmSource?: string;
}

/** Why a health probe failed. `network` is the catch-all for DNS, refused
 *  connections and TLS errors, which RN's fetch collapses into one rejection
 *  with no detail. `http` is a response with a non-2xx status (usually /api
 *  not routed to the controller). `timeout` is our own abort firing. */
export type HealthResult =
  | { ok: true }
  | { ok: false; kind: 'timeout' | 'http' | 'network'; status?: number; message?: string };

export interface StationApi {
  base: string;
  nowPlaying(signal?: AbortSignal): Promise<NowPlayingResponse>;
  state(signal?: AbortSignal): Promise<StationState>;
  session(signal?: AbortSignal): Promise<SessionPayload>;
  schedule(signal?: AbortSignal): Promise<SchedulePayload>;
  dj(signal?: AbortSignal): Promise<DjPublic>;
  themes(signal?: AbortSignal): Promise<ThemesPayload>;
  health(signal?: AbortSignal): Promise<boolean>;
  /** Like health(), but returns why it failed instead of throwing. */
  probeHealth(signal?: AbortSignal): Promise<HealthResult>;
  postRequest(body: RequestBody): Promise<RequestResult>;
  pollRequest(id: string): Promise<RequestResult>;
  /** Like the currently playing track (#991). `songId` is what the client
   *  believes is on air; the controller rejects a stale tap. Error statuses
   *  come back as a LikeResult with `error`; null on network error. */
  likeCurrent(songId: string): Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null on network error. */
  likeStatus(): Promise<LikeStatus | null>;
  /** Fire-and-forget audience beacon; all failures are swallowed. */
  postBeacon(body: BeaconBody): Promise<void>;
  /** Absolute URL for an album cover. */
  cover(subsonicId: string): string;
  /** Absolute URL for a persona avatar. The controller emits
   *  activeShow.persona.avatar without the `/api` prefix; this adds it. */
  avatar(path: string): string;
  /** The Icecast mount for `format`, defaulting to the MP3 floor. Callers gate
   *  a non-MP3 format on platform + station support first. Carries no embedded
   *  credentials; see streamHeaders(). */
  streamUrl(format?: StreamFormat): string;
  /** `{ Authorization: 'Basic …' }` when the station has credentials, else
   *  undefined. iOS AVPlayer ignores URL userinfo, so the credential must
   *  travel as a header or the stream 401s (#764) — unlike the fetch/Image
   *  paths, which honour it. */
  streamHeaders(): Record<string, string> | undefined;
}

/** Strip a trailing slash; default to https:// if the user typed a bare host. */
export function normalizeBase(raw: string): string {
  return normalizeStationBase(raw);
}

// Compose timeouts manually: RN fetch lacks AbortSignal.timeout and any.
const FETCH_TIMEOUT_MS = 8000;

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const outer = init?.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort);
  }
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  });
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetchWithTimeout(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export function createApi(
  rawBase: string,
  credentials?: StationCredentials | null,
): StationApi {
  const connection = resolveStationConnection(rawBase, credentials);
  // Persist credential-free bases. Reconstruct userinfo only for fetch/Image;
  // AVPlayer needs an explicit header (#764/#1300).
  const { base: cleanBase, requestBase, authorization } = connection;
  const streamAuthHeaders: Record<string, string> | undefined = authorization
    ? { Authorization: authorization }
    : undefined;
  const api = (p: string) => `${requestBase}/api${p}`;
  const probeHealth = async (signal?: AbortSignal): Promise<HealthResult> => {
    try {
      const res = await fetchWithTimeout(api('/health'), { cache: 'no-store', signal });
      return res.ok ? { ok: true } : { ok: false, kind: 'http', status: res.status };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      const aborted = signal?.aborted || err?.name === 'AbortError';
      return { ok: false, kind: aborted ? 'timeout' : 'network', message: err?.message };
    }
  };
  return {
    base: cleanBase,
    nowPlaying: (signal) => getJson<NowPlayingResponse>(api('/now-playing'), signal),
    state: (signal) => getJson<StationState>(api('/state'), signal),
    session: (signal) => getJson<SessionPayload>(api('/session'), signal),
    schedule: (signal) => getJson<SchedulePayload>(api('/schedule'), signal),
    dj: (signal) => getJson<DjPublic>(api('/dj'), signal),
    themes: (signal) => getJson<ThemesPayload>(api('/themes'), signal),
    // useSignal relies on network/TLS/timeout errors throwing; HTTP failures return false.
    health: async (signal) => {
      const r = await probeHealth(signal);
      if (r.ok) return true;
      if (r.kind === 'http') return false;
      throw new Error(r.message || r.kind);
    },
    probeHealth,
    postRequest: (body) =>
      fetchWithTimeout(api('/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<RequestResult>),
    postBeacon: async (body) => {
      try {
        await fetchWithTimeout(api('/beacon'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        /* best-effort analytics */
      }
    },
    pollRequest: async (id) => {
      const res = await fetchWithTimeout(api(`/request/${encodeURIComponent(id)}`));
      if (res.status === 404) return { success: false, status: 'unknown' };
      return (await res.json()) as RequestResult;
    },
    likeCurrent: async (songId) => {
      try {
        const res = await fetchWithTimeout(api('/like'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songId }),
        });
        return (await res.json()) as LikeResult;
      } catch {
        return null;
      }
    },
    likeStatus: async () => {
      try {
        const res = await fetchWithTimeout(api('/like'));
        return (await res.json()) as LikeStatus;
      } catch {
        return null;
      }
    },
    cover: (subsonicId) => api(`/cover/${encodeURIComponent(subsonicId)}`),
    avatar: (path) => {
      if (!path) return '';
      if (/^https?:\/\//i.test(path)) return path;
      return api(path.startsWith('/') ? path : `/${path}`);
    },
    streamUrl: (format = 'mp3') => `${cleanBase}${mountFor(format)}`,
    streamHeaders: () => streamAuthHeaders,
  };
}
