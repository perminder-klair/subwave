'use client';

import { memo, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useAnalyser } from '@/lib/hooks';
import { pollWhileVisible } from '@/lib/poll';

const BARS = 120;

// Bars sweep this range logarithmically — equal horizontal distance per octave,
// like hardware spectrum analysers. A linear bin map put >11 kHz on the right
// half of the band, where music carries almost no energy, so most of the strip
// never moved; log spacing gives bass/mids/highs each a visible share.
const FREQ_LO = 50;
const FREQ_HI = 16000;

// Resting bar height as a fraction of the band (the old spans' h-[10%]).
const REST = 0.1;

// Minimum ms between paints. rAF fires at display refresh — 120 Hz+ on
// ProMotion/gaming screens — but the analyser's own smoothing means frames
// ~33 ms apart are visually indistinguishable, at half (or a quarter) the cost.
const FRAME_MS = 30;

// How long the analyser may deliver pure silence (every bin zero) before the
// live loop declares it dead and walks synthetic bars instead. Long enough
// that a genuinely quiet passage can't trip it — the stream never carries
// seconds of digital silence (emergency fallback, bed, encoder noise floor).
const DEAD_MS = 2000;

// One step of the synthetic fallback — same shape as the old span version:
// heavier motion on the left, easing off toward the right edge. Shared by the
// no-analyser fallback interval and the dead-analyser watchdog in the live
// loop.
function stepWalk(levels: Float32Array): void {
  for (let i = 0; i < BARS; i++) {
    const target = Math.pow(Math.random(), 1.4) * (1 - i / (BARS * 2.2));
    levels[i] = (levels[i] ?? 0) + (target - (levels[i] ?? 0)) * 0.45;
  }
}

// Backing-store resolution cap. The band sits at opacity 0.22 behind the
// stage — 3× phone DPR buys nothing visible and triples the pixels cleared
// and filled every paint.
const MAX_DPR = 2;

interface Palette {
  bar: string;
  past: string;
}

// Bar colours come from the theme tokens the old spans used via bg-ink /
// bg-vermilion. Themes apply as inline custom properties on <html> (lib/theme
// applyTheme), so the cached palette is dropped whenever that element's
// attributes change.
function resolvePalette(el: HTMLElement): Palette {
  const cs = getComputedStyle(el);
  const bar = cs.getPropertyValue('--color-ink').trim() || cs.getPropertyValue('--ink').trim();
  const past = cs.getPropertyValue('--color-vermilion').trim() || cs.getPropertyValue('--accent').trim();
  return { bar: bar || '#161412', past: past || '#d94b2a' };
}

// Per-bar [start, end) analyser-bin spans for the log sweep, kept FRACTIONAL.
// At the low end several bars fit inside one FFT bin — with integer spans they
// all read that bin and the strip's left edge moved as one block, so narrow
// spans are sampled by interpolating between neighbouring bins instead (see
// the drive loop). Wide bars (span ≥ 1 bin) average every bin they cover (a
// single sampled bin flickers on narrowband content). Cached by the caller —
// this only changes if the FFT size or context sample rate does.
function buildBinRanges(binCount: number, sampleRate: number): Array<[number, number]> {
  const nyquist = sampleRate / 2;
  const hi = Math.min(FREQ_HI, nyquist);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < BARS; i++) {
    const f0 = FREQ_LO * Math.pow(hi / FREQ_LO, i / BARS);
    const f1 = FREQ_LO * Math.pow(hi / FREQ_LO, (i + 1) / BARS);
    const p0 = Math.min(binCount - 1, Math.max(0, (f0 / nyquist) * binCount));
    const p1 = Math.min(binCount, Math.max(p0, (f1 / nyquist) * binCount));
    ranges.push([p0, p1]);
  }
  return ranges;
}

export interface WaveformProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  /** Epoch ms when the current track started (from useStationFeed). */
  trackStartedAt: number | null;
  /** Track length in seconds — 0/undefined parks the progress split at 0. */
  duration: number;
}

// The band renders on a single <canvas> — one paint per frame instead of 120
// styled spans. The span version spent ~2.8 ms/frame in the rendering pipeline
// (style recalc dominated: every frame retargeted 120 height transitions, then
// re-laid-out the flex row); the same visual on canvas measures ~0.25 ms/frame.
// That headroom is what lets the strip keep running on the Pi-class devices
// lite mode targets.
export default memo(function Waveform({ audioRef, tunedIn, trackStartedAt, duration }: WaveformProps) {
  const { ready, read, sampleRate } = useAnalyser(audioRef, tunedIn);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelsRef = useRef<Float32Array>(new Float32Array(BARS));
  const pastBarsRef = useRef(0);
  const paletteRef = useRef<Palette | null>(null);
  const rangesRef = useRef<{ key: string; ranges: Array<[number, number]> } | null>(null);

  // Calm mode — the listener asked for stillness (prefers-reduced-motion) or
  // low power (html.lite). CSS can't stop a JS animation loop, so the gate has
  // to live here: no rAF, no fallback interval, just a static strip that keeps
  // the progress split legible. Lite toggles live from the theme menu, hence
  // the observer rather than a mount-time read.
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () =>
      setCalm(mq.matches || document.documentElement.classList.contains('lite'));
    update();
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      mq.removeEventListener('change', update);
      mo.disconnect();
    };
  }, []);

  // Progress quantised to whole bars, so state changes ~every few seconds —
  // not on a 1s elapsed tick (same scheme as the span version).
  const [pastBars, setPastBars] = useState(0);
  useEffect(() => {
    if (trackStartedAt == null || duration <= 0) {
      setPastBars(0);
      return;
    }
    return pollWhileVisible(() => {
      const progress = Math.min(1, (Date.now() - trackStartedAt) / 1000 / duration);
      setPastBars(Math.floor(progress * BARS));
    }, 1000);
  }, [trackStartedAt, duration]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) return;
    if (!paletteRef.current) paletteRef.current = resolvePalette(canvas);
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const slot = W / BARS;
    const gap = Math.min(2 * dpr, Math.max(1, slot * 0.25));
    const barW = Math.max(1, slot - gap);
    const levels = levelsRef.current;
    const past = pastBarsRef.current;
    ctx.clearRect(0, 0, W, H);
    // Bars grow symmetrically from the vertical centre (the old items-center
    // look). fillStyle only changes at the progress boundary.
    ctx.fillStyle = past > 0 ? paletteRef.current.past : paletteRef.current.bar;
    for (let i = 0; i < BARS; i++) {
      if (i === past) ctx.fillStyle = paletteRef.current.bar;
      const v = Math.min(1, REST + Math.pow(levels[i] ?? 0, 0.7) * (1 - REST));
      const bh = Math.max(1, v * H);
      ctx.fillRect(i * slot, (H - bh) / 2, barW, bh);
    }
  }, []);

  // Repaint on progress flips; the live loops also read the ref every frame.
  useEffect(() => {
    pastBarsRef.current = pastBars;
    draw();
  }, [pastBars, draw]);

  // Backing store tracks the CSS box (breakpoints swap the band height —
  // issue #576) at capped DPR.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      draw();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  // Theme swaps write custom properties onto <html> — drop the cached palette
  // and repaint. Also repaints on the lite class flip (the calm effect above
  // handles the loop change).
  useEffect(() => {
    const mo = new MutationObserver(() => {
      paletteRef.current = null;
      draw();
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => mo.disconnect();
  }, [draw]);

  // The drive loop, by mode:
  //   calm / not tuned in — one static paint of the resting strip (which is
  //     also what clears stale bar heights after a tune-out);
  //   real analyser — rAF, throttled to ~33 paints/s, log-folded bins, with a
  //     dead-analyser watchdog that walks synthetic bars if every bin stays
  //     zero (see below);
  //   fallback — pseudo-random walk on a 60 ms interval, for engines where
  //     the analyser can't attach: iOS + some desktop-Safari builds return
  //     only zeros from createMediaElementSource on a live MP3 stream
  //     (issues #298/#302). The interval pauses while the tab is hidden;
  //     rAF pauses on its own.
  useEffect(() => {
    const levels = levelsRef.current;
    if (calm || !tunedIn || !ready) {
      levels.fill(0);
      draw();
      if (calm || !tunedIn) return;
      return pollWhileVisible(() => {
        stepWalk(levels);
        draw();
      }, 60);
    }
    let raf = 0;
    let last = 0;
    // Dead-analyser watchdog. Desktop Safari wires the graph up but returns
    // only zeros on a live MP3 mount (#298/#302) — and not always in ways the
    // hook's one-shot 600 ms probe catches: data can blip past the probe and
    // then die, or the probe's `playing` trigger can be missed entirely.
    // Either way the strip would freeze at rest height, so the live loop
    // checks continuously: silence in every bin for DEAD_MS while playing →
    // walk synthetic bars (what iOS always shows); keep reading so the strip
    // snaps back to real data if the analyser ever comes alive.
    let deadSince: number | null = null;
    let lastWalk = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      const bins = read();
      if (!bins) return;
      const key = `${bins.length}:${sampleRate ?? 0}`;
      if (rangesRef.current?.key !== key) {
        rangesRef.current = { key, ranges: buildBinRanges(bins.length, sampleRate ?? 48000) };
      }
      const ranges = rangesRef.current.ranges;
      let live = false;
      for (let b = 0; b < bins.length; b++) {
        if (bins[b]) { live = true; break; }
      }
      if (live) {
        deadSince = null;
      } else {
        if (deadSince == null) deadSince = now;
        if (now - deadSince >= DEAD_MS) {
          // Walk at the fallback interval's cadence, not every paint — the
          // 0.45 lerp is tuned for ~60 ms steps and flickers at 30 ms.
          if (now - lastWalk >= 60) {
            lastWalk = now;
            stepWalk(levels);
            draw();
          }
          return;
        }
      }
      for (let i = 0; i < BARS; i++) {
        const [p0, p1] = ranges[i] ?? [0, 1];
        if (p1 - p0 < 1) {
          // Narrow bar (low end) — lerp the spectrum at the bar's centre so
          // adjacent bars straddling the same bin still differ.
          const c = Math.min(bins.length - 1, (p0 + p1) / 2);
          const b = Math.floor(c);
          const v0 = bins[b] ?? 0;
          const v1 = bins[b + 1] ?? v0;
          levels[i] = (v0 + (v1 - v0) * (c - b)) / 255;
        } else {
          const b0 = Math.floor(p0);
          const b1 = Math.max(b0 + 1, Math.ceil(p1));
          let sum = 0;
          for (let b = b0; b < b1; b++) sum += bins[b] ?? 0;
          levels[i] = sum / ((b1 - b0) * 255);
        }
      }
      draw();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [calm, tunedIn, ready, read, sampleRate, draw]);

  return (
    <div
      // Horizontal footprint is width-based (sm:). The band's vertical shape is
      // gated on viewport HEIGHT too — a short/wide window kept the full-height
      // band and left no room above it, so the now-playing block overlapped it
      // (issue #576). Three shapes: mobile (bottom-24, 110px); short/wide
      // (bottom-32 so the band clears the ~116px transport deck it used to
      // slide under, and a shorter 80px strip); tall/wide (the full 160px
      // band). The two wide variants use mutually exclusive height queries so
      // neither depends on class order to win.
      className="pointer-events-none absolute inset-x-3 bottom-24 h-[110px] px-1 opacity-[0.22] sm:right-24 sm:left-0 sm:px-8 [@media(min-width:640px)_and_(max-height:759px)]:bottom-32 [@media(min-width:640px)_and_(max-height:759px)]:h-20 [@media(min-width:640px)_and_(min-height:760px)]:bottom-[128px] [@media(min-width:640px)_and_(min-height:760px)]:h-40"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="h-full w-full" />
    </div>
  );
});
