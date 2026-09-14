// Pushes track metadata to the OS lock screen / CarPlay via
// TrackPlayer.updateNowPlayingMetadata; while the DJ is talking the persona
// avatar and name are swapped in. Remote-control handlers live in service.ts.
//
// What counts as "talking" and what the strip shows live in lib/voice-turn.ts
// and lib/air-card.ts, shared with the Live Activity so the two can't drift.

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

  // Keyed on the resolved strings, not the feed objects: a new activeShow
  // object on an unchanged poll would re-push and flicker the artwork.
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
