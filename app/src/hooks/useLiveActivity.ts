// ActivityKit rate-limits updates. The card ticks its clock natively, so push
// only when displayed values change.

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
  const supported = useMemo(() => isLiveActivitySupported(), []);

  const talking = useTalking(boothFeed);
  const card = api ? resolveAirCard({ api, nowPlaying, activeShow, talking }) : null;

  // Native artwork fetch ignores URL userinfo; pass the Basic header.
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

  // Seed the ref before the lifecycle effect reads it on first mount.
  const stateRef = useRef(state);
  const startedRef = useRef(false);
  useEffect(() => {
    stateRef.current = state;
    if (!startedRef.current) return;
    void updateLiveActivity(state);
  }, [state]);

  // Accent is immutable in ActivityKit attributes; a theme change restarts the card.
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

  // The persistent listener must call the current track's like closure.
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
