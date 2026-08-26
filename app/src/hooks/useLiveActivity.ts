// The on-air Live Activity — SUB/WAVE on the Lock Screen, in the Dynamic
// Island, and on the Apple Watch Smart Stack (iOS 18+ mirrors the same card
// there, which is the whole reason this exists: React Native does not run on
// watchOS, so a real watch app is a second Swift codebase and this is the wrist
// surface that costs one widget target).
//
// It shows exactly what the lock screen shows — both go through
// lib/air-card.ts — plus the two things the OS Now Playing card cannot: the
// show/station identity, and a heart.
//
// Cheap by construction. The card's clock ticks natively from `startedAt`, so
// this pushes an update when the DISPLAYED VALUES change (a track, a link
// starting, a like landing) and never on a timer. ActivityKit rate-limits
// updates; a per-second push would be throttled away mid-song.

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
  /** LOCAL playback only. While casting there is no audio session on this
   *  device, so an "on air, on your phone" card would be a lie — same reason
   *  useNowPlayingInfo keys on the local player. */
  tunedIn: boolean;
  nowPlaying: NowPlayingTrack | null;
  activeShow?: ActiveShow | null;
  boothFeed?: SessionTurn[];
  /** Epoch ms when the track became audible to THIS listener — already carries
   *  the stream.bufferSeconds offset (useStationFeed owns that shift). Null
   *  before the first track lands. */
  trackStartedAt: number | null;
  /** Station display name for the eyebrow. */
  station: string;
  /** Station theme accent, `#rrggbb`. */
  accent: string;
  /** The heart's live state. A tap on the card is routed straight back into
   *  this same hook, so a wrist like and an in-app like are the same call. */
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
  // iOS 17+, the widget target present, and the listener has not switched Live
  // Activities off for us. None of that changes while the app is running, so it
  // is read once — and on Android it is simply always false.
  const supported = useMemo(() => isLiveActivitySupported(), []);

  const talking = useTalking(boothFeed);
  const card = api ? resolveAirCard({ api, nowPlaying, activeShow, talking }) : null;

  // A credentialed station's cover needs the same Basic header the audio stream
  // carries — URL userinfo is not honoured by the native fetch that downloads
  // it (#764 is the AVPlayer half of the same lesson).
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

  // Declared BEFORE the lifecycle effect on purpose: effects run in order, so
  // this seeds the ref that `start` reads on the very first mount.
  const stateRef = useRef(state);
  const startedRef = useRef(false);
  useEffect(() => {
    stateRef.current = state;
    if (!startedRef.current) return;
    void updateLiveActivity(state);
  }, [state]);

  // Lifecycle. The cleanup covers every way the card should come down — tuning
  // out, switching station (a new `api`), a theme change (the accent is baked
  // into the activity's immutable attributes, so it restarts rather than
  // updates), and unmount.
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

  // The heart, tapped from the card. Held in a ref so the listener registered
  // once always calls the CURRENT like closure — `like.like` is rebuilt on
  // every track change, and a stale one would silently like the previous song
  // (the controller would reject it as a stale tap, which reads as "the button
  // does nothing").
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
