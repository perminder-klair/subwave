// Native port of web/web/hooks/useMediaSession.ts (the metadata half).
//
// Pushes current-track metadata to the OS lock screen / CarPlay / Android Auto
// via TrackPlayer.updateNowPlayingMetadata. Artwork is the /cover/:id proxy.
// While the DJ is talking (a voice turn landed in the last 15s) we swap in the
// persona avatar + name, exactly like the web. Remote control HANDLERS live in
// service.ts (headless); this hook only owns the displayed metadata.

import { useEffect, useMemo, useState } from 'react';
import TrackPlayer from 'react-native-track-player';
import type { StationApi } from '@/lib/api';
import type { ActiveShow, NowPlayingTrack, SessionTurn } from '@/lib/types';

const TALKING_LINGER_MS = 15_000;

const VOICE_TURN_KINDS = new Set([
  'voice',
  'segment',
  'link',
  'intro',
  'station-id',
  'weather',
  'hourly',
  'say',
]);

function isVoiceTurn(turn: SessionTurn | undefined): boolean {
  if (!turn) return false;
  const kind = (turn.kind || '').toLowerCase();
  if (VOICE_TURN_KINDS.has(kind)) return true;
  const role = (turn.role || '').toLowerCase();
  return role === 'voice' || role === 'segment';
}

function lastVoiceTurnTime(feed: SessionTurn[] | undefined): number | null {
  if (!feed?.length) return null;
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    if (!isVoiceTurn(turn)) continue;
    const t =
      typeof turn?.t === 'number'
        ? turn.t
        : typeof turn?.t === 'string'
          ? Date.parse(turn.t)
          : NaN;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

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
  const [talking, setTalking] = useState(false);
  const lastVoiceTs = useMemo(() => lastVoiceTurnTime(boothFeed), [boothFeed]);

  const personaName = activeShow?.persona?.name ?? null;
  const personaAvatar = activeShow?.persona?.avatar ?? null;

  useEffect(() => {
    if (lastVoiceTs == null) {
      setTalking(false);
      return;
    }
    const remaining = TALKING_LINGER_MS - (Date.now() - lastVoiceTs);
    if (remaining <= 0) {
      setTalking(false);
      return;
    }
    setTalking(true);
    const id = setTimeout(() => setTalking(false), remaining);
    return () => clearTimeout(id);
  }, [lastVoiceTs]);

  useEffect(() => {
    if (!api || !tunedIn) return;
    const coverUrl = nowPlaying?.subsonic_id ? api.cover(nowPlaying.subsonic_id) : undefined;
    const avatarUrl = personaAvatar ? api.avatar(personaAvatar) : undefined;
    const useAvatar = talking && !!avatarUrl;

    const title = nowPlaying?.title || 'SUB/WAVE';
    const artist = useAvatar
      ? personaName || nowPlaying?.artist || 'Live broadcast'
      : nowPlaying?.artist || 'Live broadcast';
    const album = nowPlaying?.album || 'SUB/WAVE';
    const artwork = useAvatar ? avatarUrl : coverUrl;

    TrackPlayer.updateNowPlayingMetadata({
      title,
      artist,
      album,
      artwork,
    }).catch(() => {
      /* no active track yet — ignored */
    });
  }, [
    api,
    tunedIn,
    nowPlaying?.title,
    nowPlaying?.artist,
    nowPlaying?.album,
    nowPlaying?.subsonic_id,
    talking,
    personaAvatar,
    personaName,
  ]);
}
