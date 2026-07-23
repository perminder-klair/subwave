'use client';

// The headless player core — the per-station singletons every skin shares,
// split into three contexts by update cadence so a component subscribes only
// to the churn it actually renders:
//
//   • feed    — the /now-playing + /state + /session snapshot, 5s cadence.
//   • audio   — tune state, volume, signal meter; changes on user gestures
//               and (while tuned in) each 5s signal probe. A volume drag
//               re-renders audio consumers only, never the feed tree.
//   • actions — permanently-stable callbacks (bridged through refs, since
//               usePlayer recreates its closures per render); subscribing
//               to this context never causes a re-render.
//
// The provider also runs the shared side-effect service every skin gets for
// free: the OS media session (lock screen / headphones / car controls),
// including the persona-avatar swap while the DJ is talking. The <audio>
// element itself is rendered by the shell — skins need the ref in the tree
// for the Waveform's Web Audio tap.

import {
  createContext,
  useContext,
  useMemo,
  useRef,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import { useStationFeed, type StationFeed } from '@/hooks/useStationFeed';
import { usePlayer, type PlayerStatus } from '@/hooks/usePlayer';
import { useSignal, type Signal } from '@/hooks/useSignal';
import { useMediaSession } from '@/hooks/useMediaSession';
import { useStationClient, type LikeResult, type LikeStatus } from '@/lib/stationClient';
import type { RequestResult } from '@/lib/types';

export interface PlayerAudio {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  muted: boolean;
  idleStopped: boolean;
  /** Stream confirmed offline. useStationFeed's streamOnline is null until
   *  the first poll and only flips false after the confirm window, so this
   *  never flashes true on load. */
  offline: boolean;
  signal: Signal;
}

export interface PlayerActions {
  /** Toggle tune-in/out. */
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  setVolume: Dispatch<SetStateAction<number>>;
  /** Submit a listener request. Rejects on network error — form state and
   *  error toasts are the skin's business. */
  submitRequest: (text: string, name: string) => Promise<RequestResult>;
  /** Poll a submitted request's outcome (null on network error, so drawers
   *  keep trying). */
  pollRequest: (requestId: string) => Promise<RequestResult | null>;
  /** Like the currently playing track (#991). null on network error; error
   *  statuses come back as a LikeResult with `error`. */
  likeCurrent: (songId: string) => Promise<LikeResult | null>;
  /** Liked-state + count for the current airing. null on network error. */
  likeStatus: () => Promise<LikeStatus | null>;
}

const FeedContext = createContext<StationFeed | null>(null);
const AudioContext = createContext<PlayerAudio | null>(null);
const ActionsContext = createContext<PlayerActions | null>(null);

function useRequired<T>(ctx: React.Context<T | null>, name: string): T {
  const value = useContext(ctx);
  if (value == null) throw new Error(`${name} must be used inside <PlayerCoreProvider>`);
  return value;
}

export function usePlayerFeed(): StationFeed {
  return useRequired(FeedContext, 'usePlayerFeed');
}

export function usePlayerAudio(): PlayerAudio {
  return useRequired(AudioContext, 'usePlayerAudio');
}

export function usePlayerActions(): PlayerActions {
  return useRequired(ActionsContext, 'usePlayerActions');
}

export function PlayerCoreProvider({ children }: { children: ReactNode }) {
  const client = useStationClient();
  const {
    audioRef,
    tunedIn,
    status,
    volume,
    setVolume,
    tune,
    stop,
    toggleMute,
    muted,
    idleStopped,
    getListenerLagMs,
  } = usePlayer();
  // Player before feed: the feed's listener-time hold prefers the audio
  // element's measured lag over the advertised stream.bufferSeconds, so the
  // title flip and elapsed clock track what THIS tab actually hears
  // (getListenerLagMs is identity-stable — no feed resubscription).
  const feed = useStationFeed(getListenerLagMs);

  // Only an explicit false is offline — see PlayerAudio.offline.
  const offline = feed.streamOnline === false;
  const signal = useSignal({ tunedIn, status, offline });

  // usePlayer's tune/stop/toggleMute close over per-render state, so their
  // identity changes every render. Bridge through refs so the actions context
  // value is created exactly once — consumers can safely list actions in
  // effect deps without re-running.
  const tuneRef = useRef(tune);
  const stopRef = useRef(stop);
  const muteRef = useRef(toggleMute);
  tuneRef.current = tune;
  stopRef.current = stop;
  muteRef.current = toggleMute;

  const actions = useMemo<PlayerActions>(
    () => ({
      tune: () => tuneRef.current(),
      stop: () => stopRef.current(),
      toggleMute: () => muteRef.current(),
      setVolume,
      submitRequest: (text, name) => client.submitRequest(text, name),
      pollRequest: requestId => client.requestStatus(requestId),
      likeCurrent: songId => client.likeCurrent(songId),
      likeStatus: () => client.likeStatus(),
    }),
    [setVolume, client],
  );

  // Persona avatar to surface on the OS lock screen while the DJ is talking.
  // Prefer the on-air show's persona (a scheduled show can hand the hour to a
  // different DJ); fall back to the global "active" persona from /now-playing.
  // The controller emits a path without the `/api` prefix; client.resolve
  // prepends the station's API base so this resolves the same way in prod
  // (via Caddy), dev (direct origin), and the landing showcase (remote).
  const avatarPath =
    (typeof feed.activeShow?.persona?.avatar === 'string' && feed.activeShow.persona.avatar) ||
    (typeof feed.dj?.avatar === 'string' ? feed.dj.avatar : '') ||
    '';
  const personaAvatarUrl = avatarPath ? client.resolve(avatarPath) : null;
  const personaName =
    (typeof feed.activeShow?.persona?.name === 'string' && feed.activeShow.persona.name) ||
    (typeof feed.dj?.name === 'string' ? feed.dj.name : '') ||
    null;

  // Wire OS-level media controls (lock screen, headphones, car display).
  // No onSkip on the public listener — a stray AirPods double-tap shouldn't
  // skip the song for every other listener on the station.
  useMediaSession({
    tunedIn,
    nowPlaying: feed.nowPlaying,
    audioRef,
    onTune: actions.tune,
    boothFeed: feed.session.messages,
    personaAvatarUrl,
    personaName,
  });

  // useStationFeed returns a fresh object every render; its fields are
  // reference-stable (setIfChanged). Memoize on the fields so audio-context
  // churn (a volume drag) doesn't cascade into every feed consumer.
  const {
    nowPlaying, context, dj, activeShow, listeners, streamOnline,
    llmTokens, state, session, trackStartedAt, timezone, locale,
  } = feed;
  const feedValue = useMemo<StationFeed>(
    () => ({
      nowPlaying, context, dj, activeShow, listeners, streamOnline,
      llmTokens, state, session, trackStartedAt, timezone, locale,
    }),
    [nowPlaying, context, dj, activeShow, listeners, streamOnline,
     llmTokens, state, session, trackStartedAt, timezone, locale],
  );

  const { latencyMs, quality } = signal;
  const audioValue = useMemo<PlayerAudio>(
    () => ({
      audioRef, tunedIn, status, volume, muted, idleStopped, offline,
      signal: { latencyMs, quality },
    }),
    [audioRef, tunedIn, status, volume, muted, idleStopped, offline, latencyMs, quality],
  );

  return (
    <FeedContext.Provider value={feedValue}>
      <AudioContext.Provider value={audioValue}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </AudioContext.Provider>
    </FeedContext.Provider>
  );
}
