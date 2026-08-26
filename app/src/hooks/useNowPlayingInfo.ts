// Native port of web/web/hooks/useMediaSession.ts (the metadata half).
//
// Pushes current-track metadata to the OS lock screen / CarPlay / Android Auto
// via TrackPlayer.updateNowPlayingMetadata. While the DJ is talking (a voice
// turn landed in the last 15s) we swap in the persona avatar + name, exactly
// like the web. Remote control HANDLERS live in service.ts (headless); this
// hook only owns the displayed metadata.
//
// The two rules it used to own inline — what counts as "talking", and which
// strings/artwork the strip shows — now live in lib/voice-turn.ts and
// lib/air-card.ts, because the Live Activity (useLiveActivity) has to reach the
// same answer on the Lock Screen and the watch, and a second copy would drift.

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

  // Keyed on the RESOLVED strings, not on the feed objects behind them:
  // useStationFeed hands back a new activeShow object on some polls even when
  // nothing in it changed, and re-pushing metadata on every poll makes the
  // lock-screen artwork flicker.
  const title = card?.title;
  const artist = card?.artist;
  const album = card?.album;
  const artwork = card?.artworkUrl;

  useEffect(() => {
    if (!api || !tunedIn || !title) return;
    TrackPlayer.updateNowPlayingMetadata({ title, artist, album, artwork }).catch(() => {
      /* no active track yet — ignored */
    });
  }, [api, tunedIn, title, artist, album, artwork]);
}
