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

export interface StationApi {
  base: string;
  nowPlaying(signal?: AbortSignal): Promise<NowPlayingResponse>;
  state(signal?: AbortSignal): Promise<StationState>;
  session(signal?: AbortSignal): Promise<SessionPayload>;
  schedule(signal?: AbortSignal): Promise<SchedulePayload>;
  dj(signal?: AbortSignal): Promise<DjPublic>;
  themes(signal?: AbortSignal): Promise<ThemesPayload>;
  health(signal?: AbortSignal): Promise<boolean>;
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

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

export function createApi(rawBase: string): StationApi {
  const base = normalizeBase(rawBase);
  const api = (p: string) => `${base}/api${p}`;
  return {
    base,
    nowPlaying: (signal) => getJson<NowPlayingResponse>(api('/now-playing'), signal),
    state: (signal) => getJson<StationState>(api('/state'), signal),
    session: (signal) => getJson<SessionPayload>(api('/session'), signal),
    schedule: (signal) => getJson<SchedulePayload>(api('/schedule'), signal),
    dj: (signal) => getJson<DjPublic>(api('/dj'), signal),
    themes: (signal) => getJson<ThemesPayload>(api('/themes'), signal),
    health: async (signal) => {
      const res = await fetch(api('/health'), { cache: 'no-store', signal });
      return res.ok;
    },
    postRequest: (body) =>
      fetch(api('/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<RequestResult>),
    pollRequest: async (id) => {
      const res = await fetch(api(`/request/${encodeURIComponent(id)}`));
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
