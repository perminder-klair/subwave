// The native port of web/web/hooks/usePlayer.ts.
//
// Owns tune-in state, status, volume, and the stall watchdog — but backed by
// react-native-track-player instead of an <audio> element. Tunes the MP3 floor
// by default; an optional stream format (validated upstream by useStreamFormat
// against platform + station support) selects the Opus/FLAC/AAC mounts. The
// base URL comes from StationContext, not a build-time env.

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

// Dev-build diagnostics for the audio pipeline (route handoffs, watchdog
// reloads). No-op in Release.
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

// Reconnect backoff for the error path, mirroring the web player. The first
// retry stays quick (a blip mid-broadcast should recover in half a second),
// but repeated failures double the delay up to a minute — a phone left tuned
// to a downed station must not hammer reconnects twice a second all night.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

export function usePlayer(
  api: StationApi | null,
  initialVolume = 1,
  // Device-level reachability (from useConnectivity), threaded in so a regained
  // link triggers an immediate reconnect rather than waiting for the watchdog.
  isConnected: boolean | null = null,
  // The Icecast mount to tune (already platform- and station-validated by
  // useStreamFormat — this hook just uses it). Defaults to the MP3 floor.
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
  // Consecutive failed reconnects since the last successful 'playing' — drives
  // the exponential backoff below.
  const retryCount = useRef(0);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { formatRef.current = streamFormat; }, [streamFormat]);

  useEffect(() => { setupPlayer().catch(() => {}); }, []);

  // Apply volume to the player engine whenever it changes.
  useEffect(() => {
    TrackPlayer.setVolume(volume).catch(() => {});
  }, [volume]);

  // Restore the listener's last-used volume (#828). AsyncStorage is async, so
  // the knob renders at the default first and snaps to the stored level once
  // the read lands. Persistence is gated on `hydrated` so the restoring
  // setVolume can't race the persist effect and write the default back.
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

  // Persist volume on change, debounced so a knob drag (dozens of setVolume
  // calls) collapses to one write.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => { void saveVolumePref(volume); }, 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Next error-path reconnect delay: 500ms doubling to a 60s ceiling, reset on
  // the next successful 'playing' (and on a fresh tune / regained link).
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
      // A throw here may not surface as a PlaybackError event — re-arm
      // ourselves, with backoff, so a dead origin keeps retrying (slowly).
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
  //
  // RemotePause/RemoteStop are handled HERE, not just in service.ts: on live
  // radio a lock-screen/notification pause means "tune out", but the Stopped/
  // Ended state it produces is indistinguishable from a stream failure — so
  // without this, the watchdog "recovered" the stream 500ms after the user
  // paused from the notification and the radio would not stay stopped.
  useTrackPlayerEvents(
    [Event.PlaybackState, Event.PlaybackError, Event.RemotePause, Event.RemoteStop],
    (event) => {
      plog(
        `event ${event.type}${'state' in event ? ` state=${String(event.state)}` : ''}${
          'message' in event ? ` msg=${String((event as { message?: string }).message)}` : ''
        }`,
      );
      if (event.type === Event.RemotePause || event.type === Event.RemoteStop) {
        // Listener-initiated, from the OS — a tune-out, not a failure. The ref
        // flips synchronously so the trailing Stopped event (which can land
        // before the re-render) can't re-arm the watchdog.
        clearWatchdog();
        retryCount.current = 0;
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
      if (state === State.Playing) {
        clearWatchdog();
        retryCount.current = 0;
        setStatus('playing');
        // A lock-screen Play after a remote tune-out resumes via service.ts
        // without touching this hook — re-adopt so the UI matches the audio.
        // getLastLiveMeta() is null after an in-app stop (teardown), which
        // keeps a stale in-flight Playing event from resurrecting tunedIn.
        if (!tunedInRef.current && getLastLiveMeta()) {
          tunedInRef.current = true;
          setTunedIn(true);
        }
      } else if (state === State.Buffering || state === State.Loading) {
        setStatus((s) => (s === 'playing' ? 'connecting' : s));
        armWatchdog(WATCHDOG_MS);
      } else if (state === State.Error) {
        if (tunedInRef.current) armWatchdog(nextRetryDelay());
      } else if (state === State.Ended || state === State.Stopped) {
        // A live stream shouldn't "end" — if it does while tuned in, reconnect.
        if (tunedInRef.current) armWatchdog(nextRetryDelay());
      }
    },
  );

  // iOS audio-route changes. When the device we were playing to goes away
  // (reason oldDeviceUnavailable: Bluetooth speaker powered off, CarPlay
  // disconnected, headphones unplugged), treat it as a tune-out (#992). The
  // longFormAudio session policy that keeps AirPlay routes sticky (see
  // player.ts) also keeps AVPlayer "playing" to the vanished route — silent
  // audio with the Icecast socket held open, a phantom listener. Every other
  // reason is deliberately left alone: newDeviceAvailable / override /
  // routeConfigurationChange are the AirPlay/HomePod handoffs that must keep
  // playing (the 0b060a3a behavior). Also the dev-build forensic trail for
  // route/handoff issues.
  useEffect(() => {
    const sub = addAudioRouteChangeListener((e) => {
      plog(`route change reason=${e.reason} outputs=${e.outputs}`);
      if (e.reason !== ROUTE_REASON_OLD_DEVICE_UNAVAILABLE || !tunedInRef.current) return;
      // Same synchronous flip as the RemotePause handler above — the ref must
      // read false before the trailing Stopped event lands, or the watchdog
      // "recovers" the stream and the phantom listener is back.
      clearWatchdog();
      retryCount.current = 0;
      tunedInRef.current = false;
      setTunedIn(false);
      setStatus('idle');
      // stop() (not pause) unloads the item, so the stream connection drops
      // and the listener count clears. lastLiveMeta survives (only teardown
      // clears it), so a later Play resumes at the live edge via service.ts.
      TrackPlayer.stop().catch(() => {});
    });
    return () => sub?.remove();
  }, [clearWatchdog]);

  // Proactive reconnect: when the device link returns (false → true) while
  // we're tuned in but not already playing, reconnect immediately instead of
  // waiting up to WATCHDOG_MS for the stall watchdog. The watchdog still covers
  // stream-side deaths where the link never dropped. Keyed on the connectivity
  // transition, so a steady-state `true` never fires it.
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (prev === false && isConnected === true && tunedInRef.current && status !== 'playing') {
      // Fresh network — let the backoff start small again.
      retryCount.current = 0;
      reconnect();
    }
  }, [isConnected, status, reconnect]);

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

  // Format change mid-listen — retune onto the new mount in place. Covers both
  // a fresh pick in the format drawer and the effective format snapping back
  // to MP3 when the station stops advertising the chosen mount. Keyed on the
  // transition (like the station-change effect above) so a steady value never
  // reloads the stream.
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
    // A fresh tune-in restarts the backoff ladder.
    retryCount.current = 0;
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
