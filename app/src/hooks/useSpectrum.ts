// Synthesised spectrum for the visualizer. There is no real FFT available:
// RNTP exposes no analyser and react-native-audio-api's only reads its own HLS
// node, so the bars are modelled rather than measured (#298 is the same
// problem on the web player).
//
// `active` drives full motion, idle settles to a low shimmer on a slower tick;
// `visible` and app-background pause the simulation entirely. Time is
// accumulated, so the groove is independent of the render cadence (`speed`)
// and resumes cleanly from a pause. Values in [0, 1].

import { useEffect, useRef, useState } from 'react';
import { useAppActive } from '@/hooks/useAppActive';

// Low-resolution random curve interpolated across all bins, so neighbouring
// bars move together instead of flickering independently.
const CONTROL_POINTS = 18;

const IDLE_TICK_MS = 150;

export function useSpectrum(bins = 120, active = true, speed = 50, visible = true): number[] {
  const [arr, setArr] = useState<number[]>(() => Array(bins).fill(0.06));
  const appActive = useAppActive();
  const running = appActive && visible;

  // Simulation state in refs so ticking it re-renders only via setArr.
  const valuesRef = useRef<number[]>(Array(bins).fill(0.06));
  // Seeded deterministically, no Math.random during render.
  const ctrlRef = useRef<number[]>(
    Array.from({ length: CONTROL_POINTS }, (_, c) => 0.4 + 0.2 * Math.sin(c * 1.3)),
  );
  const ctrlVelRef = useRef<number[]>(Array(CONTROL_POINTS).fill(0));
  const tRef = useRef(0); // accumulated ms, render-rate independent
  const beatPeriodRef = useRef(480); // ms/beat (~125 BPM), drifts slowly
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!running) return;
    const dt = active ? speed : Math.max(speed, IDLE_TICK_MS);
    const id = setInterval(() => {
      const on = activeRef.current;
      tRef.current += dt;
      const t = tRef.current;

      // Beat envelope: a decaying kick per beat plus a softer half-beat ghost,
      // with a drifting tempo so it never feels metronomic.
      beatPeriodRef.current = Math.max(
        420,
        Math.min(560, beatPeriodRef.current + (Math.random() - 0.5) * 4),
      );
      const P = beatPeriodRef.current;
      const phase = (t % P) / P; // 0..1 within a beat
      const kick = Math.exp(-phase * 4.2); // hits at phase 0
      const ghost = Math.exp(-(((phase - 0.5 + 1) % 1) * 6)) * 0.4; // half-beat
      const beat = on ? Math.min(1, kick + ghost) : 0;

      // Slow track-level energy breathing.
      const energy = on
        ? 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(t / 2300)) + 0.1 * Math.sin(t / 770)
        : 0.18;

      // Momentum-damped random walk of the control curve.
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

        // Spectral envelope: bass-heavy, a lower-mid presence bump, treble
        // rolloff.
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
  }, [bins, speed, active, running]);

  return arr;
}
