'use client';

// Build controller URLs from StationOrigin. Preserve endpoint-specific error handling: feed JSON,
// throwing schedule/themes reads, unknown request 404s, and best-effort beacons.

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
import { getStationAuthToken } from '@/lib/stationAuth';
import { publicLyricsPayloadSchema, type PublicLyricsPayload } from '@/lib/schemas.generated';

export interface ThemesPayload {
  /** The effective theme — what a client should actually paint. */
  active: string;
  /** Which level decided `active`. Absent on an older controller. */
  activeSource?: 'show' | 'station';
  /** settings.theme.active, i.e. what admin's station picker sets. */
  stationDefault?: string;
  /** Set only when an on-air show's themeId outranked the station default. */
  activeShow?: { id: string; name: string; themeId: string } | null;
  themes: Theme[];
}

export interface BeaconPayload {
  referrer: string;
  path: string;
  utmSource?: string;
}

/** Error statuses (403 disabled, 409 stale/no track, 429 throttled) still
 *  carry a JSON body with `error`. */
export interface LikeResult {
  ok?: boolean;
  songId?: string | null;
  liked?: boolean;
  alreadyLiked?: boolean;
  count?: number;
  error?: string;
}

/** Liked-state for the current airing, per listener via a server-side dedup
 *  key — no account needed. */
export interface LikeStatus {
  enabled: boolean;
  songId?: string | null;
  liked?: boolean;
  count?: number;
}

/** How `GET /lyrics/current` answered. `unavailable` is the only kind worth
 *  asking again: the music server (or the network) did not answer. */
export type LyricsResult =
  | { kind: 'ok'; payload: PublicLyricsPayload }
  /** The operator has the Lyrics panel switched off. */
  | { kind: 'disabled' }
  /** The track has left the station's recent-play window. */
  | { kind: 'gone' }
  /** A private station refused the stored password (or there is none). Not
   *  retried: every refusal spends the address's station-read attempts. */
  | { kind: 'locked' }
  | { kind: 'unavailable'; retryAfterSec: number | null };

export interface StationClient {
  origin: StationOrigin;
  /** Prefix a controller-relative path with the station's API base.
   *  Empty/nullish input stays '' so `<img>` fallbacks keep working. */
  resolve(path: string | null | undefined): string;
  coverUrl(subsonicId: string): string;
  nowPlaying(init?: { signal?: AbortSignal }): Promise<NowPlayingResponse>;
  state(init?: { signal?: AbortSignal }): Promise<StationState>;
  session(init?: { signal?: AbortSignal }): Promise<SessionPayload>;
  /** The caller owns timeout/abort. */
  health(init?: { signal?: AbortSignal }): Promise<Response>;
  schedule(): Promise<SchedulePayload>;
  themes(): Promise<ThemesPayload>;
  submitRequest(text: string, name: string): Promise<RequestResult>;
  /** 404 → status 'unknown'; network error → null so drawers keep polling. */
  requestStatus(requestId: string): Promise<RequestResult | null>;
  /** `songId` is what the client believes is on air; the controller rejects a
   *  stale tap. null on network error. */
  likeCurrent(songId: string): Promise<LikeResult | null>;
  /** null on network error. */
  likeStatus(): Promise<LikeStatus | null>;
  /** Lyrics for the track this listener is hearing (now-playing's
   *  `subsonic_id`). Never throws. */
  currentLyrics(songId: string): Promise<LyricsResult>;
  /** One-shot audience beacon. Best-effort: never throws, never blocks. */
  beacon(payload: BeaconPayload): void;
  /** null on any failure; callers treat that as "configured" and stay put. */
  onboardingStatus(): Promise<{ needsSetup?: boolean } | null>;
}

export function createStationClient(origin: StationOrigin): StationClient {
  const api = origin.apiUrl;
  const json = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
  return {
    origin,
    resolve: path => (path ? `${api}${path}` : ''),
    coverUrl: subsonicId => `${api}/cover/${encodeURIComponent(subsonicId)}`,
    nowPlaying: init => fetch(`${api}/now-playing`, { signal: init?.signal }).then(r => json<NowPlayingResponse>(r)),
    state: init => fetch(`${api}/state`, { signal: init?.signal }).then(r => json<StationState>(r)),
    session: init => fetch(`${api}/session`, { signal: init?.signal }).then(r => json<SessionPayload>(r)),
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
        // Error statuses carry a JSON body too. Surface it, don't throw.
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
    currentLyrics: async (songId) => {
      try {
        // A private station gates this read on the station password, which the
        // gate stored when the listener unlocked the player.
        const token = getStationAuthToken();
        const r = await fetch(`${api}/lyrics/current?songId=${encodeURIComponent(songId)}`, {
          cache: 'no-store',
          headers: token ? { 'x-station-auth': token } : undefined,
        });
        if (r.status === 403) return { kind: 'disabled' };
        if (r.status === 409) return { kind: 'gone' };
        if (r.status === 401) return { kind: 'locked' };
        if (!r.ok) {
          const retryAfter = Number(r.headers.get('Retry-After'));
          return { kind: 'unavailable', retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
        }
        const parsed = publicLyricsPayloadSchema.safeParse(await r.json());
        return parsed.success ? { kind: 'ok', payload: parsed.data } : { kind: 'unavailable', retryAfterSec: null };
      } catch {
        return { kind: 'unavailable', retryAfterSec: null };
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

/** The install this page is served from: same-origin `/api`, or the
 *  NEXT_PUBLIC_* dev overrides. Install-level concerns (theme registry,
 *  onboarding status) go through this even inside a showcase pointed at a
 *  remote station — they're about *this* deployment, not the tuned one. */
export const defaultStationClient: StationClient =
  createStationClient(DEFAULT_STATION_ORIGIN);

/** Whatever station the surrounding StationOriginProvider points at, or the
 *  default origin when there's no provider. Memoized on the origin's URL
 *  strings, which stay stable even when the origin object identity doesn't. */
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
