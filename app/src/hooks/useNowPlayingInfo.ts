// Talking state and card contents come from lib/voice-turn and lib/air-card,
// shared with the Live Activity.

import { useEffect } from 'react';
import TrackPlayer from 'react-native-track-player';
import { useAppActive } from '@/hooks/useAppActive';
import { useTalking } from '@/hooks/useTalking';
import type { PlayerStatus } from '@/hooks/usePlayer';
import { resolveAirCard } from '@/lib/air-card';
import type { StationApi } from '@/lib/api';
import type { ActiveShow, NowPlayingTrack, SessionTurn } from '@/lib/types';
import { nowPlayingProgress } from '@/lib/track-progress';

export interface UseNowPlayingInfoParams {
  api: StationApi | null;
  tunedIn: boolean;
  status: PlayerStatus;
  nowPlaying: NowPlayingTrack | null;
  boothFeed?: SessionTurn[];
  /** Listener buffer behind the live edge (useStationFeed.leadMs). */
  leadMs: number;
  /** Listener-time start shared with the player and Live Activity. */
  trackStartedAt: number | null;
  activeShow?: ActiveShow | null;
}

export function useNowPlayingInfo({
  api,
  tunedIn,
  status,
  nowPlaying,
  boothFeed,
  leadMs,
  trackStartedAt,
  activeShow,
}: UseNowPlayingInfoParams): void {
  const talking = useTalking(boothFeed, leadMs);
  const appActive = useAppActive();
  const card = api ? resolveAirCard({ api, nowPlaying, activeShow, talking }) : null;

  // Use resolved strings as dependencies to avoid flickering artwork on unchanged polls.
  const title = card?.title;
  const artist = card?.artist;
  const album = card?.album;
  const artwork = card?.artworkUrl;
  const duration = nowPlaying?.duration;

  useEffect(() => {
    if (!api || !tunedIn || !title) return;
    const update = (includeCard: boolean) => {
      TrackPlayer.updateNowPlayingMetadata({
        ...(includeCard ? { title, artist, album, artwork: artwork ?? '' } : {}),
        // Retain iOS's LIVE presentation and the absence of seek controls.
        isLiveStream: true,
        ...nowPlayingProgress({ track: { duration }, trackStartedAt, talking }),
      }).catch(() => {
        /* no active track yet */
      });
    };
    update(true);
    // Native playback state extrapolates between updates. Re-anchor from the
    // absolute listener clock even while the foreground elapsed timer sleeps.
    const timer = setInterval(() => update(false), 30000);
    return () => clearInterval(timer);
  }, [api, tunedIn, status, title, artist, album, artwork, duration, trackStartedAt, talking, appActive]);
}
