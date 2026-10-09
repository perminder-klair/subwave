// Talking state and card contents come from lib/voice-turn and lib/air-card,
// shared with the Live Activity.

import { useEffect } from 'react';
import TrackPlayer from 'react-native-track-player';
import { useTalking } from '@/hooks/useTalking';
import { resolveAirCard } from '@/lib/air-card';
import type { StationApi } from '@/lib/api';
import type { ActiveShow, NowPlayingTrack, SessionTurn } from '@/lib/types';

export interface UseNowPlayingInfoParams {
  api: StationApi | null;
  tunedIn: boolean;
  nowPlaying: NowPlayingTrack | null;
  boothFeed?: SessionTurn[];
  activeShow?: ActiveShow | null;
}

export function useNowPlayingInfo({
  api,
  tunedIn,
  nowPlaying,
  boothFeed,
  activeShow,
}: UseNowPlayingInfoParams): void {
  const talking = useTalking(boothFeed);
  const card = api ? resolveAirCard({ api, nowPlaying, activeShow, talking }) : null;

  // Use resolved strings as dependencies to avoid flickering artwork on unchanged polls.
  const title = card?.title;
  const artist = card?.artist;
  const album = card?.album;
  const artwork = card?.artworkUrl;

  useEffect(() => {
    if (!api || !tunedIn || !title) return;
    TrackPlayer.updateNowPlayingMetadata({ title, artist, album, artwork }).catch(() => {
      /* no active track yet */
    });
  }, [api, tunedIn, title, artist, album, artwork]);
}
