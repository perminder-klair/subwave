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
import { StreamRecovery } from '@/lib/stream-recovery';
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
  const volumeRef = useRef(volume);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { formatRef.current = streamFormat; }, [streamFormat]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  // Every reload (tune-in, retune, watchdog, churn, error backoff, regained
  // link) goes through this: one at a time, and never over audio the native
  // clock shows is still playing (#2114, #1936). The events below only report.
  const recoveryRef = useRef<StreamRecovery | null>(null);
  useEffect(() => {
    const recovery = new StreamRecovery({
      position: () => TrackPlayer.getProgress().then((p) => p.position),
      reload: async () => {
        const a = apiRef.current;
        if (!a) return;
        setStatus('connecting');
        await loadAndPlay({ url: a.streamUrl(formatRef.current), headers: a.streamHeaders() });
        await TrackPlayer.setVolume(volumeRef.current);
      },
      onAdvancing: () => setStatus('playing'),
      log: plog,
    });
    recoveryRef.current = recovery;
    return () => {
      recovery.tuneOut();
      recoveryRef.current = null;
    };
  }, []);

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

  // Drive `status` from RNTP playback state, and report every event to the
  // StreamRecovery. RemotePause/RemoteStop are handled here as well as in
  // service.ts: the Stopped/Ended state a lock-screen pause produces is
  // indistinguishable from a stream failure, so without this the error
  // backoff reconnects 500ms later. RemoteDuck only tells the recovery an iOS
  // interruption began or ended: iOS pauses the audio, RNTP resumes it
  // (autoHandleInterruptions), and nothing here touches playback.
  useTrackPlayerEvents(
    [Event.PlaybackState, Event.PlaybackError, Event.RemotePause, Event.RemoteStop, Event.RemoteDuck],
    (event) => {
      plog(
        `event ${event.type}${'state' in event ? ` state=${String(event.state)}` : ''}${
          'message' in event ? ` msg=${String((event as { message?: string }).message)}` : ''
        }`,
      );
      if (event.type === Event.RemotePause || event.type === Event.RemoteStop) {
        // A tune-out, not a failure. Both flip synchronously so the trailing
        // Stopped event can't arm a reconnect before the re-render.
        recoveryRef.current?.tuneOut();
        tunedInRef.current = false;
        setTunedIn(false);
        setStatus('idle');
        return;
      }
      if (event.type === Event.RemoteDuck) {
        recoveryRef.current?.onDuck(event.paused, event.permanent);
        return;
      }
      if (event.type === Event.PlaybackError) {
        if (tunedInRef.current) setStatus('connecting');
        recoveryRef.current?.onError();
        return;
      }
      // PlaybackState
      const state = event.state;
      if (state === State.Playing) {
        setStatus('playing');
        // A lock-screen Play resumes via service.ts without touching this
        // hook; re-adopt so the UI matches the audio. getLastLiveMeta() is
        // null after an in-app stop, so a stale Playing event can't resurrect
        // tunedIn.
        if (!tunedInRef.current && getLastLiveMeta()) {
          tunedInRef.current = true;
          setTunedIn(true);
          recoveryRef.current?.adopt();
        }
      } else if (state === State.Buffering || state === State.Loading) {
        setStatus((s) => (s === 'playing' ? 'connecting' : s));
      }
      recoveryRef.current?.onState(state);
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
      // Same synchronous flip as the RemotePause handler above.
      recoveryRef.current?.tuneOut();
      tunedInRef.current = false;
      setTunedIn(false);
      setStatus('idle');
      // stop(), not pause: unloads the item so the Icecast connection drops.
      // lastLiveMeta survives (only teardown clears it) so a later Play
      // resumes at the live edge via service.ts.
      TrackPlayer.stop().catch(() => {});
    });
    return () => sub?.remove();
  }, []);

  // Keyed on the false → true transition so a steady-state `true` never fires
  // it. The watchdog still covers stream-side deaths where the link held.
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (prev === false && isConnected === true && tunedInRef.current && status !== 'playing') {
      recoveryRef.current?.linkRegained();
    }
  }, [isConnected, status]);

  const stop = useCallback(() => {
    recoveryRef.current?.tuneOut();
    setTunedIn(false);
    setStatus('idle');
    teardown().catch(() => {});
  }, []);

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
    recoveryRef.current?.retune();
  }, [streamFormat]);

  const tune = useCallback(() => {
    if (tunedInRef.current) {
      stop();
      return;
    }
    if (!apiRef.current) return;
    setTunedIn(true);
    setStatus('connecting');
    recoveryRef.current?.tuneIn();
  }, [stop]);

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
