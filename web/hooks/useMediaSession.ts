'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useStationOrigin } from '@/lib/stationOrigin';
import type { NowPlayingTrack, SessionTurn } from '@/lib/types';

// How long after the last spoken turn we keep showing the DJ avatar on the
// lock screen. Match this to typical voice-segment length plus a small tail —
// 15 s feels right for a station ID, a link, or a weather update; longer
// segments naturally extend it because each new turn resets the timer.
const TALKING_LINGER_MS = 15_000;

export interface UseMediaSessionParams {
  tunedIn: boolean;
  nowPlaying: NowPlayingTrack | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  onTune?: () => void;
  onSkip?: () => void;
  /** Booth-feed messages, most recent last. We look at the tail to decide
   *  whether the DJ is talking right now. Optional — when omitted, the
   *  hook never swaps in the persona avatar. */
  boothFeed?: SessionTurn[];
  /** Public avatar URL for the on-air persona (the `/api/persona-avatar/:id`
   *  endpoint). When the DJ is talking and this is set, we swap it into the
   *  MediaSession artwork; otherwise the track cover wins. */
  personaAvatarUrl?: string | null;
  /** Display name for the on-air host — shown as the metadata "artist" while
   *  the DJ is talking, so the lock screen reads "Late-night ramble · Marlowe"
   *  instead of pretending Track Artist is speaking. */
  personaName?: string | null;
}

// Turn kinds that map to "the DJ is on the mic". Tracks and request acks fire
// the same booth-feed channel but aren't actually voiced over the music bus,
// so they shouldn't trigger the avatar swap.
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
  // Walk from the tail back — voice turns near the end are the only ones that
  // matter for "is the DJ talking *now*".
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

// Wires the browser's Media Session API to the controller's now-playing feed.
// Effect: track + artist + album show on the OS lock screen, in the
// notification shade (Android), in Control Centre (iOS / macOS), and on
// Bluetooth headsets / car displays. Hardware play/pause/headphone buttons
// also route through these handlers.
//
// Tied to the same <audio> element that usePlayer owns, so:
//   • The system "playback state" reflects whether we're tuned in.
//   • Play / pause / stop actions go through usePlayer.tune() so all UI
//     state stays consistent (volume, waveform, transport bar label).
//
// "seekto" / "seekbackward" / "seekforward" are intentionally NOT wired —
// this is a live stream, you can't scrub. Leaving them unset removes the
// scrubber from the lock screen rather than showing a broken one.
//
// Skipping `nexttrack` would be wrong: a listener pressing "next" on their
// headphones expects to skip the *song they're hearing*, which on this
// station means asking the controller to advance. POST /skip does exactly
// that — but we gate it on the skipFn callback so consumers can opt out
// (e.g. an unauthenticated public listener page that shouldn't expose skip).
export function useMediaSession({
  tunedIn,
  nowPlaying,
  audioRef,
  onTune,
  onSkip,
  boothFeed,
  personaAvatarUrl,
  personaName,
}: UseMediaSessionParams): void {
  const { apiUrl } = useStationOrigin();
  // `talking` is a derived bit — true for TALKING_LINGER_MS after the most
  // recent voice turn lands in the booth feed. We hold it in state (rather
  // than recomputing on every render) so a setTimeout can flip it back off
  // without a feed update.
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
  // Reflect tune-in / out into the system playback state. The browser uses
  // this to render the play/pause glyph on the lock screen correctly even
  // if the <audio> readyState is still loading.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = tunedIn ? 'playing' : 'paused';
  }, [tunedIn]);

  // Push current track metadata. When the controller has a Subsonic id for
  // the current track, route artwork through /api/cover/:id so the lock
  // screen / CarPlay / Bluetooth display shows the actual album art. The
  // controller proxies the bytes from Subsonic so credentials never leak
  // into the page. Falls back to the app icon when no id is available
  // (jingles, station idents, scanning state).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (!('MediaMetadata' in window)) return;

    const subsonicId = nowPlaying?.subsonic_id;
    const coverArt: MediaImage | null = subsonicId
      ? {
          src: `${apiUrl}/cover/${encodeURIComponent(subsonicId)}`,
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

    // While the DJ is talking and we have an avatar, lead with the persona —
    // the lock screen, CarPlay etc. picks the first usable entry, so the
    // avatar wins. The cover stays in the fallback chain so the moment the
    // DJ stops talking and the linger expires, the next metadata push reverts
    // cleanly. Title/artist also retarget so the lock-screen text matches.
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
    nowPlaying?.title,
    nowPlaying?.artist,
    nowPlaying?.album,
    nowPlaying?.subsonic_id,
    talking,
    personaAvatarUrl,
    personaName,
    apiUrl,
  ]);

  // Action handlers. These are bound once per change to the dependencies so
  // they always close over the latest tune / skip callbacks.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const session = navigator.mediaSession;

    const handlePlay = () => {
      if (!tunedIn) onTune?.();
      else audioRef.current?.play().catch(() => {});
    };
    const handlePause = () => {
      if (tunedIn) onTune?.();
      else audioRef.current?.pause();
    };
    const handleStop = () => {
      if (tunedIn) onTune?.();
    };
    const handleNext = () => {
      onSkip?.();
    };

    try {
      session.setActionHandler('play', handlePlay);
      session.setActionHandler('pause', handlePause);
      session.setActionHandler('stop', handleStop);
      session.setActionHandler('nexttrack', onSkip ? handleNext : null);
      // Explicitly null out actions we don't support so the UI hides them
      // rather than showing greyed-out buttons.
      session.setActionHandler('previoustrack', null);
      session.setActionHandler('seekto', null);
      session.setActionHandler('seekbackward', null);
      session.setActionHandler('seekforward', null);
    } catch {
      // Older Safari throws on unsupported action types — swallow and carry
      // on; the supported subset is still registered.
    }

    return () => {
      try {
        session.setActionHandler('play', null);
        session.setActionHandler('pause', null);
        session.setActionHandler('stop', null);
        session.setActionHandler('nexttrack', null);
      } catch {}
    };
  }, [tunedIn, onTune, onSkip, audioRef]);
}
