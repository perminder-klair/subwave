'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { isIOSDevice } from '@/lib/platform';
import { useStationOrigin } from '@/lib/stationOrigin';
import { withStreamAuth } from '@/lib/stationAuth';
import { loadVolumePref, saveVolumePref } from '@/lib/volume';

// We pick MP3 vs Ogg-Opus on the client via canPlayType — Opus is roughly
// equal-or-better quality at half the bandwidth on browsers that decode it.
//
// The mount URLs come from StationOriginContext (env defaults when no
// provider; a remote station's host when the landing showcase tabs over).
// Consumers that retarget the player remount it (key) — the hook still
// mirrors the URLs into a ref so the long-lived watchdog listeners read
// fresh values either way.

// Reconnect backoff for the watchdog's error path. The first retry stays
// quick (a blip mid-broadcast should recover in half a second), but repeated
// failures double the delay up to a minute — an abandoned tab pointed at a
// downed station must not hammer reconnects twice a second all night.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 60_000;

// Idle cutoff (issue #343). A forgotten tab/PWA stays connected to the live
// mount forever, counting as a listener and keeping the DJ's pause-when-empty
// gate open 24/7. After this long with zero listener activity (no pointer,
// no key, no tab focus) we tune out; the consumer surfaces a one-tap resume
// via `idleStopped`. 8h clears a full untouched workday of listening while
// still catching an abandoned tab on its first evening.
const IDLE_TUNE_OUT_MS = 8 * 60 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60_000;

export type PlayerStatus = 'idle' | 'connecting' | 'playing';

export interface Player {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  status: PlayerStatus;
  volume: number;
  setVolume: Dispatch<SetStateAction<number>>;
  tune: () => void;
  stop: () => void;
  toggleMute: () => void;
  muted: boolean;
  // True when the idle cutoff (not the listener) tore playback down — the
  // consumer should explain why and offer a one-tap resume. Cleared on the
  // next tune().
  idleStopped: boolean;
  /** Measured seconds-behind-the-live-edge of THIS tab's audio, in ms, or
   *  null when the tab isn't audibly playing the stream. buffered.end is the
   *  freshest audio the connection has delivered (≈ the live edge, since
   *  Icecast serves in real time after the connect burst), so end − currentTime
   *  is exactly how far behind it this listener's ears are — whatever mount
   *  they're on and however much of the burst they actually got. Stable
   *  identity; safe in effect deps. */
  getListenerLagMs: () => number | null;
}

export interface UsePlayerOptions {
  initialVolume?: number;
}

// Owns the <audio> element + tune-in state. The audioRef must be attached to
// an <audio> tag rendered by the consumer (so the Waveform's Web Audio API
// can also reach it).
export function usePlayer({ initialVolume = 1 }: UsePlayerOptions = {}): Player {
  const { streams } = useStationOrigin();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Resolved at mount via canPlayType. SSR + first render use the MP3 URL so
  // server and client markup agree; the useEffect below upgrades to Opus when
  // the browser confirms it can decode it.
  const [streamUrl, setStreamUrl] = useState<string>(streams.mp3);
  const [tunedIn, setTunedIn] = useState(false);
  // 'idle' | 'connecting' | 'playing'. 'connecting' covers the unavoidable
  // gap between the tune-in gesture and the first audible audio frames —
  // surfaced in the UI so the player doesn't claim to be playing while silent.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolume] = useState(initialVolume);
  const [idleStopped, setIdleStopped] = useState(false);
  const preMuteVolume = useRef(initialVolume || 1);

  // play() resolves asynchronously; pausing before it settles rejects the
  // promise with an AbortError. We hold the latest play() promise and a
  // generation counter so rapid tune/stop toggles (now trivially reachable
  // via the Space/K shortcuts) settle on the last action without spurious
  // errors or a stale teardown clobbering a fresh play.
  const playPromise = useRef<Promise<void> | null>(null);
  const gen = useRef(0);

  // Refs mirror the latest values of state the stall watchdog needs to read,
  // so its event listeners can stay registered once and still see fresh data.
  const tunedInRef = useRef(tunedIn);
  const streamUrlRef = useRef(streamUrl);
  const streamsRef = useRef(streams);
  const volumeRef = useRef(volume);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Consecutive failed reconnects since the last successful 'playing' —
  // drives the exponential backoff in onError.
  const retryCount = useRef(0);
  // Last listener activity (pointer/key/tab-focus/tune), read by the idle
  // sweep. Seeded by the sweep effect at mount (not here — render must stay
  // pure) so a fresh tab gets the full idle window.
  const lastActivityAt = useRef(0);
  // The idle sweep mounts once but must call the latest stop() (defined
  // below, recreated per render) — bridge with a ref.
  const stopRef = useRef<() => void>(() => {});
  // Set once if the optional Opus mount fails to load — pins us to MP3 so the
  // watchdog stops retrying a dead Opus URL (e.g. an operator who disabled the
  // server-side Opus encoder, so /stream.opus 404s).
  const opusFailedRef = useRef(false);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { streamsRef.current = streams; }, [streams]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Restore the listener's last-used volume (issue #783). localStorage is
  // effect-only (never read during render) so SSR + first paint stay on the
  // default and there's no hydration mismatch — the knob snaps to the stored
  // level a tick later, same as the lite-mode toggle. Gate persistence on
  // `hydrated` so this restoring setVolume doesn't race the persist effect.
  const hydratedRef = useRef(false);
  useEffect(() => {
    const stored = loadVolumePref();
    if (stored !== null) {
      setVolume(stored);
      preMuteVolume.current = stored > 0 ? stored : preMuteVolume.current;
    }
    hydratedRef.current = true;
  }, []);

  // Persist volume on change, debounced so a knob drag (dozens of setVolume
  // calls) collapses to one write. The cleanup clears the pending timer on each
  // re-run, so the transient default value the mount pass carries before the
  // restore effect's setVolume lands never actually reaches localStorage.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const id = setTimeout(() => saveVolumePref(volume), 300);
    return () => clearTimeout(id);
  }, [volume]);

  // Pick Opus on browsers that *definitively* decode it (Chrome, Edge — they
  // return 'probably' for Ogg-Opus). Two browser families say they can decode
  // Opus but choke on the live chained Ogg stream Icecast emits at a crossfade
  // boundary, going silent at the first track change with no error/stalled
  // event for the watchdog to catch — so we keep both on the universal MP3
  // 192 kbps mount instead:
  //   • Safari iOS/iPadOS — returns the optimistic 'maybe', and its
  //     AVFoundation Opus decoder can't tolerate the Ogg page-chain boundary.
  //   • Firefox/Gecko — returns 'probably', decodes Opus fine in general, but
  //     its media stack can't follow the chained Ogg stream either (issue #212).
  // Three layers of defence: require 'probably' (drops Safari's 'maybe'), skip
  // iOS-family devices (iPad on iPadOS 13+ reports the desktop Macintosh UA so
  // we also check maxTouchPoints), and skip Firefox by UA.
  useEffect(() => {
    if (!streams.opus || opusFailedRef.current) return;
    const ua = navigator.userAgent;
    // Desktop/Android Firefox + Gecko forks (LibreWolf, Waterfox) carry
    // "Firefox" in the UA; Firefox-for-iOS reports "FxiOS" and is already
    // caught by isIOSDevice() below, so /firefox/i doesn't double-handle it.
    const isFirefox = /firefox/i.test(ua);
    if (isIOSDevice() || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(streams.opus);
    }
  }, [streams.opus]);

  // Drive `status` from the <audio> element's own events, and reconnect the
  // stream when the element gets stuck mid-broadcast (the symptom: a few
  // seconds of silence around a track transition that only a page refresh
  // recovers from, because nothing in here was forcing the dead element back
  // onto the live mount). 'playing' clears the watchdog; 'waiting'/'stalled'
  // arm a 5s timer that re-sets src if 'playing' hasn't fired by then;
  // 'error' reconnects with exponential backoff (500 ms doubling to a 60 s
  // ceiling, reset on the next successful 'playing').
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    const clearWatchdog = () => {
      if (watchdogTimer.current !== null) {
        clearTimeout(watchdogTimer.current);
        watchdogTimer.current = null;
      }
    };

    const reconnect = () => {
      clearWatchdog();
      if (!tunedInRef.current || !audioRef.current) return;
      const audio = audioRef.current;
      const myGen = ++gen.current;
      audio.src = withStreamAuth(`${streamUrlRef.current}?t=${Date.now()}`);
      audio.volume = volumeRef.current;
      setStatus('connecting');
      const p = audio.play();
      playPromise.current = p;
      Promise.resolve(p).catch((err: unknown) => {
        const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
        if (gen.current === myGen && name !== 'AbortError') {
          console.error('Reconnect failed:', err);
        }
      });
    };

    const armWatchdog = (delay: number) => {
      if (!tunedInRef.current) return;
      clearWatchdog();
      watchdogTimer.current = setTimeout(reconnect, delay);
    };

    const onPlaying = () => {
      clearWatchdog();
      retryCount.current = 0;
      setStatus('playing');
    };
    const onWaiting = () => {
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    const onError = () => {
      setStatus('idle');
      // If the optional Opus mount errors (commonly a 404 when the operator
      // has disabled Opus server-side), fall back permanently to the universal
      // MP3 mount rather than reconnecting to the dead Opus URL on every retry.
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
    el.addEventListener('stalled', onWaiting);
    el.addEventListener('error', onError);
    return () => {
      clearWatchdog();
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('stalled', onWaiting);
      el.removeEventListener('error', onError);
    };
  }, []);

  // Idle cutoff (issue #343): a tab left tuned in with no listener activity
  // for IDLE_TUNE_OUT_MS gets tuned out, so an abandoned browser doesn't sit
  // on the mount as a phantom listener (keeping pause-when-empty's DJ gate
  // open around the clock). Activity = pointer, key, or the tab becoming
  // visible; the listener-driven entry points (tune, the consumer's controls)
  // all arrive as pointer/key events anyway. The sweep runs once a minute —
  // hour-scale cutoff, minute-scale precision is plenty.
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

  // Tear down playback. Used by the Tune Out button and by PlayerApp when the
  // station goes off air, so the <audio> element isn't left retrying a dead
  // mount.
  const stop = () => {
    if (!audioRef.current) return;
    const el = audioRef.current;
    const myGen = ++gen.current;
    if (watchdogTimer.current !== null) {
      clearTimeout(watchdogTimer.current);
      watchdogTimer.current = null;
    }
    setTunedIn(false);
    setStatus('idle');
    // Let any in-flight play() settle before pausing, then bail if a later
    // tune() has already superseded this teardown.
    Promise.resolve(playPromise.current)
      .catch(() => {})
      .then(() => {
        if (gen.current !== myGen) return;
        el.pause();
        el.src = '';
      });
  };
  stopRef.current = stop;

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    // A fresh tune-in is listener activity: restart the idle window, clear
    // any pending idle prompt, and let the reconnect backoff start small.
    lastActivityAt.current = Date.now();
    setIdleStopped(false);
    retryCount.current = 0;
    el.src = withStreamAuth(`${streamUrl}?t=${Date.now()}`);
    el.volume = volume;
    setTunedIn(true);
    setStatus('connecting');
    const p = el.play();
    playPromise.current = p;
    Promise.resolve(p).catch((err: unknown) => {
      // AbortError just means a later stop() interrupted this play — benign.
      const name = err && typeof err === 'object' && 'name' in err ? (err as { name?: string }).name : undefined;
      if (gen.current === myGen && name !== 'AbortError') {
        console.error('Play failed:', err);
      }
    });
  };

  // Mute is just volume 0; toggling restores the last non-zero level so the
  // keyboard 'M' shortcut and the command palette have a sensible round-trip.
  const toggleMute = () => {
    if (volume > 0) {
      preMuteVolume.current = volume;
      setVolume(0);
    } else {
      setVolume(preMuteVolume.current || 1);
    }
  };

  // How far behind the live edge this tab's audio actually is. The flat
  // stream.bufferSeconds from /now-playing is only the depth Icecast *tries*
  // to burst on the MP3 mount — the real per-connection lag differs whenever
  // the mount's byte rate differs (Opus/FLAC/AAC), the ring was short at
  // connect, or playback paused and drifted. The element knows the truth:
  // buffered.end − currentTime. Null (→ callers fall back to bufferSeconds)
  // unless this tab is tuned in and audibly playing, since a paused element's
  // stale ranges say nothing about what the viewer is hearing elsewhere.
  const getListenerLagMs = useCallback((): number | null => {
    const el = audioRef.current;
    if (!el || !tunedInRef.current || el.paused) return null;
    try {
      const n = el.buffered.length;
      if (n === 0) return null;
      const lag = el.buffered.end(n - 1) - el.currentTime;
      if (!Number.isFinite(lag) || lag <= 0) return null;
      // Cap at 2 minutes: beyond that the ranges describe a wedged element,
      // not a live listener, and a huge hold would freeze the display.
      return Math.min(lag, 120) * 1000;
    } catch {
      return null;
    }
  }, []);

  return { audioRef, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted: volume === 0, idleStopped, getListenerLagMs };
}
