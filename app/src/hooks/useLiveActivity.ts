// Drives the on-air Live Activity (Lock Screen, Dynamic Island, watch Smart
// Stack). It shows what the lock screen shows, via lib/air-card.ts, plus the
// show/station identity and a heart.
//
// The card's clock ticks natively from `startedAt`, so this pushes an update
// only when a displayed value changes, never on a timer: ActivityKit
// rate-limits updates and a per-second push would be throttled away mid-song.

import { useEffect, useMemo, useRef } from 'react';
import {
  addLikePressedListener,
  isLiveActivitySupported,
  startLiveActivity,
  stopLiveActivity,
  updateLiveActivity,
  type LiveActivityState,
} from '../../modules/live-activity';
import { useTalking } from '@/hooks/useTalking';
import type { TrackLike } from '@/hooks/useTrackLike';
import { resolveAirCard } from '@/lib/air-card';
import type { StationApi } from '@/lib/api';
import type { ActiveShow, NowPlayingTrack, SessionTurn } from '@/lib/types';

export interface UseLiveActivityParams {
  api: StationApi | null;
  /** LOCAL playback only: while casting there is no audio session on this
   *  device, so the card would be a lie. */
  tunedIn: boolean;
  nowPlaying: NowPlayingTrack | null;
  activeShow?: ActiveShow | null;
  boothFeed?: SessionTurn[];
  /** Epoch ms when the track became audible to this listener; the
   *  stream.bufferSeconds offset is already applied by useStationFeed. */
  trackStartedAt: number | null;
  /** Station display name for the eyebrow. */
  station: string;
  /** Station theme accent, `#rrggbb`. */
  accent: string;
  /** The heart's live state; a card tap routes back into this same hook. */
  like: TrackLike;
}

export function useLiveActivity({
  api,
  tunedIn,
  nowPlaying,
  activeShow,
  boothFeed,
  trackStartedAt,
  station,
  accent,
  like,
}: UseLiveActivityParams): void {
  // None of what this gates on changes while the app runs, so read it once.
  const supported = useMemo(() => isLiveActivitySupported(), []);

  const talking = useTalking(boothFeed);
  const card = api ? resolveAirCard({ api, nowPlaying, activeShow, talking }) : null;

  // The native fetch that downloads the cover ignores URL userinfo, so a
  // credentialed station needs the same Basic header the stream carries.
  const artworkHeaders = useMemo(() => api?.streamHeaders() ?? {}, [api]);

  const state: LiveActivityState = useMemo(
    () => ({
      title: card?.title ?? 'SUB/WAVE',
      artist: card?.artist ?? 'Live broadcast',
      show: card?.show ?? null,
      artworkKey: card?.artworkKey ?? null,
      artworkUrl: card?.artworkUrl ?? null,
      artworkHeaders,
      startedAt: trackStartedAt,
      duration: nowPlaying?.duration ?? null,
      talking,
      likeCount: like.count,
      liked: like.liked,
      likeable: like.available,
    }),
    [
      card?.title,
      card?.artist,
      card?.show,
      card?.artworkKey,
      card?.artworkUrl,
      artworkHeaders,
      trackStartedAt,
      nowPlaying?.duration,
      talking,
      like.count,
      like.liked,
      like.available,
    ],
  );

  // Must stay before the lifecycle effect: effects run in order, and this
  // seeds the ref `start` reads on first mount.
  const stateRef = useRef(state);
  const startedRef = useRef(false);
  useEffect(() => {
    stateRef.current = state;
    if (!startedRef.current) return;
    void updateLiveActivity(state);
  }, [state]);

  // The accent is baked into the activity's immutable attributes, so a theme
  // change restarts the card rather than updating it.
  useEffect(() => {
    if (!supported || !api || !tunedIn) return;
    let cancelled = false;
    void (async () => {
      const ok = await startLiveActivity({ station, accent }, stateRef.current);
      if (!cancelled) startedRef.current = ok;
    })();
    return () => {
      cancelled = true;
      startedRef.current = false;
      void stopLiveActivity();
    };
  }, [supported, api, tunedIn, station, accent]);

  // Held in a ref so the once-registered listener always calls the current
  // like closure: `like.like` is rebuilt every track change, and a stale one
  // would like the previous song and be rejected as a stale tap.
  const likeRef = useRef(like);
  useEffect(() => {
    likeRef.current = like;
  }, [like]);

  useEffect(() => {
    if (!supported) return;
    const sub = addLikePressedListener(() => {
      void likeRef.current.like();
    });
    return () => sub?.remove();
  }, [supported]);
}
