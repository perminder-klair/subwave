'use client';

// The one place player code talks to a controller. Every fetch and every
// controller-relative URL (covers, persona avatars) is built here from a
// StationOrigin, so pointing the player at another station is a matter of
// swapping the origin (see stationOrigin.ts) — no call site hardcodes a path.
//
// Response handling mirrors what each call site did before extraction:
// feed endpoints parse JSON without an ok-check, /schedule and /themes throw
// on non-OK, /request/:id maps a 404 to status 'unknown', and the beacon is
// fire-and-forget. Keep it that way — this module is plumbing, not policy.

import { useMemo } from 'react';
import {
  DEFAULT_STATION_ORIGIN,
  useStationOrigin,
  type StationOrigin,
} from '@/lib/stationOrigin';
import type { Theme } from '@/lib/theme';
import type {
  NowPlayingResponse,
  RequestResult,
  SchedulePayload,
  SessionPayload,
  StationState,
} from '@/lib/types';

/** `/themes` response — the registry plus the station's active id. */
export interface ThemesPayload {
  active: string;
  themes: Theme[];
}

export interface BeaconPayload {
  referrer: string;
  path: string;
  utmSource?: string;
}

/** `POST /like` outcome. Error statuses (403 disabled, 409 stale/no track,
 *  429 throttled) still carry a JSON body with `error`. */
export interface LikeResult {
  ok?: boolean;
  songId?: string | null;
  liked?: boolean;
  alreadyLiked?: boolean;
  count?: number;
  error?: string;
}

/** `GET /like` — liked-state for the current airing, from this listener's
 *  point of view (server-side dedup key, no account needed). */
export interface LikeStatus {
  enabled: boolean;
  songId?: string | null;
  liked?: boolean;
  count?: number;
}

export interface StationClient {
  origin: StationOrigin;
  /** Prefix a controller-relative path (e.g. `/persona-avatar/p_x`) with the
   *  station's API base. Empty/nullish input stays '' so `<img>` fallbacks
   *  keep working. */
  resolve(path: string | null | undefined): string;
  /** Artwork proxy URL for a library track. */
  coverUrl(subsonicId: string): string;
  nowPlaying(): Promise<NowPlayingResponse>;
  state(): Promise<StationState>;
  session(): Promise<SessionPayload>;
  /** Cheap liveness GET for the signal meter. The caller owns timeout/abort. */
  health(init?: { signal?: AbortSignal }): Promise<Response>;
  schedule(): Promise<SchedulePayload>;
  themes(): Promise<ThemesPayload>;
  submitRequest(text: string, name: string): Promise<RequestResult>;
  /** `/request/:id` outcome. 404 → status 'unknown'; network error → null so
   *  drawers keep polling. */
  requestStatus(requestId: string): Promise<RequestResult | null>;
  /** Like the currently playing track. `songId` is what the client believes
   *  is on air — the controller rejects a stale tap. null on network error. */
  likeCurrent(songId: string): Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null on network error. */
  likeStatus(): Promise<LikeStatus | null>;
  /** One-shot audience beacon. Best-effort: never throws, never blocks. */
  beacon(payload: BeaconPayload): void;
  /** First-run wizard state. null on any failure — callers treat that as
   *  "configured" and stay put. */
  onboardingStatus(): Promise<{ needsSetup?: boolean } | null>;
}

export function createStationClient(origin: StationOrigin): StationClient {
  const api = origin.apiUrl;
  const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
  return {
    origin,
    resolve: path => (path ? `${api}${path}` : ''),
    coverUrl: subsonicId => `${api}/cover/${encodeURIComponent(subsonicId)}`,
    nowPlaying: () => fetch(`${api}/now-playing`).then(r => json<NowPlayingResponse>(r)),
    state: () => fetch(`${api}/state`).then(r => json<StationState>(r)),
    session: () => fetch(`${api}/session`).then(r => json<SessionPayload>(r)),
    health: init => fetch(`${api}/health`, { cache: 'no-store', signal: init?.signal }),
    schedule: async () => {
      const r = await fetch(`${api}/schedule`);
      if (!r.ok) throw new Error(`schedule fetch ${r.status}`);
      return json<SchedulePayload>(r);
    },
    themes: async () => {
      const r = await fetch(`${api}/themes`);
      if (!r.ok) throw new Error(`themes fetch ${r.status}`);
      return json<ThemesPayload>(r);
    },
    submitRequest: async (text, name) => {
      const r = await fetch(`${api}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, name }),
      });
      return json<RequestResult>(r);
    },
    requestStatus: async requestId => {
      try {
        const r = await fetch(`${api}/request/${requestId}`);
        if (r.status === 404) return { success: false, status: 'unknown' };
        return await json<RequestResult>(r);
      } catch {
        return null;
      }
    },
    likeCurrent: async songId => {
      try {
        const r = await fetch(`${api}/like`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songId }),
        });
        // Error statuses carry a JSON body too — surface it, don't throw.
        return await json<LikeResult>(r);
      } catch {
        return null;
      }
    },
    likeStatus: async () => {
      try {
        const r = await fetch(`${api}/like`);
        return await json<LikeStatus>(r);
      } catch {
        return null;
      }
    },
    beacon: payload => {
      fetch(`${api}/beacon`, {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    },
    onboardingStatus: async () => {
      try {
        const r = await fetch(`${api}/onboarding/status`);
        return r.ok ? ((await r.json()) as { needsSetup?: boolean }) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Client for the install this page is served from — same-origin `/api` (or
 *  the NEXT_PUBLIC_* dev overrides). Install-level concerns (theme registry,
 *  onboarding status) go through this even inside a showcase pointed at a
 *  remote station: they're about *this* deployment, not the tuned station. */
export const defaultStationClient: StationClient =
  createStationClient(DEFAULT_STATION_ORIGIN);

/** Client for whatever station the surrounding StationOriginProvider points
 *  at — the default origin when there's no provider, a directory station
 *  inside the landing showcase. Memoized on the origin's URL strings, which
 *  stay stable across renders even when the origin object identity doesn't. */
export function useStationClient(): StationClient {
  const {
    apiUrl,
    streams: { mp3, opus },
  } = useStationOrigin();
  return useMemo(
    () => createStationClient({ apiUrl, streams: { mp3, opus } }),
    [apiUrl, mp3, opus],
  );
}
