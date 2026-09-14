// Tune-in state, status, volume and the stall watchdog, backed by
// react-native-track-player. Base URL comes from StationContext; the stream
// format is validated upstream by useStreamFormat.

import { useCallback, useEffect, useRef, useState } from 'react';
import TrackPlayer, {
  Event,
  State,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import {
  addAudioRouteChangeListener,
  ROUTE_REASON_OLD_DEVICE_UNAVAILABLE,
} from '../../modules/airplay-route-picker';
import { getLastLiveMeta, loadAndPlay, setupPlayer, teardown } from '@/audio/player';
import type { StationApi } from '@/lib/api';
import type { StreamFormat } from '@/lib/streamFormat';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';

// Dev-build only; no-op in Release.
function plog(msg: string) {
  if (__DEV__) console.log(`[player ${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

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

// Error-path reconnect backoff: doubles from 500ms to a 60s ceiling.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Buffering-churn guard. On a throttled network the native player retries the
// same URL internally every ~9s forever — Buffering→Playing flaps too short
// for the watchdog and with no PlaybackError, each abandoned connection
// lingering at Icecast as a phantom listener. Past CHURN_LIMIT entries into
// Buffering inside CHURN_WINDOW_MS, force a full reload to release the wedged
// native source.
const CHURN_WINDOW_MS = 60_000;
const CHURN_LIMIT = 4;

export function usePlayer(
  api: StationApi | null,
  initialVolume = 1,
  // From useConnectivity: a regained link reconnects immediately rather than
  // waiting out the watchdog.
  isConnected: boolean | null = null,
  streamFormat: StreamFormat = 'mp3',
): Player {
  const [tunedIn, setTunedIn] = useState(false);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolumeState] = useState(initialVolume);
  const preMuteVolume = useRef(initialVolume || 1);

  const tunedInRef = useRef(tunedIn);
  const apiRef = useRef(api);
  const formatRef = useRef(streamFormat);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCount = useRef(0);
  // Recent entries into Buffering. Not reset on 'playing': brief recoveries
  // between flaps are what the churn guard exists to see through.
  const bufferFlapsRef = useRef<number[]>([]);
  // Last raw PlaybackState. A ref, not `status` from the closure — two quick
  // events can land between renders and read a stale value.
  const lastPlaybackStateRef = useRef<State | null>(null);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { formatRef.current = streamFormat; }, [streamFormat]);

  useEffect(() => { setupPlayer().catch(() => {}); }, []);

  useEffect(() => {
    TrackPlayer.setVolume(volume).catch(() => {});
  }, [volume]);

  // Restore the last-used volume (#828). Persistence is gated on `hydrated` so
  // the restoring setVolume can't race the persist effect and write the
  // default back.
  const hydratedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    loadVolumePref().then((stored) => {
      if (!alive) return;
      if (stored !== null) {
        setVolumeState(stored);
        if (stored > 0) preMuteVolume.current = stored;
      }
      hydratedRef.current = true;
    });
    return () => { alive = false; };
  }, []);

  // Debounced so a knob drag collapses to one write.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => { void saveVolumePref(volume); }, 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Reset on the next successful 'playing', a fresh tune, or a regained link.
  const nextRetryDelay = useCallback(() => {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
    retryCount.current += 1;
    return delay;
  }, []);

  const clearWatchdog = useCallback(() => {
    if (watchdog.current) {
      clearTimeout(watchdog.current);
      watchdog.current = null;
    }
  }, []);

  // reconnect() needs armWatchdog, which needs reconnect — bridge with a ref.
  const armWatchdogRef = useRef<(delay: number) => void>(() => {});

  const reconnect = useCallback(async () => {
    clearWatchdog();
    const a = apiRef.current;
    if (!tunedInRef.current || !a) return;
    plog(`reconnect → loadAndPlay (${formatRef.current})`);
    setStatus('connecting');
    try {
      await loadAndPlay({ url: a.streamUrl(formatRef.current), headers: a.streamHeaders() });
      await TrackPlayer.setVolume(volume);
    } catch {
      // A throw here may not surface as a PlaybackError event, so re-arm here.
      if (tunedInRef.current) armWatchdogRef.current(nextRetryDelay());
    }
  }, [clearWatchdog, volume, nextRetryDelay]);

  const armWatchdog = useCallback(
    (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      watchdog.current = setTimeout(() => { reconnect(); }, delay);
    },
    [clearWatchdog, reconnect],
  );
  useEffect(() => { armWatchdogRef.current = armWatchdog; }, [armWatchdog]);

  // Drive `status` from RNTP playback state + reconnect on error/stall.
  // RemotePause/RemoteStop are handled here as well as in service.ts: the
  // Stopped/Ended state a lock-screen pause produces is indistinguishable from
  // a stream failure, so without this the watchdog reconnects 500ms later.
  useTrackPlayerEvents(
    [Event.PlaybackState, Event.PlaybackError, Event.RemotePause, Event.RemoteStop],
    (event) => {
      plog(
        `event ${event.type}${'state' in event ? ` state=${String(event.state)}` : ''}${
          'message' in event ? ` msg=${String((event as { message?: string }).message)}` : ''
        }`,
      );
      if (event.type === Event.RemotePause || event.type === Event.RemoteStop) {
        // A tune-out, not a failure. The ref flips synchronously so the
        // trailing Stopped event can't re-arm the watchdog before the
        // re-render.
        clearWatchdog();
        retryCount.current = 0;
        bufferFlapsRef.current = [];
        tunedInRef.current = false;
        setTunedIn(false);
        setStatus('idle');
        return;
      }
      if (event.type === Event.PlaybackError) {
        if (tunedInRef.current) {
          setStatus('connecting');
          armWatchdog(nextRetryDelay());
        }
        return;
      }
      // PlaybackState
      const state = event.state;
      const prevState = lastPlaybackStateRef.current;
      lastPlaybackStateRef.current = state;
      if (state === State.Playing) {
        clearWatchdog();
        retryCount.current = 0;
        setStatus('playing');
        // A lock-screen Play resumes via service.ts without touching this
        // hook; re-adopt so the UI matches the audio. getLastLiveMeta() is
        // null after an in-app stop, so a stale Playing event can't resurrect
        // tunedIn.
        if (!tunedInRef.current && getLastLiveMeta()) {
          tunedInRef.current = true;
          setTunedIn(true);
        }
      } else if (state === State.Buffering || state === State.Loading) {
        setStatus((s) => (s === 'playing' ? 'connecting' : s));
        // Churn guard: only stalls out of Playing count, so tune-in and
        // watchdog reloads never feed the window.
        if (prevState === State.Playing && tunedInRef.current) {
          const now = Date.now();
          const flaps = bufferFlapsRef.current.filter((t) => now - t < CHURN_WINDOW_MS);
          flaps.push(now);
          bufferFlapsRef.current = flaps;
          if (flaps.length >= CHURN_LIMIT) {
            bufferFlapsRef.current = [];
            plog(`churn guard: ${CHURN_LIMIT} stalls inside ${CHURN_WINDOW_MS / 1000}s — forcing reload`);
            reconnect();
            return;
          }
        }
        armWatchdog(WATCHDOG_MS);
      } else if (state === State.Error) {
        if (tunedInRef.current) armWatchdog(nextRetryDelay());
      } else if (state === State.Ended || state === State.Stopped) {
        // A live stream shouldn't "end" — if it does while tuned in, reconnect.
        if (tunedInRef.current) armWatchdog(nextRetryDelay());
      }
    },
  );

  // iOS: an oldDeviceUnavailable route change (Bluetooth speaker off, CarPlay
  // disconnected, headphones unplugged) is a tune-out (#992) — the
  // longFormAudio session policy keeps AVPlayer "playing" to the vanished
  // route, holding the Icecast socket open as a phantom listener. Every other
  // reason must keep playing: newDeviceAvailable / override /
  // routeConfigurationChange are the AirPlay/HomePod handoffs.
  useEffect(() => {
    const sub = addAudioRouteChangeListener((e) => {
      plog(`route change reason=${e.reason} outputs=${e.outputs}`);
      if (e.reason !== ROUTE_REASON_OLD_DEVICE_UNAVAILABLE || !tunedInRef.current) return;
      // Same synchronous ref flip as the RemotePause handler above.
      clearWatchdog();
      retryCount.current = 0;
      bufferFlapsRef.current = [];
      tunedInRef.current = false;
      setTunedIn(false);
      setStatus('idle');
      // stop(), not pause: unloads the item so the Icecast connection drops.
      // lastLiveMeta survives (only teardown clears it) so a later Play
      // resumes at the live edge via service.ts.
      TrackPlayer.stop().catch(() => {});
    });
    return () => sub?.remove();
  }, [clearWatchdog]);

  // Keyed on the false → true transition so a steady-state `true` never fires
  // it. The watchdog still covers stream-side deaths where the link held.
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (prev === false && isConnected === true && tunedInRef.current && status !== 'playing') {
      retryCount.current = 0;
      reconnect();
    }
  }, [isConnected, status, reconnect]);

  const stop = useCallback(() => {
    clearWatchdog();
    bufferFlapsRef.current = [];
    setTunedIn(false);
    setStatus('idle');
    teardown().catch(() => {});
  }, [clearWatchdog]);

  // On a station switch selectStation has already torn the stream down at the
  // RNTP level; drop local tuned-in state so the UI doesn't claim "on air"
  // over dead audio. (The event handler ignores State.None because reset()
  // also fires it mid tune-in and mid reconnect.)
  const prevBaseRef = useRef(api?.base ?? null);
  useEffect(() => {
    const nextBase = api?.base ?? null;
    if (prevBaseRef.current === nextBase) return;
    prevBaseRef.current = nextBase;
    if (tunedInRef.current) stop();
  }, [api, stop]);

  // Retune onto a new mount in place. Keyed on the transition so a steady
  // value never reloads the stream.
  const prevFormatRef = useRef(streamFormat);
  useEffect(() => {
    if (prevFormatRef.current === streamFormat) return;
    prevFormatRef.current = streamFormat;
    if (!tunedInRef.current) return;
    retryCount.current = 0;
    reconnect();
  }, [streamFormat, reconnect]);

  const tune = useCallback(() => {
    if (tunedInRef.current) {
      stop();
      return;
    }
    const a = apiRef.current;
    if (!a) return;
    retryCount.current = 0;
    bufferFlapsRef.current = [];
    setTunedIn(true);
    setStatus('connecting');
    loadAndPlay({ url: a.streamUrl(formatRef.current), headers: a.streamHeaders() })
      .then(() => TrackPlayer.setVolume(volume))
      .catch(() => { if (tunedInRef.current) armWatchdog(nextRetryDelay()); });
  }, [stop, volume, armWatchdog, nextRetryDelay]);

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
