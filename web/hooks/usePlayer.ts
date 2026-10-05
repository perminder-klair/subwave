'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isIOSDevice } from '@/lib/platform';
import { useStationOrigin } from '@/lib/stationOrigin';
import { withStreamAuth } from '@/lib/stationAuth';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';
import { createPausedMediaUrl } from '@/lib/pausedMedia';

// Reconnect backoff for the watchdog's error path: quick first retry, doubling to a minute.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Idle cutoff (#343). A forgotten tab counts as a listener and holds the DJ's
// pause-when-empty gate open, so tune out after this long with no pointer/key/focus activity.
const IDLE_TUNE_OUT_MS = 8 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

// HTMLMediaElement.HAVE_FUTURE_DATA, read as a constant so the checks below work on a detached element.
const HAVE_FUTURE_DATA = 3;

// Ground truth for "the listener is hearing sound": `stalled` says nothing about
// it, and a wedged element fails this check even though `paused` is false.
function advancingSince(el: HTMLAudioElement, since: number): boolean {
  return !el.paused && el.readyState >= HAVE_FUTURE_DATA && el.currentTime > since;
}

function freshStreamUrl(streamUrl: string, generation: number): string {
  const url = new URL(streamUrl, document.baseURI);
  url.searchParams.set('t', `${Date.now()}-${generation}`);
  return withStreamAuth(url.href);
}

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Ref callback the consumer MUST put on its <audio> element instead of audioRef:
   *  it keeps audioRef on the live node AND tells the hook when that node is replaced
   *  so the media listeners re-attach (#1232). Stable identity. */
  attachAudio: (el: HTMLAudioElement | null) => void;
  tunedIn: boolean;
  playbackState: MediaSessionPlaybackState;
  status: PlayerStatus;
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  play: () => void;
  pause: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
  // True when the idle cutoff, not the listener, tore playback down. Cleared on the next tune().
  idleStopped: boolean;
}

export interface UsePlayerOptions {
  initialVolume?: number;
  /** Whether the station is configured to serve `/stream.opus` (the setting, not a
   *  live mount probe). null/undefined = not known yet; the upgrade waits. */
  opusEnabled?: boolean | null;
}

// Owns the <audio> element + tune-in state. The consumer renders the <audio> tag, so skins can tap it.
export function usePlayer({ initialVolume = 1, opusEnabled = null }: UsePlayerOptions = {}): Player {
  const { streams } = useStationOrigin();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const gen = useRef(0);
  const tunedInRef = useRef(false);
  const pausedMediaUrl = useRef<string | null>(null);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playbackState, setPlaybackState] = useState<MediaSessionPlaybackState>('none');
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const tunedIn = playbackState === 'playing';

  const clearWatchdog = useCallback(() => {
    if (watchdogTimer.current !== null) clearTimeout(watchdogTimer.current);
    watchdogTimer.current = null;
  }, []);
  const releasePausedMedia = useCallback(() => {
    if (pausedMediaUrl.current) URL.revokeObjectURL(pausedMediaUrl.current);
    pausedMediaUrl.current = null;
  }, []);
  const unloadAudio = useCallback((el: HTMLAudioElement) => {
    el.pause();
    el.removeAttribute('src');
    el.load();
    releasePausedMedia();
  }, [releasePausedMedia]);
  // audioRef.current mirrored into state so the listener effect can depend on it:
  // refs don't notify on attach, so a swapped element has to announce itself.
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    if (audioRef.current === el) return;
    // Ref detachment covers unmount and the private-player gate. Disconnect the
    // old node immediately; no pending play promise may keep it on the mount.
    if (audioRef.current) {
      ++gen.current;
      tunedInRef.current = false;
      clearWatchdog();
      unloadAudio(audioRef.current);
      setPlaybackState('none');
      setStatus('idle');
    }
    audioRef.current = el;
    setAudioEl(el);
  }, [clearWatchdog, unloadAudio]);
  // SSR + first render use the MP3 URL so markup agrees; the effect below upgrades to Opus.
  const [streamUrl, setStreamUrl] = useState<string>(streams.mp3);
  const [volume, setVolume] = useState(initialVolume);
  const [idleStopped, setIdleStopped] = useState(false);
  const preMuteVolume = useRef(initialVolume || 1);

  // Refs mirror the latest state the stall watchdog reads, so its listeners register once.
  const streamUrlRef = useRef(streamUrl);
  const streamsRef = useRef(streams);
  const volumeRef = useRef(volume);
  // Media clock at arm time — the baseline the fire compares against.
  const watchdogArmedAt = useRef(0);
  // Consecutive failed reconnects since the last 'playing'; drives the backoff.
  const retryCount = useRef(0);
  // Last listener activity, read by the idle sweep. Seeded by the sweep effect at mount
  // (render must stay pure) so a fresh tab gets the full idle window.
  const lastActivityAt = useRef(0);
  // The idle sweep mounts once but must call the latest stop() — bridge with a ref.
  const stopRef = useRef<() => void>(() => {});
  // Set if the optional Opus mount fails to load; pins to MP3 so the watchdog stops retrying.
  const opusFailedRef = useRef(false);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Restore the listener's last-used volume (#783). Effect-only, so SSR and first paint
  // stay on the default; `hydrated` keeps it from racing the persist effect below.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadVolumePref();
    if (stored !== null) {
      setVolume(stored);
      preMuteVolume.current = stored > 0 ? stored : preMuteVolume.current;
    }
    hydratedRef.current = true;
  }, []);

  // Debounced so a knob drag collapses to one write. The cleanup also keeps the mount
  // pass's default from reaching localStorage before the restore effect's setVolume lands.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => saveVolumePref(volume), 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Four gates guard the Opus upgrade; MP3 is the universal floor. Require
  // canPlayType 'probably', skip the iOS family and skip Firefox by UA (both
  // choke on Icecast's chained Ogg at a crossfade, #212), and require the
  // station's own `opusEnabled` to be explicitly true (null = not polled yet).
  // That is the SETTING and the mixer reads it at startup, so a saved-but-not-
  // restarted station can still 404 -- hence the onError self-heal below. No
  // live retarget: setStreamUrl reaches the element only on the next
  // tune()/reconnect() (#1232, #1234).
  useEffect(() => {
    if (opusEnabled !== true) return;
    if (!streams.opus || opusFailedRef.current) return;
    const ua = navigator.userAgent;
    // Desktop/Android Firefox + Gecko forks carry "Firefox" in the UA; Firefox-for-iOS
    // reports "FxiOS" and is already caught by isIOSDevice() below.
    const isFirefox = /firefox/i.test(ua);
    if (isIOSDevice() || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(streams.opus);
    }
  }, [streams.opus, opusEnabled]);

  // Drive `status` from the <audio> element's own events and reconnect when it
  // wedges. 'playing' clears the watchdog; 'waiting'/'stalled' arm a 5s timer
  // that re-sets src if the media clock hasn't moved; 'error' reconnects with
  // backoff. Re-runs when the element is replaced (attachAudio).
  useEffect(() => {
    const el = audioEl;
    if (!el) return;

    const isLive = () => tunedInRef.current && audioRef.current === el;

    const reconnect = () => {
      clearWatchdog();
      if (!isLive()) return;
      const audio = el;
      // The media clock moved while the watchdog was pending, so the listener is hearing
      // audio. Re-setting src would cut sound for nothing; reconcile the UI instead (#1232).
      if (advancingSince(audio, watchdogArmedAt.current)) {
        retryCount.current = 0;
        setStatus('playing');
        return;
      }
      const myGen = ++gen.current;
      audio.src = freshStreamUrl(streamUrlRef.current, myGen);
      audio.volume = volumeRef.current;
      setStatus('connecting');
      const p = audio.play();
      Promise.resolve(p).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
        if (gen.current === myGen && name !== 'AbortError') {
          if (name === 'NotAllowedError') stopRef.current();
          console.error('Reconnect failed:', err);
        }
      });
    };

    const armWatchdog = (delay: number) => {
      if (!isLive()) return;
      clearWatchdog();
      // Sample the media clock so the fire can tell a dead stream from late bytes.
      watchdogArmedAt.current = audioRef.current?.currentTime ?? 0;
      watchdogTimer.current = setTimeout(reconnect, delay);
    };

    const onPlaying = () => {
      if (!isLive() || el.paused) return;
      clearWatchdog();
      retryCount.current = 0;
      setStatus('playing');
    };
    // 'waiting' is a PLAYBACK event: the element ran out of decoded audio and has gone silent.
    const onWaiting = () => {
      if (!isLive()) return;
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    // 'stalled' is a NETWORK event (no bytes for ~3s) and fires routinely on a
    // live mount while playback continues from buffer, so no second 'playing' is
    // coming. Arm the watchdog only (#1232).
    const onStalled = () => {
      armWatchdog(5000);
    };
    // timeupdate fires only while the clock actually moves, so it reconciles a status left
    // on 'connecting' by event sequences the handlers above don't model.
    const onTimeUpdate = () => {
      if (!isLive() || el.paused || el.readyState < HAVE_FUTURE_DATA) return;
      setStatus(s => (s === 'connecting' ? 'playing' : s));
    };
    const onError = () => {
      if (!el.error || audioRef.current !== el) return;
      if (!isLive()) {
        // If local decoding fails, release the workaround and stay disconnected.
        if (pausedMediaUrl.current) unloadAudio(el);
        return;
      }
      setStatus('idle');
      // A failing Opus mount (commonly a 404 when Opus is off server-side) falls back
      // permanently to MP3 rather than reconnecting to the dead URL on every retry.
      const { mp3, opus } = streamsRef.current;
      if (opus && streamUrlRef.current === opus) {
        opusFailedRef.current = true;
        streamUrlRef.current = mp3;
        setStreamUrl(mp3);
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount.current, RECONNECT_MAX_MS);
      retryCount.current += 1;
      armWatchdog(delay);
    };
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('stalled', onStalled);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('error', onError);
    return () => {
      clearWatchdog();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onStalled);
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('error', onError);
    };
  }, [audioEl, clearWatchdog, unloadAudio]);

  // Idle cutoff (#343): a tab with no activity for IDLE_TUNE_OUT_MS is tuned out
  // so it doesn't sit on the mount as a phantom listener. Sweeps once a minute.
  useEffect(() => {
    const markActivity = () => { lastActivityAt.current = Date.now(); };
    markActivity(); // seed: mount counts as the start of the idle window
    const onVisibility = () => {
      if (document.visibilityState === 'visible') markActivity();
    };
    window.addEventListener('pointerdown', markActivity);
    window.addEventListener('keydown', markActivity);
    document.addEventListener('visibilitychange', onVisibility);
    const sweep = setInterval(() => {
      if (!tunedInRef.current) return;
      if (Date.now() - lastActivityAt.current < IDLE_TUNE_OUT_MS) return;
      setIdleStopped(true);
      stopRef.current();
    }, IDLE_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(sweep);
      window.removeEventListener('pointerdown', markActivity);
      window.removeEventListener('keydown', markActivity);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Full teardown for OS Stop, the idle cutoff and element removal.
  const stop = () => {
    ++gen.current;
    tunedInRef.current = false;
    clearWatchdog();
    setPlaybackState('none');
    setStatus('idle');
    if (audioRef.current) unloadAudio(audioRef.current);
    else releasePausedMedia();
  };
  stopRef.current = stop;

  const pause = () => {
    if (!tunedInRef.current) return;
    ++gen.current;
    tunedInRef.current = false;
    clearWatchdog();
    setPlaybackState('paused');
    setStatus('idle');
    const el = audioRef.current;
    if (!el) return;
    // Never wait for play(): a connecting stream may leave that promise pending.
    // Swapping source cancels it and closes the live connection, even mid-tune.
    el.pause();
    const localUrl = createPausedMediaUrl(el);
    if (localUrl) {
      pausedMediaUrl.current = localUrl;
      el.src = localUrl;
      el.load();
      // Deliberately no play(), autoplay or loop on the silent clip.
    } else {
      unloadAudio(el);
    }
  };

  const play = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    // A system interruption can pause the native element without delivering our
    // OS pause command. Play must rejoin live in that case too.
    if (tunedInRef.current && !el.paused) return;
    const myGen = ++gen.current;
    // A fresh tune-in is listener activity: restart the idle window, clear the idle prompt, reset backoff.
    lastActivityAt.current = Date.now();
    setIdleStopped(false);
    retryCount.current = 0;
    clearWatchdog();
    el.src = freshStreamUrl(streamUrlRef.current, myGen);
    el.load();
    releasePausedMedia();
    el.volume = volume;
    // Commands and event handlers read this synchronously, including repeated
    // media-session presses before React has committed the next render.
    tunedInRef.current = true;
    setPlaybackState('playing');
    setStatus('connecting');
    const p = el.play();
    Promise.resolve(p).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (gen.current === myGen && name !== 'AbortError') {
        // Decoder/network errors belong to onError's retry/Opus fallback path.
        // A gesture refusal cannot recover unattended, so release the stream.
        if (name === 'NotAllowedError') stop();
        console.error('Play failed:', err);
      }
    });
  };

  // Skin buttons and keyboard shortcuts toggle; OS commands never toggle.
  const tune = () => {
    if (tunedInRef.current) pause();
    else play();
  };

  // Mute is volume 0; toggling restores the last non-zero level.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  return { audioRef, attachAudio, tunedIn, playbackState, status, volume, setVolume, tune, play, pause, stop, toggleMute, muted: volume === 0, idleStopped };
}
