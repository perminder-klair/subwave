// Runtime API client, and the only place that knows the controller's URL
// shape. The base is resolved at runtime from StationContext (the app is
// multi-station) and is the station's site root: the API is mounted under
// `/api` and Icecast at `/stream.mp3` on the same origin, per docker/Caddyfile.

import { mountFor, type StreamFormat } from './streamFormat';
import {
  authorizationFor,
  normalizeStationBase,
  resolveStationConnection,
  splitStationAddress,
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

/** Split a normalized base into a credential-free base URL and, if it carried
 *  `user:pass@` userinfo, an `Authorization: Basic` header value. */
export function splitCredentials(rawBase: string): {
  base: string;
  authorization: string | null;
} {
  const split = splitStationAddress(rawBase);
  return {
    base: split.base,
    authorization: split.credentials ? authorizationFor(split.credentials) : null,
  };
}

// Hard timeout on every call so a hung origin can't stall the 5s feed poll.
// Composed by hand with any caller signal: RN's fetch polyfill has no
// AbortSignal.timeout/any.
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
  // The persisted/displayed base stays credential-free; URL userinfo is
  // reconstructed only inside this live client for the fetch/Image paths, and
  // AVPlayer gets the explicit header below (#764/#1300).
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
    // A non-2xx response resolves false, but a network/TLS error or timeout
    // throws: useSignal relies on the throw to detect a dead link.
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
        // Error statuses carry a JSON body too — surface it, don't throw.
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
