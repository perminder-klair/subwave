'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useInterval } from 'usehooks-ts';
import { isIOSDevice } from './platform';

// SSR-safe iOS flag: false on the server and first client render, real value
// after mount. For branching UI that can't work on iOS (issue #298).
export function useIsIOS(): boolean {
  const [ios, setIos] = useState(false);
  useEffect(() => { setIos(isIOSDevice()); }, []);
  return ios;
}

// Null until mount, same SSR reason as useIsIOS. First tick on mount, then
// useInterval owns the cadence.
export function useClock(): Date | null {
  const [t, setT] = useState<Date | null>(null);
  useEffect(() => { setT(new Date()); }, []);
  useInterval(() => setT(new Date()), 1000);
  return t;
}

export interface Analyser {
  ready: boolean;
  read: () => Uint8Array<ArrayBuffer> | null;
  /** Null until the graph exists. Callers mapping bins to frequencies need it:
   *  44.1k vs 48k shifts every bin. */
  sampleRate: number | null;
}

// Older Safari exposes AudioContext as webkitAudioContext.
type AudioContextCtor = typeof AudioContext;
interface WebkitWindow {
  webkitAudioContext?: AudioContextCtor;
}

interface ElementAudioGraph {
  ctx: AudioContext;
  analyser: AnalyserNode;
}

// One Web Audio graph per media element, for the lifetime of the page.
// createMediaElementSource captures the element permanently — a second call
// throws and a teardown mutes playback — so a later hook instance must reuse
// the first graph rather than re-capture the shared <audio>.
const ELEMENT_GRAPHS = new WeakMap<HTMLMediaElement, ElementAudioGraph>();

/** Existing graph for the element, or a freshly built one. Returns null when
 *  Web Audio is unavailable; throws (after closing the orphan context) when
 *  capture fails, so callers keep their not-ready fallback path. */
function getOrCreateElementGraph(audioEl: HTMLMediaElement): ElementAudioGraph | null {
  const existing = ELEMENT_GRAPHS.get(audioEl);
  if (existing) return existing;
  const AC: AudioContextCtor | undefined =
    window.AudioContext || (window as Window & WebkitWindow).webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const source = ctx.createMediaElementSource(audioEl);
    const analyser = ctx.createAnalyser();
    // 4096-point FFT (2048 bins): the log-frequency sweep needs low-end
    // resolution; at 1024 the bottom octave collapses into one ~47 Hz bin.
    analyser.fftSize = 4096;
    // Only smoothing layer; higher values trail the beat against the CSS transitions.
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const graph: ElementAudioGraph = { ctx, analyser };
    ELEMENT_GRAPHS.set(audioEl, graph);
    return graph;
  } catch (err) {
    // Capture failed (element claimed elsewhere); don't leak an idle AudioContext.
    void ctx.close().catch(() => {});
    throw err;
  }
}

// Wires an AnalyserNode to the <audio> ref the first time `active` flips true.
// On failure `ready` stays false and `read()` returns null, so the Waveform
// falls back to its pseudo-random walk. iOS opts out entirely: the graph only
// yields zeros and routing through Web Audio breaks background playback (#298).
export function useAnalyser(
  audioRef: RefObject<HTMLAudioElement | null> | null | undefined,
  active: boolean,
): Analyser {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const probedRef = useRef(false);
  const [ready, setReadyState] = useState(false);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
  // In a ref so `read`'s identity never changes and the caller's rAF effect holds.
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
        const graph = getOrCreateElementGraph(audioEl);
        if (!graph) return; // no Web Audio in this browser
        analyserRef.current = graph.analyser;
        binsRef.current = new Uint8Array(graph.analyser.frequencyBinCount);
        setSampleRate(graph.ctx.sampleRate);
        if (graph.ctx.state === 'suspended') await graph.ctx.resume();
        if (cancelled) return;
        setReady(true);

        // Some non-iOS WebKit builds wire the graph up but return only zeros.
        // Probe once after playback starts; no samples in ~600ms means fall back.
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
                // Fall back but never disconnect: the source feeds the speakers
                // through this graph, so tearing it down mutes playback.
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

  return { ready, read, sampleRate };
}
