'use client';

import { useEffect, useMemo, useState } from 'react';
import { useStationClient } from '@/lib/stationClient';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

// How long after the last spoken turn the DJ avatar stays on the lock screen:
// typical voice-segment length plus a tail. Longer segments extend it anyway
// because each new turn resets the timer.
const TALKING_LINGER_MS = 15_000;

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
  /** Public avatar URL for the on-air persona. Swapped into the MediaSession
   *  artwork while the DJ is talking; otherwise the track cover wins. */
  personaAvatarUrl?: string | null;
  /** On-air host name, shown as the metadata "artist" while the DJ is talking so
   *  the lock screen doesn't pretend Track Artist is speaking. */
  personaName?: string | null;
}

// Turn kinds that map to "the DJ is on the mic". Tracks and request acks share
// the booth-feed channel but aren't voiced over the music bus, so they must not
// trigger the avatar swap.
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
  // Only voice turns near the tail matter for "is the DJ talking now".
  for (let i = feed.length - 1; i >= 0; i--) {
    const turn = feed[i];
    if (!isVoiceTurn(turn)) continue;
    const t = typeof turn?.t === 'number'
      ? turn.t
      : typeof turn?.t === 'string'
        ? Date.parse(turn.t)
        : NaN;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

// Wires the Media Session API to the now-playing feed: track/artist/album on the
// OS lock screen, Android shade, Control Centre, Bluetooth and car displays,
// with hardware play/pause/headphone buttons routed through these handlers.
// Tied to the <audio> element usePlayer owns, and play/pause/stop go through
// explicit usePlayer commands so repeated OS commands remain idempotent.
//
// "seekto"/"seekbackward"/"seekforward" are deliberately NOT wired — a live
// stream can't be scrubbed, and leaving them unset removes the lock-screen
// scrubber rather than showing a broken one. `nexttrack` IS wired (headphone
// "next" means skip the song you're hearing) but gated on the skip callback so
// consumers like a public listener page can opt out.
export function useMediaSession({
  playbackState,
  nowPlaying,
  onPlay,
  onPause,
  onStop,
  onSkip,
  boothFeed,
  personaAvatarUrl,
  personaName,
}: UseMediaSessionParams): void {
  const client = useStationClient();
  // True for TALKING_LINGER_MS after the most recent voice turn. Held in state
  // rather than derived so a setTimeout can flip it off with no feed update.
  const [talking, setTalking] = useState(false);
  const lastVoiceTs = useMemo(() => lastVoiceTurnTime(boothFeed), [boothFeed]);

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
    const id = window.setTimeout(() => setTalking(false), remaining);
    return () => window.clearTimeout(id);
  }, [lastVoiceTs]);
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
