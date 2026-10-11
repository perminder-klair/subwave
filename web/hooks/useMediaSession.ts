'use client';

import { useEffect, useState } from 'react';
import { talkingState } from '@/lib/sessionFeed';
import { useStationClient } from '@/lib/stationClient';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

export interface UseMediaSessionParams {
  playbackState: MediaSessionPlaybackState;
  nowPlaying: NowPlayingTrack | null;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSkip?: () => void;
  /** Booth-feed messages, most recent last; the tail decides whether the DJ is
   *  talking now. Omitting it means the persona avatar is never swapped in. */
  boothFeed?: SessionTurn[];
  /** This listener's buffer behind the live edge (useStationFeed.leadMs): the
   *  talking window opens when the line is HEARD, not when it was stamped. */
  leadMs?: number;
  /** Public avatar URL for the on-air persona. Swapped into the MediaSession
   *  artwork while the DJ is talking; otherwise the track cover wins. */
  personaAvatarUrl?: string | null;
  /** On-air host name, shown as the metadata "artist" while the DJ is talking so
   *  the lock screen doesn't pretend Track Artist is speaking. */
  personaName?: string | null;
}

// OS controls use explicit player commands so repeated commands are idempotent. Leave seeking unset
// for live streams. Enable nexttrack only when a skip callback is supplied.
export function useMediaSession({
  playbackState,
  nowPlaying,
  onPlay,
  onPause,
  onStop,
  onSkip,
  boothFeed,
  leadMs = 0,
  personaAvatarUrl,
  personaName,
}: UseMediaSessionParams): void {
  const client = useStationClient();
  // True while one of the DJ's lines is being heard (talkingState). Held in
  // state and re-evaluated on its own timer, so the window opens and closes on
  // time with no feed update.
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    let timer: number | null = null;
    const apply = () => {
      const now = Date.now();
      const { talking: next, nextChangeMs } = talkingState(boothFeed, leadMs, now);
      setTalking(next);
      timer = nextChangeMs == null ? null : window.setTimeout(apply, Math.max(0, nextChangeMs - now));
    };
    apply();
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [boothFeed, leadMs]);
  // The browser renders the lock-screen play/pause glyph from this, so it stays
  // correct even while the <audio> readyState is still loading.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playbackState;
  }, [playbackState]);

  // Artwork routes through /api/cover/:id so the controller proxies the Subsonic
  // bytes and credentials never leak into the page. Falls back to the app icon
  // when there's no id (jingles, station idents, scanning state).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (playbackState === 'none') {
      navigator.mediaSession.metadata = null;
      return;
    }
    if (!('MediaMetadata' in window)) return;

    const subsonicId = nowPlaying?.subsonic_id;
    const coverArt: MediaImage | null = subsonicId
      ? {
          src: client.coverUrl(subsonicId),
          sizes: '512x512',
          type: 'image/jpeg',
        }
      : null;
    const personaArt: MediaImage | null = personaAvatarUrl
      ? {
          src: personaAvatarUrl,
          sizes: '512x512',
          type: 'image/png',
        }
      : null;
    const appIcon: MediaImage = { src: '/icons/192', sizes: '192x192', type: 'image/png' };
    const appIconLg: MediaImage = { src: '/icons/512', sizes: '512x512', type: 'image/png' };

    // Lock screen / CarPlay picks the first usable artwork entry, so leading
    // with the persona wins while the DJ talks. The cover stays in the chain so
    // the next push after the linger expires reverts on its own.
    const useAvatar = talking && !!personaArt;
    const title = useAvatar
      ? (nowPlaying?.title || 'SUB/WAVE')
      : (nowPlaying?.title || 'SUB/WAVE');
    const artist = useAvatar
      ? (personaName || nowPlaying?.artist || 'Live broadcast')
      : (nowPlaying?.artist || 'Live broadcast');
    const album = nowPlaying?.album || 'SUB/WAVE';

    let artwork: MediaImage[];
    if (useAvatar && personaArt) {
      artwork = [personaArt, ...(coverArt ? [coverArt] : []), appIcon];
    } else if (coverArt) {
      artwork = [coverArt, appIcon];
    } else {
      artwork = [appIcon, appIconLg];
    }

    navigator.mediaSession.metadata = new window.MediaMetadata({
      title,
      artist,
      album,
      artwork,
    });
  }, [
    playbackState,
    nowPlaying?.title,
    nowPlaying?.artist,
    nowPlaying?.album,
    nowPlaying?.subsonic_id,
    talking,
    personaAvatarUrl,
    personaName,
    client,
  ]);

  // The core supplies stable callbacks that read the current transport intent.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const session = navigator.mediaSession;

    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>> = {
      play: onPlay,
      pause: onPause,
      stop: onStop,
      nexttrack: onSkip ?? null,
      previoustrack: null,
      seekto: null,
      seekbackward: null,
      seekforward: null,
    };
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { session.setActionHandler(action, handler); } catch {
        // Unsupported actions must not prevent registration of later ones.
      }
    };
    for (const [action, handler] of Object.entries(handlers)) {
      setHandler(action as MediaSessionAction, handler);
    }

    return () => {
      for (const action of Object.keys(handlers)) setHandler(action as MediaSessionAction, null);
    };
  }, [onPlay, onPause, onStop, onSkip]);

  useEffect(() => () => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = 'none';
    navigator.mediaSession.metadata = null;
  }, []);
}
