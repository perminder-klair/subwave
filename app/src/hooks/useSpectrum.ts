// Pseudo-random animated spectrum — the waveform's data source on native.
//
// Ported from web/web/lib/hooks.ts `useSpectrum`. On the web this is the
// FALLBACK used when the real Web Audio analyser can't attach (iOS Safari,
// CORS). Native has no equivalent stream tap at all, so this IS the source —
// which is honest parity, since iOS web already shows these same bars.
// Values in [0, 1].

import { useEffect, useState } from 'react';

export function useSpectrum(bins = 120, active = true, speed = 60): number[] {
  const [arr, setArr] = useState<number[]>(() => Array(bins).fill(0.1));
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setArr((prev) =>
        prev.map((v, i) => {
          const target = Math.pow(Math.random(), 1.4) * (1 - i / (bins * 2.2));
          return v + (target - v) * 0.45;
        }),
      );
    }, speed);
    return () => clearInterval(id);
  }, [active, bins, speed]);
  return arr;
}
