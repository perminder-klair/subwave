'use client';

// Real frequency data via the shared Web Audio analyser (graph cached per
// <audio> element); a pseudo-random walk when it can't attach (iOS, CORS, no
// Web Audio); dead flat while un-tuned. Only a playing meter loops, at ~30 fps:
// un-tuned is one still baseline and lite mode one static frame -- the global
// CSS animation kill can't reach a canvas -- each repainted only on a resize or
// a theme change, so an idle deck spends no frames.

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useAnalyser } from '@/lib/hooks';
import { useLiteMode } from '@/hooks/useLiteMode';
import {
  createColorProbe,
  readThemeRgb,
  THEME_RGB_FALLBACK,
  watchTheme,
  type Rgb,
  type ThemeRgb,
} from '@/lib/theme-rgb';
import { BARS, FRAME_60_MS, stepMeter } from './meter';

/** Un-tuned bar height, in 0..1 of the canvas. */
const BASELINE = 0.03;

// Minimum ms between paints, as in classic/Waveform: rAF fires at display
// refresh, and the meter reads the same at ~30 fps. stepMeter keeps its speed.
const FRAME_MS = 30;

interface Palette {
  bar: string;
  cap: string;
  idle: string;
}

const css = ([r, g, b]: Rgb) => `rgb(${r}, ${g}, ${b})`;

function palette(t: ThemeRgb): Palette {
  // Peak caps ride --accent-2 where a theme sets one, else accent.
  return { bar: css(t.ink), cap: css(t.accent2), idle: css(t.muted) };
}

export default function Analyzer({
  audioRef,
  active,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { lite } = useLiteMode();
  // The lite static frame never reads the graph, so don't attach it at all.
  const { ready, read } = useAnalyser(audioRef, active && !lite);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const probe = createColorProbe();
    const readColors = () => palette(probe ? readThemeRgb(canvas, probe) : THEME_RGB_FALLBACK);
    let colors = readColors();
    const vals = new Float32Array(BARS);
    const caps = new Float32Array(BARS);
    const targets = new Float32Array(BARS);
    const loops = active && !lite;
    if (!loops) {
      vals.fill(BASELINE);
      caps.fill(BASELINE);
    }
    let raf = 0;
    let last = 0;

    // Backing store at device resolution; false until the canvas has laid out.
    const fit = (): boolean => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w === 0 || h === 0) return false;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      return true;
    };

    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const { width: W, height: H } = canvas;
      ctx.clearRect(0, 0, W, H);
      const gap = 3 * dpr;
      const barW = (W - gap * (BARS - 1)) / BARS;
      for (let i = 0; i < BARS; i++) {
        const x = i * (barW + gap);
        ctx.fillStyle = active ? colors.bar : colors.idle;
        if (lite) {
          // The lite still: a baseline with its cap resting just above it.
          const base = Math.max(1, BASELINE * H);
          ctx.fillRect(x, H - base, barW, base);
          ctx.fillStyle = colors.cap;
          ctx.fillRect(x, H - 2 * dpr - base, barW, 2 * dpr);
          continue;
        }
        const barH = Math.max(1, (vals[i] ?? 0) * H);
        ctx.fillRect(x, H - barH, barW, barH);
        const capY = H - Math.max((caps[i] ?? 0) * H, 2 * dpr);
        ctx.fillStyle = colors.cap;
        ctx.fillRect(x, capY, barW, 2 * dpr);
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (!fit()) {
        raf = requestAnimationFrame(frame);
        return;
      }
      if (!loops) {
        paint();
        return;
      }
      if (last && now - last < FRAME_MS) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const bins = ready ? read() : null;
      for (let i = 0; i < BARS; i++) {
        if (bins) {
          // Log-ish sweep, weighted to the low end so kicks read.
          const start = Math.floor(Math.pow(i / BARS, 1.6) * (bins.length * 0.6));
          const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BARS, 1.6) * (bins.length * 0.6)));
          let sum = 0;
          for (let b = start; b < end; b++) sum += bins[b] ?? 0;
          targets[i] = (sum / (end - start) / 255) * (1 - i / (BARS * 3));
        } else {
          // Graph unavailable but playing — walk so the meter isn't frozen.
          targets[i] = Math.pow(Math.random(), 1.6) * (1 - i / (BARS * 2.2)) * 0.7;
        }
      }
      stepMeter(vals, caps, targets, last ? now - last : FRAME_60_MS);
      last = now;
      paint();
      raf = requestAnimationFrame(frame);
    };

    // A still frame has no loop to pick up a new size or theme, so either one
    // asks for a paint; a running loop already has one queued.
    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    wake();
    const ro = new ResizeObserver(wake);
    ro.observe(canvas);
    const unwatch = watchTheme(() => {
      colors = readColors();
      wake();
    });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unwatch();
    };
  }, [active, ready, read, lite]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden="true" />;
}
