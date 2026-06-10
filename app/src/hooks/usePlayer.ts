// The native port of web/web/hooks/usePlayer.ts.
//
// Owns tune-in state, status, volume, and the stall watchdog — but backed by
// react-native-track-player instead of an <audio> element. MP3-only (no codec
// probe; native skips Opus for the same chained-Ogg reasons the web pins iOS to
// MP3). The base URL comes from StationContext, not a build-time env.

import { useCallback, useEffect, useRef, useState } from 'react';
import TrackPlayer, {
  Event,
  State,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import { loadAndPlay, setupPlayer, teardown } from '@/audio/player';
import type { StationApi } from '@/lib/api';

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  setVolume: (v: number) => void;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
}

const WATCHDOG_MS = 6000;

export function usePlayer(api: StationApi | null, initialVolume = 1): Player {
  const [tunedIn, setTunedIn] = useState(false);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolumeState] = useState(initialVolume);
  const preMuteVolume = useRef(initialVolume || 1);

  const tunedInRef = useRef(tunedIn);
  const apiRef = useRef(api);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { apiRef.current = api; }, [api]);

  useEffect(() => { setupPlayer().catch(() => {}); }, []);

  // Apply volume to the player engine whenever it changes.
  useEffect(() => {
    TrackPlayer.setVolume(volume).catch(() => {});
  }, [volume]);

  const clearWatchdog = useCallback(() => {
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
  }, []);

  const reconnect = useCallback(async () => {
    clearWatchdog();
    const a = apiRef.current;
    if (!tunedInRef.current || !a) return;
    setStatus('connecting');
    try {
      await loadAndPlay({ url: a.streamUrl() });
      await TrackPlayer.setVolume(volume);
    } catch {
      /* the next error event will re-arm */
    }
  }, [clearWatchdog, volume]);

  const armWatchdog = useCallback(
    (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      watchdog.current = setTimeout(() => { reconnect(); }, delay);
    },
    [clearWatchdog, reconnect],
  );

  // Drive `status` from RNTP playback state + reconnect on error/stall.
  useTrackPlayerEvents([Event.PlaybackState, Event.PlaybackError], (event) => {
    if (event.type === Event.PlaybackError) {
      if (tunedInRef.current) {
        setStatus('connecting');
        armWatchdog(500);
      }
      return;
    }
    // PlaybackState
    const state = event.state;
    if (state === State.Playing) {
      clearWatchdog();
      setStatus('playing');
    } else if (state === State.Buffering || state === State.Loading) {
      setStatus((s) => (s === 'playing' ? 'connecting' : s));
      armWatchdog(WATCHDOG_MS);
    } else if (state === State.Error) {
      if (tunedInRef.current) armWatchdog(500);
    } else if (state === State.Ended || state === State.Stopped) {
      // A live stream shouldn't "end" — if it does while tuned in, reconnect.
      if (tunedInRef.current) armWatchdog(500);
    }
  });

  const stop = useCallback(() => {
    clearWatchdog();
    setTunedIn(false);
    setStatus('idle');
    teardown().catch(() => {});
  }, [clearWatchdog]);

  // When the station changes out from under us (switch / add / sign-out),
  // selectStation has already torn the old stream down at the RNTP level —
  // drop our local tuned-in state to match so the UI doesn't claim "on air"
  // over dead audio. (RNTP lands in State.None after reset(); the event
  // handler above deliberately ignores None because reset() also fires that
  // mid tune-in and mid reconnect.)
  const prevBaseRef = useRef(api?.base ?? null);
  useEffect(() => {
    const nextBase = api?.base ?? null;
    if (prevBaseRef.current === nextBase) return;
    prevBaseRef.current = nextBase;
    if (tunedInRef.current) stop();
  }, [api, stop]);

  const tune = useCallback(() => {
    if (tunedInRef.current) {
      stop();
      return;
    }
    const a = apiRef.current;
    if (!a) return;
    setTunedIn(true);
    setStatus('connecting');
    loadAndPlay({ url: a.streamUrl() })
      .then(() => TrackPlayer.setVolume(volume))
      .catch(() => { if (tunedInRef.current) armWatchdog(500); });
  }, [stop, volume, armWatchdog]);

  const setVolume = useCallback((v: number) => {
    setVolumeState(Math.max(0, Math.min(1, v)));
  }, []);

  const toggleMute = useCallback(() => {
    setVolumeState((v) => {
      if (v > 0) {
        preMuteVolume.current = v;
        return 0;
      }
      return preMuteVolume.current || 1;
    });
  }, []);

  // Tear down on unmount of the owning screen.
  useEffect(() => () => clearWatchdog(), [clearWatchdog]);

  return {
    tunedIn,
    status,
    volume,
    setVolume,
    tune,
    stop,
    toggleMute,
    muted: volume === 0,
  };
}
