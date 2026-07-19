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

import { mountFor, type StreamFormat } from './streamFormat';
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

/** POST /beacon payload — audience-source analytics (see the web PlayerApp's
 *  one-shot beacon). An app has no document.referrer or UTM query; callers
 *  report the platform via `utmSource` instead so native listeners show up in
 *  the admin Stats rollup. */
export interface BeaconBody {
  referrer?: string;
  path?: string;
  utmSource?: string;
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
  /** Like the currently playing track (#991). `songId` is what the client
   *  believes is on air — the controller rejects a stale tap. Error statuses
   *  come back as a LikeResult with `error`; null on network error. */
  likeCurrent(songId: string): Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null on network error. */
  likeStatus(): Promise<LikeStatus | null>;
  /** Fire-and-forget audience beacon. Analytics must never break a listener —
   *  all failures are swallowed. */
  postBeacon(body: BeaconBody): Promise<void>;
  /** Absolute URL for an album cover (for <Image source>). */
  cover(subsonicId: string): string;
  /** Absolute URL for a persona avatar. `path` is the value from
   *  activeShow.persona.avatar (e.g. `/persona-avatar/<id>`) — the controller
   *  emits it WITHOUT the `/api` prefix; this client adds it like every other
   *  endpoint. */
  avatar(path: string): string;
  /** The live Icecast mount for `format`, defaulting to the universal MP3
   *  floor. Callers pass a non-MP3 format only after gating it on platform +
   *  station support (lib/streamFormat.ts) — this just builds the URL. Carries
   *  NO embedded credentials — see streamHeaders(). */
  streamUrl(format?: StreamFormat): string;
  /** Headers to attach to the audio stream request. When the station URL
   *  embedded HTTP basic-auth credentials (`https://user:pass@host`), this
   *  returns `{ Authorization: 'Basic …' }`; otherwise `undefined`. iOS AVPlayer
   *  (via react-native-track-player) ignores userinfo in the URL, so the
   *  credential MUST travel as a header or the stream 401s and never starts —
   *  unlike the fetch/Image paths, which honour userinfo, so they keep using the
   *  credentialed base (#764). */
  streamHeaders(): Record<string, string> | undefined;
}

/** Strip a trailing slash; default to https:// if the user typed a bare host. */
export function normalizeBase(raw: string): string {
  let s = (raw || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, '');
}

// Standard base64 over the UTF-8 bytes of a string. Self-contained rather than
// relying on global `btoa` (Hermes-version-dependent, and latin1-only) so a
// credential with non-ASCII characters still encodes the way a browser would.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      // surrogate pair → single code point
      const lo = input.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 63];
  }
  return out;
}

/** Split a normalized base into a credential-free base URL and, if the URL
 *  carried `user:pass@` userinfo, an `Authorization: Basic` header value.
 *  Percent-encoded userinfo is decoded per-component before encoding, matching
 *  how a browser forms the credential from a URL. */
export function splitCredentials(rawBase: string): {
  base: string;
  authorization: string | null;
} {
  const norm = normalizeBase(rawBase);
  const m = norm.match(/^(https?:\/\/)(?:([^/@]+)@)?(.+)$/i);
  if (!m || !m[2]) return { base: norm, authorization: null };
  const [, scheme, userinfo, rest] = m;
  const idx = userinfo.indexOf(':');
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const user = dec(idx >= 0 ? userinfo.slice(0, idx) : userinfo);
  const pass = idx >= 0 ? dec(userinfo.slice(idx + 1)) : '';
  return { base: `${scheme}${rest}`, authorization: `Basic ${base64(`${user}:${pass}`)}` };
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
  // `base` deliberately KEEPS any URL-embedded credentials: RN's fetch and
  // <Image> (both NSURLSession on iOS / OkHttp on Android) honour `user:pass@`
  // userinfo, so the API polls and cover/avatar artwork already work with a
  // basic-auth station. Only the audio path is broken — iOS AVPlayer drops
  // userinfo — so we produce a credential-free URL + Authorization header for
  // the stream alone (streamUrl/streamHeaders below), leaving every other
  // request untouched (#764).
  const base = normalizeBase(rawBase);
  const { base: cleanBase, authorization } = splitCredentials(rawBase);
  const streamAuthHeaders: Record<string, string> | undefined = authorization
    ? { Authorization: authorization }
    : undefined;
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
