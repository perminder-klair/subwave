// Synthesised "musical" spectrum — the native visualizer's data source.
//
// Native can't tap the live MP3 stream for a real FFT: react-native-track-player
// exposes no analyser, and react-native-audio-api's analyser only reads its own
// HLS StreamerNode (SUB/WAVE serves a raw Icecast MP3 mount). So, exactly as the
// WEB player does on iOS (issue #298, where Web Audio yields silence on a live
// MP3), we synthesise the bars. But where the old port emitted per-bin white
// noise — the flat "random pattern" — this models how a real music spectrum
// actually moves, so it reads as reacting to the track:
//
//   * a bass-heavy spectral envelope with a gentle mid-presence bump,
//   * neighbouring bins that move together (a low-res control curve, not
//     independent noise), so the shape ripples instead of flickering,
//   * a kick/beat envelope that swells the low end on a drifting ~125 BPM pulse,
//   * slow track-level "breathing" so energy builds and drops over time,
//   * asymmetric attack/decay (fast rise, slow fall) like an AnalyserNode's
//     smoothingTimeConstant.
//
// `active` (tuned in) drives full motion; idle it settles to a calm low shimmer.
// The simulation is time-accumulated, so its groove is independent of the React
// re-render cadence (`speed`). Values in [0, 1].

import { useEffect, useRef, useState } from 'react';

// Low-resolution random curve, linearly interpolated across all bins — this is
// what correlates neighbouring bars instead of letting each flicker on its own.
const CONTROL_POINTS = 18;

export function useSpectrum(bins = 120, active = true, speed = 50): number[] {
  const [arr, setArr] = useState<number[]>(() => Array(bins).fill(0.06));

  // Simulation state kept in refs so ticking it never triggers a re-render on
  // its own — only the final setArr does.
  const valuesRef = useRef<number[]>(Array(bins).fill(0.06));
  // Seeded deterministically (no impure Math.random during render); the
  // momentum random-walk in the tick diverges it within a few frames anyway.
  const ctrlRef = useRef<number[]>(
    Array.from({ length: CONTROL_POINTS }, (_, c) => 0.4 + 0.2 * Math.sin(c * 1.3)),
  );
  const ctrlVelRef = useRef<number[]>(Array(CONTROL_POINTS).fill(0));
  const tRef = useRef(0); // ms since mount (accumulated — render-rate independent)
  const beatPeriodRef = useRef(480); // ms/beat (~125 BPM), drifts slowly
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const dt = speed;
    const id = setInterval(() => {
      const on = activeRef.current;
      tRef.current += dt;
      const t = tRef.current;

      // --- beat envelope: a kick on every beat (decaying), plus a softer
      // half-beat ghost. Drift the tempo so it never feels metronomic. ---
      beatPeriodRef.current = Math.max(
        420,
        Math.min(560, beatPeriodRef.current + (Math.random() - 0.5) * 4),
      );
      const P = beatPeriodRef.current;
      const phase = (t % P) / P; // 0..1 within a beat
      const kick = Math.exp(-phase * 4.2); // hits at phase 0
      const ghost = Math.exp(-(((phase - 0.5 + 1) % 1) * 6)) * 0.4; // half-beat
      const beat = on ? Math.min(1, kick + ghost) : 0;

      // --- slow track-level energy "breathing" (builds and drops) ---
      const energy = on
        ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t / 2300)) + 0.1 * Math.sin(t / 770)
        : 0.18;

      // --- random-walk the control curve (momentum-damped for smooth drift) ---
      const ctrl = ctrlRef.current;
      const vel = ctrlVelRef.current;
      const jitter = on ? 0.22 : 0.05;
      for (let c = 0; c < CONTROL_POINTS; c++) {
        vel[c] = vel[c] * 0.82 + (Math.random() - 0.5) * jitter;
        ctrl[c] = Math.max(0, Math.min(1, ctrl[c] + vel[c]));
      }

      const next = valuesRef.current;
      const lastBin = bins - 1;
      for (let i = 0; i < bins; i++) {
        const f = lastBin > 0 ? i / lastBin : 0; // 0 (bass) .. 1 (treble)

        // Spectral envelope: bass-heavy, a presence bump in the lower-mids, and
        // a treble rolloff — the rough shape of most music on a log-ish meter.
        const bass = Math.pow(1 - f, 1.35);
        const presence = 0.35 * Math.exp(-Math.pow((f - 0.32) / 0.18, 2));
        const shape = 0.12 + bass * 0.9 + presence;

        // Correlated noise sampled from the control curve.
        const cp = f * (CONTROL_POINTS - 1);
        const c0 = Math.floor(cp);
        const c1 = Math.min(CONTROL_POINTS - 1, c0 + 1);
        const frac = cp - c0;
        const noise = ctrl[c0] * (1 - frac) + ctrl[c1] * frac;

        // The kick lifts mostly the low end; the highs shimmer on their own.
        const beatGain = beat * (0.85 * (1 - f) + 0.15);
        const shimmer = f > 0.55 ? 0.22 * (0.5 + 0.5 * Math.sin(t / 90 + i)) : 0;

        let target = shape * energy * (0.45 + 0.55 * noise) + beatGain * shape + shimmer * energy;
        target = Math.max(0, Math.min(1, target));

        // Asymmetric smoothing: fast attack, slow release.
        const v = next[i];
        next[i] = v + (target - v) * (target > v ? 0.55 : 0.16);
      }

      setArr(next.slice());
    }, dt);
    return () => clearInterval(id);
  }, [bins, speed]);

  return arr;
}
