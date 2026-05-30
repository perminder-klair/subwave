'use client';

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';

// We pick MP3 vs Ogg-Opus on the client via canPlayType — Opus is roughly
// equal-or-better quality at half the bandwidth on browsers that decode it.
//
// `NEXT_PUBLIC_STREAM_URL` is the build-time host override (dev points the
// player at `http://localhost:7702/stream.mp3` because Icecast isn't on the
// web origin there). It used to pin a single URL; now it pins the *host* and
// we swap the path between `/stream.mp3` and `/stream.opus` on the same host.
// Operators who pointed it at a non-standard URL that doesn't end in
// `/stream.mp3` still get it verbatim (opus is null → codec detection off).
const STREAM_URL_OVERRIDE = process.env.NEXT_PUBLIC_STREAM_URL || '';
const MP3_PATH = '/stream.mp3';
const OPUS_PATH = '/stream.opus';

function resolveStreamUrls(): { mp3: string; opus: string | null } {
  if (!STREAM_URL_OVERRIDE) return { mp3: MP3_PATH, opus: OPUS_PATH };
  const idx = STREAM_URL_OVERRIDE.lastIndexOf(MP3_PATH);
  if (idx === -1) return { mp3: STREAM_URL_OVERRIDE, opus: null };
  const before = STREAM_URL_OVERRIDE.slice(0, idx);
  const after = STREAM_URL_OVERRIDE.slice(idx + MP3_PATH.length);
  return { mp3: STREAM_URL_OVERRIDE, opus: `${before}${OPUS_PATH}${after}` };
}

const { mp3: MP3_STREAM_URL, opus: OPUS_STREAM_URL } = resolveStreamUrls();

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
}

export interface UsePlayerOptions {
  initialVolume?: number;
}

// Owns the <audio> element + tune-in state. The audioRef must be attached to
// an <audio> tag rendered by the consumer (so the Waveform's Web Audio API
// can also reach it).
export function usePlayer({ initialVolume = 1 }: UsePlayerOptions = {}): Player {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Resolved at mount via canPlayType. SSR + first render use the MP3 URL so
  // server and client markup agree; the useEffect below upgrades to Opus when
  // the browser confirms it can decode it.
  const [streamUrl, setStreamUrl] = useState<string>(MP3_STREAM_URL);
  const [tunedIn, setTunedIn] = useState(false);
  // 'idle' | 'connecting' | 'playing'. 'connecting' covers the unavoidable
  // gap between the tune-in gesture and the first audible audio frames —
  // surfaced in the UI so the player doesn't claim to be playing while silent.
  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [volume, setVolume] = useState(initialVolume);
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
  const volumeRef = useRef(volume);
  const watchdogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);
  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
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
    if (!OPUS_STREAM_URL) return;
    const ua = navigator.userAgent;
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    // Desktop/Android Firefox + Gecko forks (LibreWolf, Waterfox) carry
    // "Firefox" in the UA; Firefox-for-iOS reports "FxiOS" and is already
    // caught by isIOS above, so /firefox/i doesn't double-handle it.
    const isFirefox = /firefox/i.test(ua);
    if (isIOS || isFirefox) return;
    const tester = document.createElement('audio');
    const opusOk = tester.canPlayType('audio/ogg; codecs=opus');
    if (opusOk === 'probably') {
      setStreamUrl(OPUS_STREAM_URL);
    }
  }, []);

  // Drive `status` from the <audio> element's own events, and reconnect the
  // stream when the element gets stuck mid-broadcast (the symptom: a few
  // seconds of silence around a track transition that only a page refresh
  // recovers from, because nothing in here was forcing the dead element back
  // onto the live mount). 'playing' clears the watchdog; 'waiting'/'stalled'
  // arm a 5s timer that re-sets src if 'playing' hasn't fired by then;
  // 'error' bypasses the timer and reconnects after 500 ms.
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
      audio.src = `${streamUrlRef.current}?t=${Date.now()}`;
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
      setStatus('playing');
    };
    const onWaiting = () => {
      setStatus(s => (s === 'playing' ? 'connecting' : s));
      armWatchdog(5000);
    };
    const onError = () => {
      setStatus('idle');
      armWatchdog(500);
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

  const tune = () => {
    if (!audioRef.current) return;
    if (tunedIn) {
      stop();
      return;
    }
    const el = audioRef.current;
    const myGen = ++gen.current;
    el.src = `${streamUrl}?t=${Date.now()}`;
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

  return { audioRef, tunedIn, status, volume, setVolume, tune, stop, toggleMute, muted: volume === 0 };
}
