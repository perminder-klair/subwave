'use client';

// The headless player core -- the per-station singletons every skin shares,
// split into three contexts by update cadence:
//   feed    -- the /now-playing + /state + /session snapshot, 5s cadence.
//   audio   -- tune state, volume, signal meter; user gestures and the 5s probe.
//   actions -- permanently-stable callbacks, bridged through refs since
//              usePlayer recreates its closures per render.
// The provider also runs the OS media session (including the persona-avatar
// swap while the DJ is talking). The <audio> element is rendered by the shell.

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
import { listenerRequestSchema } from '@/lib/schemas.generated';
import type { RequestResult } from '@/lib/types';

export interface PlayerAudio {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Ref callback for the shell's <audio> element. Skins read audioRef; only
   *  the shell that renders the element attaches it, and it must use this
   *  rather than audioRef so the hook sees a remount (see usePlayer). */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  muted: boolean;
  idleStopped: boolean;
  /** Stream confirmed offline. useStationFeed's streamOnline is null until the
   *  first poll and only flips false after the confirm window. */
  offline: boolean;
  signal: Signal;
}

export interface PlayerActions {
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  setVolume: Dispatch<SetStateAction<number>>;
  /** Submit a listener request. Rejects on network error. */
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
  // Feed first: usePlayer's Opus upgrade is gated on the mount the station says
  // it actually serves (#1300).
  const feed = useStationFeed();
  const {
    audioRef,
    attachAudio,
    tunedIn,
    status,
    volume,
    setVolume,
    tune,
    stop,
    toggleMute,
    muted,
    idleStopped,
  } = usePlayer({ opusEnabled: feed.opusEnabled });

  // Only an explicit false is offline — see PlayerAudio.offline.
  const offline = feed.streamOnline === false;
  const signal = useSignal({ tunedIn, status, offline });

  // usePlayer's tune/stop/toggleMute close over per-render state, so bridge
  // through refs and create the actions context value exactly once.
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
      // Pre-flight against the shared request schema, the same rule the
      // controller's validateBody enforces, run once here for every skin. A
      // refusal comes back as an ordinary failed RequestResult and never touches
      // the network.
      submitRequest: (text, name) => {
        const parsed = listenerRequestSchema.safeParse({ text, name });
        if (!parsed.success) {
          return Promise.resolve({
            success: false,
            message: parsed.error.issues[0]?.message,
          });
        }
        return client.submitRequest(parsed.data.text, parsed.data.name);
      },
      pollRequest: requestId => client.requestStatus(requestId),
      likeCurrent: songId => client.likeCurrent(songId),
      likeStatus: () => client.likeStatus(),
    }),
    [setVolume, client],
  );

  // Persona avatar for the OS lock screen while the DJ is talking. Prefer the
  // on-air show's persona; fall back to the global active one. The controller
  // emits a path without the `/api` prefix; client.resolve prepends the
  // station's API base.
  const avatarPath =
    (typeof feed.activeShow?.persona?.avatar === 'string' && feed.activeShow.persona.avatar) ||
    (typeof feed.dj?.avatar === 'string' ? feed.dj.avatar : '') ||
    '';
  const personaAvatarUrl = avatarPath ? client.resolve(avatarPath) : null;
  const personaName =
    (typeof feed.activeShow?.persona?.name === 'string' && feed.activeShow.persona.name) ||
    (typeof feed.dj?.name === 'string' ? feed.dj.name : '') ||
    null;

  // Wire OS-level media controls. No onSkip on the public listener: a stray
  // AirPods double-tap shouldn't skip the song for everyone.
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
  // reference-stable. Memoize on the fields so a volume drag doesn't cascade
  // into every feed consumer.
  const {
    nowPlaying, context, dj, activeShow, listeners, streamOnline,
    llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale,
  } = feed;
  const feedValue = useMemo<StationFeed>(
    () => ({
      nowPlaying, context, dj, activeShow, listeners, streamOnline,
      llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale,
    }),
    [nowPlaying, context, dj, activeShow, listeners, streamOnline,
     llmTokens, state, session, trackStartedAt, opusEnabled, timezone, locale],
  );

  const { latencyMs, quality } = signal;
  const audioValue = useMemo<PlayerAudio>(
    () => ({
      audioRef, attachAudio, tunedIn, status, volume, muted, idleStopped, offline,
      signal: { latencyMs, quality },
    }),
    [audioRef, attachAudio, tunedIn, status, volume, muted, idleStopped, offline, latencyMs, quality],
  );

  return (
    <FeedContext.Provider value={feedValue}>
      <AudioContext.Provider value={audioValue}>
        <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
      </AudioContext.Provider>
    </FeedContext.Provider>
  );
}
