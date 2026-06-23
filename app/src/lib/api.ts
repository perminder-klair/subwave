// Runtime API client.
//
// The web player bakes its base URL in at build time
// (process.env.NEXT_PUBLIC_API_URL). The native app is multi-station, so the
// base is resolved at RUNTIME from StationContext and threaded through here.
// This factory is the single place that knows the controller's URL shape; every
// hook/screen calls these typed methods instead of building URLs itself.
//
// Endpoints are all unauthenticated GETs plus one POST (/request). Base is the
// station's site root (e.g. https://radio.example.com); the controller API is
// mounted under `/api`, and the Icecast stream at `/stream.mp3` on the same
// origin (matches docker/Caddyfile routing).

import type {
  DjPublic,
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

/** Why a controller health probe failed. `network` is the catch-all for DNS,
 *  refused connections, and TLS/certificate errors — RN's fetch collapses all
 *  of these into a single rejected promise with no detail, so we can't tell
 *  them apart from JS. The common "works in the browser, fails in the app" case
 *  is a TLS chain the browser tolerates (it fetches missing intermediates via
 *  AIA) but Android's OkHttp does not, and it lands here. The app trusts
 *  user-installed CAs (plugins/withAndroidUserCaTrust.js), so a private-CA
 *  station works once its root is installed on the device, like the browser.
 *  `http` means we got a response but a non-2xx status (usually /api not routed
 *  to the controller). `timeout` is our own abort firing. */
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
  /** Like health(), but returns *why* it failed so callers can show a real
   *  diagnostic instead of a bare "failed". */
  probeHealth(signal?: AbortSignal): Promise<HealthResult>;
  postRequest(body: RequestBody): Promise<RequestResult>;
  pollRequest(id: string): Promise<RequestResult>;
  /** Absolute URL for an album cover (for <Image source>). */
  cover(subsonicId: string): string;
  /** Absolute URL for a persona avatar. `path` is the value from
   *  activeShow.persona.avatar (e.g. `/persona-avatar/<id>`) — the controller
   *  emits it WITHOUT the `/api` prefix; this client adds it like every other
   *  endpoint. */
  avatar(path: string): string;
  /** The live MP3 Icecast mount — the universal floor; Opus/Ogg is skipped on
   *  native for the same chained-Ogg reasons the web pins iOS to MP3. */
  streamUrl(): string;
}

/** Strip a trailing slash; default to https:// if the user typed a bare host. */
export function normalizeBase(raw: string): string {
  let s = (raw || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

// Every call carries a hard timeout: a hung origin must not stall the 5s
// feed poll (or leave a request spinner up forever) — fail fast, retry on
// the next tick. Composed by hand with any caller-supplied signal because
// RN's fetch polyfill doesn't ship AbortSignal.timeout/any.
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

export function createApi(rawBase: string): StationApi {
  const base = normalizeBase(rawBase);
  const api = (p: string) => `${base}/api${p}`;
  // Single source of the health logic; health() below is just its boolean.
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
    base,
    nowPlaying: (signal) => getJson<NowPlayingResponse>(api('/now-playing'), signal),
    state: (signal) => getJson<StationState>(api('/state'), signal),
    session: (signal) => getJson<SessionPayload>(api('/session'), signal),
    schedule: (signal) => getJson<SchedulePayload>(api('/schedule'), signal),
    dj: (signal) => getJson<DjPublic>(api('/dj'), signal),
    themes: (signal) => getJson<ThemesPayload>(api('/themes'), signal),
    // Preserves the original contract: a non-2xx response resolves to false, but
    // a network/TLS error or timeout *throws* — callers like useSignal rely on
    // the throw to detect a dead link. probeHealth (below) never throws; it's for
    // callers that want the reason instead of a boolean.
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
    pollRequest: async (id) => {
      const res = await fetchWithTimeout(api(`/request/${encodeURIComponent(id)}`));
      if (res.status === 404) return { success: false, status: 'unknown' };
      return (await res.json()) as RequestResult;
    },
    cover: (subsonicId) => api(`/cover/${encodeURIComponent(subsonicId)}`),
    avatar: (path) => {
      if (!path) return '';
      if (/^https?:\/\//i.test(path)) return path;
      return api(path.startsWith('/') ? path : `/${path}`);
    },
    streamUrl: () => `${base}/stream.mp3`,
  };
}
