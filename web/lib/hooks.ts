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
  /** AudioContext sample rate in Hz — null until the graph exists. Callers
   *  mapping bins to frequencies need it (44.1k vs 48k shifts every bin). */
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
// createMediaElementSource permanently captures the element's output (a
// second call throws, and tearing the graph down would mute playback), and
// skins now mount and unmount visualisers against the same shared <audio>
// element — so a later hook instance must REUSE the first one's graph. This
// is what keeps real spectrum data flowing after a skin switch instead of
// every subsequent visualiser falling back to the pseudo-random walk, and
// stops each remount from leaking a fresh AudioContext on the failed
// re-capture.
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
    // 1024-point FFT (512 bins). The Waveform's log-frequency sweep needs
    // low-end resolution — at 256 the whole bottom two octaves collapsed
    // into two bins. Reading 512 bins per paint is still trivial.
    analyser.fftSize = 1024;
    // Light smoothing only: the old 0.78 stacked on the spans' 60 ms CSS
    // transitions left bars trailing the beat by ~100 ms. The canvas
    // renderer has no second smoothing layer, so this is the whole lag.
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const graph: ElementAudioGraph = { ctx, analyser };
    ELEMENT_GRAPHS.set(audioEl, graph);
    return graph;
  } catch (err) {
    // Capture failed (element claimed outside this hook) — don't leave an
    // idle AudioContext behind on every attempt.
    void ctx.close().catch(() => {});
    throw err;
  }
}

// Web Audio analyser hook — wires an AnalyserNode to the given <audio> ref
// the first time `active` flips true, then writes per-frame frequency bytes
// into an internal ref read via `read()`. Returns `{ ready, read, sampleRate }`.
// If CORS or anything else blocks attachment, `ready` stays false and `read()`
// returns null — the Waveform falls back to its pseudo-random walk.
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
  const analyserRef = useRef<AnalyserNode | null>(null);
  const binsRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const probedRef = useRef(false);
  const [ready, setReadyState] = useState(false);
  const [sampleRate, setSampleRate] = useState<number | null>(null);
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
        const graph = getOrCreateElementGraph(audioEl);
        if (!graph) return; // no Web Audio in this browser
        analyserRef.current = graph.analyser;
        binsRef.current = new Uint8Array(graph.analyser.frequencyBinCount);
        setSampleRate(graph.ctx.sampleRate);
        if (graph.ctx.state === 'suspended') await graph.ctx.resume();
        if (cancelled) return;
        setReady(true);

        // Some non-iOS WebKit builds (e.g. desktop Safari on a live MP3 mount)
        // also wire the graph up but only ever return zeros. Probe once after
        // playback starts — if no samples land in ~600 ms, flip ready=false so
        // the pseudo-random walk fallback takes over.
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
                // No usable data. Fall back to the pseudo-random walk, but
                // DON'T disconnect — the source feeds the speakers through this
                // graph, so tearing it down would mute playback. An idle
                // analyser in the chain is transparent.
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
