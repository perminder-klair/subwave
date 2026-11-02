// The runtime station base is the site root, with /api and stream mounts
// on the same origin (docker/Caddyfile).

import { lyricsResultFor, type LyricsResult } from './lyrics';
import type { StreamFormat } from './streamFormat';
import { rateLimitedUntil, stationAuthResult, withStreamAuth, type StationAuthResult } from './station-password';
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
 *  not routed to the controller); `challenge` is its `WWW-Authenticate`
 *  header as sent, absent without one. An HTTP auth layer in front of the
 *  station sends one and the controller never does (#1873); loginRefused
 *  reads its scheme. `timeout` is our own abort firing. */
export type HealthResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'timeout' | 'http' | 'network';
      status?: number;
      challenge?: string;
      message?: string;
    };

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
   *  come back as a LikeResult with `error`; null when no answer could be read:
   *  a network error, a body that is not JSON, or one that never arrives. */
  likeCurrent(songId: string): Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null as for likeCurrent. */
  likeStatus(): Promise<LikeStatus | null>;
  /** Fire-and-forget audience beacon; all failures are swallowed. */
  postBeacon(body: BeaconBody): Promise<void>;
  /** Lyrics for the track this listener is hearing (now-playing's
   *  `subsonic_id`). A private station gates it on the station password,
   *  sent as `x-station-auth`. Never throws. */
  currentLyrics(songId: string): Promise<LyricsResult>;
  /** Check a private-station password against `POST /station-auth` (#478),
   *  which fails closed and is rate-limited. Never throws. */
  checkStationAuth(password: string): Promise<StationAuthResult>;
  /** When the latest `/station-auth` answer said to ask again: a 429's
   *  `Retry-After`, or 0 for none. The limit covers the whole address, so this
   *  holds whichever check saw it. */
  stationAuthHeldUntil(): number;
  /** Absolute URL for an album cover. It still carries the login as URL
   *  userinfo for RNTP's iOS lock-screen artwork, which loads it with a bare
   *  URLSession request that takes no headers; every loader that does take
   *  headers gets imageHeaders() too. */
  cover(subsonicId: string): string;
  /** Absolute URL for a persona avatar. The controller emits
   *  activeShow.persona.avatar without the `/api` prefix; this adds it. */
  avatar(path: string): string;
  /** Headers for loading `url` as an image (expo-image, the cover colours,
   *  the Live Activity artwork): the Station login when `url` is on this
   *  station, else undefined, since an avatar can be an absolute URL on
   *  another host. Android's image loaders ignore URL userinfo, so this is
   *  what reaches the proxy there (#1873). */
  imageHeaders(url: string): Record<string, string> | undefined;
  /** The Icecast mount for `format`, defaulting to the MP3 floor. Callers gate
   *  a non-MP3 format on platform + station support first. Carries no embedded
   *  login (see streamHeaders()), but does carry the private-station password
   *  as `?auth=` when one is saved — read at call time, so unlocking a station
   *  never has to rebuild this client. */
  streamUrl(format?: StreamFormat): string;
  /** `{ Authorization: 'Basic …' }` when the station has credentials, else
   *  undefined (loginHeaders). iOS AVPlayer ignores URL userinfo, so the
   *  credential must travel as a header or the stream 401s (#764). */
  streamHeaders(): Record<string, string> | undefined;
}

/** Strip a trailing slash; default to https:// if the user typed a bare host. */
export function normalizeBase(raw: string): string {
  return normalizeStationBase(raw);
}

/** `headers` plus the Station login as `Authorization`, when there is one:
 *  the one source of that header for everything the app asks a station for
 *  (API requests, the stream, covers and avatars). Android's fetch (OkHttp)
 *  and image loaders never send a login from URL userinfo, and AVPlayer drops
 *  it, so the header is the only route that works everywhere (#764, #1873). */
export function loginHeaders(
  authorization: string | null,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  return authorization ? { ...headers, Authorization: authorization } : headers;
}

/** Icecast mount path, matching the Liquidsoap outputs and the Caddy routes. */
function mountFor(format: StreamFormat): string {
  return `/stream.${format}`;
}

// Compose timeouts manually: RN fetch lacks AbortSignal.timeout and any.
export const FETCH_TIMEOUT_MS = 8000;

/** What can still end a request past its headers, for readJson: fetch resolves
 *  on them, and fetchWithTimeout lets go of its timer and the caller's signal. */
const openRequests = new WeakMap<Response, { ctrl: AbortController; outer?: AbortSignal | null }>();

export function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const outer = init?.signal;
  const onAbort = () => ctrl.abort();
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', onAbort);
  }
  return fetch(url, { ...init, signal: ctrl.signal })
    .then((res) => {
      openRequests.set(res, { ctrl, outer });
      return res;
    })
    .finally(() => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    });
}

/** A fetchWithTimeout response's JSON body, with its own FETCH_TIMEOUT_MS from
 *  the start of the read, so a call takes at most twice that: headers, then body.
 *  A caller with one budget for both passes what is left of it as `timeoutMs`
 *  (readDirectory). The deadline or the caller's signal aborts the request, which
 *  is what closes the connection of a stalled body, and rejects here too, because
 *  the abort alone doesn't end the read: expo/fetch's native text() waits for a
 *  complete body. After a cancel iOS never has one (NativeResponse.swift ends in
 *  errorReceived), and Android calls whatever arrived complete
 *  (NativeResponse.kt), so the read never settles on one and resolves with a
 *  truncated body on the other. */
export async function readJson(res: Response, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const { ctrl, outer } = openRequests.get(res) ?? {};
  let stop = () => {};
  const stopped = new Promise<never>((_, reject) => {
    stop = () => {
      ctrl?.abort();
      reject(new Error('Request aborted'));
    };
  });
  const timer = setTimeout(stop, timeoutMs);
  if (outer?.aborted) stop();
  else outer?.addEventListener('abort', stop);
  try {
    return await Promise.race([res.json(), stopped]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', stop);
  }
}

/** A JSON body, or undefined when it is not JSON or has not arrived in time
 *  (readJson), for an answer that makes its own sense of a missing body:
 *  stationAuthResult and lyricsResultFor. */
function readJsonOrUndefined(res: Response): Promise<unknown> {
  return readJson(res).catch(() => undefined);
}

type StationRequestInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

export function createApi(
  rawBase: string,
  credentials?: StationCredentials | null,
  stationPassword: () => string | null = () => null,
): StationApi {
  const connection = resolveStationConnection(rawBase, credentials);
  // Persist credential-free bases (#1300). Requests go to the clean base with
  // the login as a header, as the stream does (#764): the two login checks
  // then send exactly what the player sends (#1873).
  const { base: cleanBase, requestBase, authorization } = connection;
  const authHeaders = loginHeaders(authorization);
  const api = (p: string) => `${cleanBase}/api${p}`;
  const send = (p: string, init: StationRequestInit = {}) =>
    fetchWithTimeout(api(p), { ...init, headers: loginHeaders(authorization, init.headers) });
  const getJson = async <T>(p: string, signal?: AbortSignal): Promise<T> => {
    const res = await send(p, { signal });
    if (!res.ok) throw new Error(`${res.status} ${api(p)}`);
    return (await readJson(res)) as T;
  };
  // Images keep the login in the URL as well, for the one loader that takes
  // no headers (see cover()). It is the same login as the header, so the two
  // never disagree.
  const asset = (p: string) => `${requestBase}/api${p}`;
  let stationAuthHold = 0;
  const onStation = (url: string) => url.startsWith(`${requestBase}/`) || url.startsWith(`${cleanBase}/`);
  const probeHealth = async (signal?: AbortSignal): Promise<HealthResult> => {
    try {
      const res = await send('/health', { cache: 'no-store', signal });
      if (res.ok) return { ok: true };
      const challenge = res.headers.get('www-authenticate') ?? undefined;
      return { ok: false, kind: 'http', status: res.status, challenge };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      const aborted = signal?.aborted || err?.name === 'AbortError';
      return { ok: false, kind: aborted ? 'timeout' : 'network', message: err?.message };
    }
  };
  return {
    base: cleanBase,
    nowPlaying: (signal) => getJson<NowPlayingResponse>('/now-playing', signal),
    state: (signal) => getJson<StationState>('/state', signal),
    session: (signal) => getJson<SessionPayload>('/session', signal),
    schedule: (signal) => getJson<SchedulePayload>('/schedule', signal),
    dj: (signal) => getJson<DjPublic>('/dj', signal),
    themes: (signal) => getJson<ThemesPayload>('/themes', signal),
    // useSignal relies on network/TLS/timeout errors throwing; HTTP failures return false.
    health: async (signal) => {
      const r = await probeHealth(signal);
      if (r.ok) return true;
      if (r.kind === 'http') return false;
      throw new Error(r.message || r.kind);
    },
    probeHealth,
    postRequest: (body) =>
      send('/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => readJson(r) as Promise<RequestResult>),
    postBeacon: async (body) => {
      try {
        await send('/beacon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        /* best-effort analytics */
      }
    },
    checkStationAuth: async (password) => {
      try {
        const res = await send('/station-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        stationAuthHold = res.status === 429 ? rateLimitedUntil(res.headers.get('Retry-After'), Date.now()) : 0;
        return stationAuthResult(res.status, {
          challenged: res.headers.has('www-authenticate'),
          // Only these bodies are read: they say who answered (stationAuthResult).
          body: res.status === 200 || res.status === 401 ? await readJsonOrUndefined(res) : undefined,
        });
      } catch {
        return stationAuthResult(null);
      }
    },
    stationAuthHeldUntil: () => stationAuthHold,
    pollRequest: async (id) => {
      const res = await send(`/request/${encodeURIComponent(id)}`);
      if (res.status === 404) return { success: false, status: 'unknown' };
      return (await readJson(res)) as RequestResult;
    },
    likeCurrent: async (songId) => {
      try {
        const res = await send('/like', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songId }),
        });
        return (await readJson(res)) as LikeResult;
      } catch {
        return null;
      }
    },
    likeStatus: async () => {
      try {
        const res = await send('/like');
        return (await readJson(res)) as LikeStatus;
      } catch {
        return null;
      }
    },
    currentLyrics: async (songId) => {
      try {
        const password = stationPassword();
        const res = await send(`/lyrics/current?songId=${encodeURIComponent(songId)}`, {
          cache: 'no-store',
          headers: password ? { 'x-station-auth': password } : undefined,
        });
        const body = res.ok ? await readJsonOrUndefined(res) : undefined;
        return lyricsResultFor(res.status, res.headers.get('Retry-After'), body);
      } catch {
        return { kind: 'unavailable', retryAfterSec: null };
      }
    },
    cover: (subsonicId) => asset(`/cover/${encodeURIComponent(subsonicId)}`),
    avatar: (path) => {
      if (!path) return '';
      if (/^https?:\/\//i.test(path)) return path;
      return asset(path.startsWith('/') ? path : `/${path}`);
    },
    imageHeaders: (url) => (onStation(url) ? authHeaders : undefined),
    streamUrl: (format = 'mp3') => withStreamAuth(`${cleanBase}${mountFor(format)}`, stationPassword()),
    streamHeaders: () => authHeaders,
  };
}
