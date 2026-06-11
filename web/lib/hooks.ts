'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { isIOSDevice } from './platform';

// SSR-safe iOS flag. Returns false on the server and the first client render
// (so server and client markup agree and hydration stays clean), then flips to
// the real value after mount. Components use this to branch UI that can't work
// on iOS (e.g. the volume slider — issue #298) without a hydration mismatch.
export function useIsIOS(): boolean {
  const [ios, setIos] = useState(false);
  useEffect(() => { setIos(isIOSDevice()); }, []);
  return ios;
}

export function useClock(): Date | null {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => {
    setT(new Date());
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

export interface Analyser {
  ready: boolean;
  read: () => Uint8Array<ArrayBuffer> | null;
}

// Older Safari exposes AudioContext as webkitAudioContext.
type AudioContextCtor = typeof AudioContext;
interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
}

// Web Audio analyser hook — wires an AnalyserNode to the given <audio> ref
// the first time `active` flips true, then writes per-frame frequency bytes
// into an internal ref read via `read()`. Returns `{ ready, read }`. If CORS
// or anything else blocks attachment, `ready` stays false and `read()` returns
// null — callers should fall back to `useSpectrum`.
//
// iOS is opted out entirely: createMediaElementSource on a live MP3 stream only
// ever yields zeros there, and merely routing the element through Web Audio
// jeopardises lock-screen / background playback. So on iOS we never build the
// graph — the element stays a bare <audio> and the Waveform's pseudo-random
// fallback drives the bars (issue #298).
export function useAnalyser(
  audioRef: RefObject<HTMLAudioElement | null> | null | undefined,
  active: boolean,
): Analyser {
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const probedRef = useRef(false);
  const [ready, setReadyState] = useState(false);
  // Mirror of `ready` read by the stable `read` callback below — keeping it in
  // a ref means `read`'s identity never changes, so the caller's rAF effect
  // doesn't tear down and restart on every render.
  const readyRef = useRef(false);
  const setReady = useCallback((v: boolean) => {
    readyRef.current = v;
    setReadyState(v);
  }, []);

  useEffect(() => {
    if (!active || !audioRef?.current) return;
    // iOS: never touch Web Audio (see hook header). Stay not-ready → fallback.
    if (isIOSDevice()) { setReady(false); return; }
    let cancelled = false;
    const audioEl = audioRef.current;
    let probeInterval: ReturnType<typeof setInterval> | null = null;
    let onPlaying: (() => void) | null = null;
    (async () => {
      try {
        if (!ctxRef.current) {
          const AC: AudioContextCtor | undefined =
            window.AudioContext || (window as Window & WebkitWindow).webkitAudioContext;
          if (!AC) return;
          ctxRef.current = new AC();
        }
        if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
        if (!sourceRef.current) {
          sourceRef.current = ctxRef.current.createMediaElementSource(audioEl);
          analyserRef.current = ctxRef.current.createAnalyser();
          analyserRef.current.fftSize = 256;
          analyserRef.current.smoothingTimeConstant = 0.78;
          sourceRef.current.connect(analyserRef.current);
          analyserRef.current.connect(ctxRef.current.destination);
          binsRef.current = new Uint8Array(analyserRef.current.frequencyBinCount);
        }
        if (cancelled) return;
        setReady(true);

        // Some non-iOS WebKit builds (e.g. desktop Safari on a live MP3 mount)
        // also wire the graph up but only ever return zeros. Probe once after
        // playback starts — if no samples land in ~600 ms, flip ready=false so
        // the pseudo-random useSpectrum fallback takes over.
        if (probedRef.current) return;
        onPlaying = () => {
          if (probedRef.current || cancelled) return;
          probedRef.current = true;
          let max = 0;
          let ticks = 0;
          probeInterval = setInterval(() => {
            if (cancelled) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              return;
            }
            const bins = binsRef.current;
            const an = analyserRef.current;
            if (!bins || !an) return;
            an.getByteFrequencyData(bins);
            for (let i = 0; i < bins.length; i++) {
              const v = bins[i] ?? 0;
              if (v > max) max = v;
            }
            if (++ticks >= 12) {
              if (probeInterval) clearInterval(probeInterval);
              probeInterval = null;
              if (max === 0) {
                // No usable data. Fall back to the pseudo-spectrum, but DON'T
                // disconnect — the source feeds the speakers through this graph,
                // so tearing it down would mute playback. An idle analyser in
                // the chain is transparent.
                setReady(false);
              }
            }
          }, 50);
        };
        audioEl.addEventListener('playing', onPlaying, { once: true });
        if (!audioEl.paused && audioEl.readyState >= 2) onPlaying();
      } catch {
        // CORS or other failure — stay not-ready
      }
    })();
    return () => {
      cancelled = true;
      if (probeInterval) clearInterval(probeInterval);
      if (onPlaying && audioEl) audioEl.removeEventListener('playing', onPlaying);
    };
  }, [active, audioRef, setReady]);

  const read = useCallback((): Uint8Array<ArrayBuffer> | null => {
    if (!readyRef.current || !analyserRef.current || !binsRef.current) return null;
    analyserRef.current.getByteFrequencyData(binsRef.current);
    return binsRef.current;
  }, []);

  return { ready, read };
}
