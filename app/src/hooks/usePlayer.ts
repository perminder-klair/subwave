// The native port of web/web/hooks/usePlayer.ts.
//
// Owns tune-in state, status, volume, and the stall watchdog — but backed by
// react-native-track-player instead of an <audio> element. MP3-only (no codec
// probe; native skips Opus for the same chained-Ogg reasons the web pins iOS to
// MP3). The base URL comes from StationContext, not a build-time env.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import TrackPlayer, {
  Event,
  State,
  useTrackPlayerEvents,
} from 'react-native-track-player';
import { addAudioRouteChangeListener } from '../../modules/airplay-route-picker';
import { getLastLiveMeta, loadAndPlay, setupPlayer, teardown } from '@/audio/player';
import type { StationApi } from '@/lib/api';
import {
  availabilityFor,
  fallbackForLoadRejection,
  resolveHydratedPreference,
  shouldApplyHydratedPreference,
  streamUrlFor,
  type AudioFormat,
  type FormatAvailability,
  type StreamEnablement,
} from '@/lib/audioFormat';
import { loadFormatPreference, saveFormatPreference } from '@/lib/audioFormatStorage';
import {
  createFirstTuneReadiness,
  createLatestLoadCoordinator,
  type FirstTuneReadiness,
} from '@/lib/audioFormatCoordinator';
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
  format: AudioFormat;
  availability: FormatAvailability;
  selectFormat: (format: AudioFormat) => void;
  formatFailure: AudioFormat | null;
}

const WATCHDOG_MS = 6000;
const FIRST_TUNE_CAPABILITY_TIMEOUT_MS = 5000;

// Reconnect backoff for the error path, mirroring the web player. The first
// retry stays quick (a blip mid-broadcast should recover in half a second),
// but repeated failures double the delay up to a minute — a phone left tuned
// to a downed station must not hammer reconnects twice a second all night.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;
const DEFAULT_STREAM_ENABLEMENT: StreamEnablement = {
  mp3: true, opus: false, aac: false, flac: false,
};

export function usePlayer(
  api: StationApi | null,
  initialVolume = 1,
  // Device-level reachability (from useConnectivity), threaded in so a regained
  // link triggers an immediate reconnect rather than waiting for the watchdog.
  isConnected: boolean | null = null,
  streamEnablement: StreamEnablement | null = null,
): Player {
  const [tunedIn, setTunedIn] = useState(false);
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolumeState] = useState(initialVolume);
  const [format, setFormat] = useState<AudioFormat>('mp3');
  const [formatFailure, setFormatFailure] = useState<AudioFormat | null>(null);
  const preMuteVolume = useRef(initialVolume || 1);

  const tunedInRef = useRef(tunedIn);
  const apiRef = useRef(api);
  const failedFormatsRef = useRef(new Set<AudioFormat>());
  const formatRef = useRef<AudioFormat>('mp3');
  const volumeRef = useRef(initialVolume);
  const playbackGenerationRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const firstTuneReadinessRef = useRef<FirstTuneReadiness | null>(null);
  const streamEnablementRef = useRef<StreamEnablement | null>(streamEnablement);
  const hydratedPreferenceRef = useRef<{
    base: string;
    stored: AudioFormat | null;
    selectionRevision: number;
  } | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  type NativeLoad = {
    format: AudioFormat;
    base: string;
    url: string;
    headers: Record<string, string> | undefined;
    volume: number;
    generation: number;
  };
  const loadCoordinatorRef = useRef<ReturnType<typeof createLatestLoadCoordinator<NativeLoad>> | null>(null);
  if (loadCoordinatorRef.current == null) {
    loadCoordinatorRef.current = createLatestLoadCoordinator(async (load) => {
      await loadAndPlay({ url: load.url, headers: load.headers });
      await TrackPlayer.setVolume(load.volume);
    });
  }
  // Consecutive failed reconnects since the last successful 'playing' — drives
  // the exponential backoff below.
  const retryCount = useRef(0);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { apiRef.current = api; }, [api]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { streamEnablementRef.current = streamEnablement; }, [streamEnablement]);

  const availability = useMemo(() => availabilityFor(
    Platform.OS === 'ios' ? 'ios' : 'android',
    streamEnablement ?? DEFAULT_STREAM_ENABLEMENT,
    failedFormatsRef.current,
    // formatFailure is the state signal for failedFormatsRef mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [streamEnablement, formatFailure]);

  useEffect(() => {
    const base = api?.base;
    // Invalidate every load owned by the previous station before its promise
    // can reject into this station's session.
    playbackGenerationRef.current += 1;
    selectionRevisionRef.current += 1;
    const hydrationSelectionRevision = selectionRevisionRef.current;
    failedFormatsRef.current.clear();
    firstTuneReadinessRef.current?.invalidate();
    loadCoordinatorRef.current?.invalidate();
    hydratedPreferenceRef.current = null;
    setFormatFailure(null);
    formatRef.current = 'mp3';
    setFormat('mp3');
    if (!base) {
      firstTuneReadinessRef.current = null;
      return;
    }
    const readiness = createFirstTuneReadiness(base, FIRST_TUNE_CAPABILITY_TIMEOUT_MS);
    firstTuneReadinessRef.current = readiness;
    if (streamEnablementRef.current) readiness.resolveCapabilities(streamEnablementRef.current);
    const hydration = loadFormatPreference(base).then((stored) => {
      readiness.resolveStorage(stored);
      if (!shouldApplyHydratedPreference(
        base, apiRef.current?.base, hydrationSelectionRevision, selectionRevisionRef.current,
      )) return;
      hydratedPreferenceRef.current = {
        base, stored, selectionRevision: hydrationSelectionRevision,
      };
      const enablement = streamEnablementRef.current;
      const nextAvailability = availabilityFor(
        Platform.OS === 'ios' ? 'ios' : 'android',
        enablement ?? DEFAULT_STREAM_ENABLEMENT,
        failedFormatsRef.current,
      );
      const resolved = resolveHydratedPreference(
        stored, nextAvailability, enablement !== null,
        hydrationSelectionRevision, selectionRevisionRef.current,
      );
      if (resolved === null) return;
      formatRef.current = resolved;
      setFormat(resolved);
    }).catch(() => { readiness.resolveStorage(null); });
    void hydration;
  }, [api?.base]);

  useEffect(() => { setupPlayer().catch(() => {}); }, []);

  // Log iOS audio-route changes in dev builds — the forensic trail for
  // AirPlay handoff issues (which reason code fires, what the route becomes,
  // and how that interleaves with our reconnects).
  useEffect(() => {
    if (!__DEV__) return;
    const sub = addAudioRouteChangeListener((e) => {
      plog(`route change reason=${e.reason} outputs=${e.outputs}`);
    });
    return () => sub?.remove();
  }, []);

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

  const loadOnce = useCallback(async (next: AudioFormat) => {
    const a = apiRef.current;
    if (!a) return;
    const generation = ++playbackGenerationRef.current;
    formatRef.current = next;
    setFormat(next);
    const result = await loadCoordinatorRef.current!.request({
      format: next,
      base: a.base,
      url: streamUrlFor(a.streamUrls(), next),
      headers: a.streamHeaders(),
      volume: volumeRef.current,
      generation,
    });
    if (result.status === 'superseded' || result.status === 'applied') return null;
    return { error: result.error, generation, format: next, base: a.base };
  }, []);

  const loadFormat = useCallback(async (next: AudioFormat) => {
    const rejection = await loadOnce(next);
    if (!rejection) return;
    const failed = fallbackForLoadRejection(
      rejection.format, rejection.generation, playbackGenerationRef.current,
      rejection.base, apiRef.current?.base, tunedInRef.current,
    );
    // An abandoned tune, another station, or a newer load superseded this
    // rejection. It must not affect the current mount, availability, or retry.
    if (!tunedInRef.current || rejection.base !== apiRef.current?.base
      || rejection.generation !== playbackGenerationRef.current) return;
    if (!failed) throw rejection.error;
    failedFormatsRef.current.add(failed.failed);
    setFormatFailure(failed.failed);
    const fallbackRejection = await loadOnce(failed.fallback);
    if (fallbackRejection && fallbackRejection.generation === playbackGenerationRef.current) {
      throw fallbackRejection.error;
    }
  }, [loadOnce]);

  // Enablement may refresh while a station remains selected. Preserve session
  // failures, but ensure the exposed target and RNTP mount cannot remain on a
  // format the station has just disabled.
  useEffect(() => {
    if (streamEnablement === null) return;
    firstTuneReadinessRef.current?.resolveCapabilities(streamEnablement);
    const currentAvailability = availabilityFor(
      Platform.OS === 'ios' ? 'ios' : 'android', streamEnablement, failedFormatsRef.current,
    );
    const hydrated = hydratedPreferenceRef.current;
    if (hydrated && hydrated.base === apiRef.current?.base) {
      const resolved = resolveHydratedPreference(
        hydrated.stored, currentAvailability, true,
        hydrated.selectionRevision, selectionRevisionRef.current,
      );
      if (resolved !== null) {
        const changed = formatRef.current !== resolved;
        formatRef.current = resolved;
        setFormat(resolved);
        if (changed && tunedInRef.current) {
          clearWatchdog();
          setStatus('connecting');
          loadFormat(resolved).catch(() => {
            if (tunedInRef.current) armWatchdogRef.current(nextRetryDelay());
          });
          return;
        }
      }
    }
    if (currentAvailability[formatRef.current].available) return;
    formatRef.current = 'mp3';
    setFormat('mp3');
    if (!tunedInRef.current) return;
    clearWatchdog();
    setStatus('connecting');
    loadFormat('mp3').catch(() => {
      if (tunedInRef.current) armWatchdogRef.current(nextRetryDelay());
    });
  }, [streamEnablement, clearWatchdog, loadFormat, nextRetryDelay]);

  const reconnect = useCallback(async () => {
    clearWatchdog();
    const a = apiRef.current;
    if (!tunedInRef.current || !a) return;
    plog('reconnect → loadAndPlay');
    setStatus('connecting');
    try {
      await loadFormat(formatRef.current);
    } catch {
      // A throw here may not surface as a PlaybackError event — re-arm
      // ourselves, with backoff, so a dead origin keeps retrying (slowly).
      if (tunedInRef.current) armWatchdogRef.current(nextRetryDelay());
    }
  }, [clearWatchdog, loadFormat, nextRetryDelay]);

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
          // RNTP does not identify which historical load emitted this event.
          // Treat it as a transport interruption only; promise rejections in
          // loadFormat are the sole source of optional-format blacklisting.
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
    // Any in-flight load now belongs to an abandoned tune session. Its later
    // rejection must not blacklist a format or start a fallback load.
    playbackGenerationRef.current += 1;
    loadCoordinatorRef.current?.invalidate();
    tunedInRef.current = false;
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

  const tune = useCallback(async () => {
    if (tunedInRef.current) {
      stop();
      return;
    }
    const a = apiRef.current;
    if (!a) return;
    const base = a.base;
    const readiness = firstTuneReadinessRef.current;
    const readyFormat = readiness
      ? await readiness.wait(Platform.OS === 'ios' ? 'ios' : 'android')
      : 'mp3';
    if (readyFormat === null) return;
    if (apiRef.current?.base !== base) return;
    // A fresh tune-in restarts the backoff ladder.
    retryCount.current = 0;
    tunedInRef.current = true;
    setTunedIn(true);
    setStatus('connecting');
    formatRef.current = readyFormat;
    setFormat(readyFormat);
    loadFormat(readyFormat)
      .catch(() => { if (tunedInRef.current) armWatchdog(nextRetryDelay()); });
  }, [stop, loadFormat, armWatchdog, nextRetryDelay]);

  const selectFormat = useCallback((next: AudioFormat) => {
    const a = apiRef.current;
    if (!a) return;
    const currentAvailability = availabilityFor(
      Platform.OS === 'ios' ? 'ios' : 'android',
      streamEnablement ?? DEFAULT_STREAM_ENABLEMENT,
      failedFormatsRef.current,
    );
    if (!currentAvailability[next].available) return;
    selectionRevisionRef.current += 1;
    firstTuneReadinessRef.current?.select(next);
    formatRef.current = next;
    setFormat(next);
    setFormatFailure(null);
    void saveFormatPreference(a.base, next);
    if (!tunedInRef.current) return;
    clearWatchdog();
    setStatus('connecting');
    loadFormat(next).catch(() => {
      if (tunedInRef.current) armWatchdog(nextRetryDelay());
    });
  }, [streamEnablement, clearWatchdog, loadFormat, armWatchdog, nextRetryDelay]);

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
    format,
    availability,
    selectFormat,
    formatFailure,
  };
}
