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
import { useAppActive } from '@/hooks/useAppActive';
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
  /** Listener buffer behind the live edge (useStationFeed.leadMs). */
  leadMs: number;
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
  leadMs,
  trackStartedAt,
  station,
  accent,
  like,
}: UseLiveActivityParams): void {
  const supported = useMemo(() => isLiveActivitySupported(), []);

  const talking = useTalking(boothFeed, leadMs);
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

  // Two starts in flight at once can each clear the old card before either
  // requests a new one, which stacks two.
  const startingRef = useRef(false);
  // Bumped on every teardown, so a start that resolves after one can tell.
  const lifecycleRef = useRef(0);
  const tunedInRef = useRef(tunedIn);
  useEffect(() => {
    tunedInRef.current = tunedIn;
  }, [tunedIn]);

  // Accent is immutable in ActivityKit attributes; a theme change restarts the card.
  useEffect(() => {
    if (!supported || !api || !tunedIn) return;
    let cancelled = false;
    void (async () => {
      startingRef.current = true;
      const ok = await startLiveActivity({ station, accent }, stateRef.current);
      startingRef.current = false;
      if (!cancelled) startedRef.current = ok;
    })();
    return () => {
      cancelled = true;
      lifecycleRef.current += 1;
      startedRef.current = false;
      void stopLiveActivity();
    };
  }, [supported, api, tunedIn, station, accent]);

  // ActivityKit refuses a background app outside a LiveActivityIntent's run,
  // so a tune-in from Siri or a Shortcut can miss its card (src/intents/tune.ts
  // waits for it, up to a cap). Put it up the next time the app comes forward.
  // Keyed on the transition, so an in-app tune-in is left to the effect above.
  const active = useAppActive();
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const cameForward = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (!cameForward || !supported || !api || !tunedIn) return;
    if (startedRef.current || startingRef.current) return;
    const lifecycle = lifecycleRef.current;
    void (async () => {
      startingRef.current = true;
      const ok = await startLiveActivity({ station, accent }, stateRef.current);
      startingRef.current = false;
      if (lifecycleRef.current === lifecycle) {
        startedRef.current = ok;
      } else if (ok && !tunedInRef.current) {
        // Tuned out while this was in flight: the teardown's stop ran first.
        void stopLiveActivity();
      }
    })();
  }, [active, supported, api, tunedIn, station, accent]);

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
