'use client';

// The deck's spectrum analyzer — the skin's one canvas element. Real
// frequency data via the shared Web Audio analyser when available; a
// pseudo-random walk when the graph can't attach (iOS, CORS, or a second
// skin claiming the element after classic's Waveform already did — a media
// element only ever gets one MediaElementSource); dead flat while un-tuned.
// Peak caps fall slowly, Winamp-style.

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useAnalyser } from '@/lib/hooks';

const BARS = 12;
const CAP_FALL = 0.006; // per frame, in 0..1 bar heights
const SMOOTH = 0.35;

function themeColors(): { bar: string; cap: string; idle: string } {
  const cs = getComputedStyle(document.documentElement);
  return {
    bar: cs.getPropertyValue('--ink').trim() || '#ece6dc',
    cap: cs.getPropertyValue('--accent').trim() || '#d94b2a',
    idle: cs.getPropertyValue('--muted').trim() || '#8a8278',
  };
}

export default function Analyzer({
  audioRef,
  active,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { ready, read } = useAnalyser(audioRef, active);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let raf = 0;
    let frame = 0;
    let colors = themeColors();
    const vals = new Float32Array(BARS);
    const caps = new Float32Array(BARS);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) { raf = requestAnimationFrame(draw); return; }
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      // Theme tokens can change under us (theme switcher) — refresh ~1/s.
      if (frame++ % 60 === 0) colors = themeColors();

      const bins = active && ready ? read() : null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const gap = 3 * dpr;
      const barW = (canvas.width - gap * (BARS - 1)) / BARS;

      for (let i = 0; i < BARS; i++) {
        let target: number;
        if (bins) {
          // Log-ish sweep: give the low end more bins so kicks read.
          const start = Math.floor(Math.pow(i / BARS, 1.6) * (bins.length * 0.6));
          const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BARS, 1.6) * (bins.length * 0.6)));
          let sum = 0;
          for (let b = start; b < end; b++) sum += bins[b] ?? 0;
          target = (sum / (end - start) / 255) * (1 - i / (BARS * 3));
        } else if (active) {
          // Graph unavailable but we ARE playing — idle walk keeps it alive.
          target = Math.pow(Math.random(), 1.6) * (1 - i / (BARS * 2.2)) * 0.7;
        } else {
          target = 0.03; // un-tuned: dead flat baseline
        }
        const cur = vals[i] ?? 0;
        const next = cur + (target - cur) * SMOOTH;
        vals[i] = next;
        const cap = Math.max((caps[i] ?? 0) - CAP_FALL, next);
        caps[i] = cap;

        const x = i * (barW + gap);
        const barH = Math.max(1, next * canvas.height);
        ctx.fillStyle = active ? colors.bar : colors.idle;
        ctx.fillRect(x, canvas.height - barH, barW, barH);
        const capY = canvas.height - Math.max(cap * canvas.height, 2 * dpr);
        ctx.fillStyle = colors.cap;
        ctx.fillRect(x, capY, barW, 2 * dpr);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, ready, read]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
