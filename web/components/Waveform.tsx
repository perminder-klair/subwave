'use client';

import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import { useAnalyser } from '@/lib/hooks';
import { pollWhileVisible } from '@/lib/poll';
import { cn } from '@/lib/cn';

const BARS = 120;

export interface WaveformProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  /** Epoch ms when the current track started (from useStationFeed). */
  trackStartedAt: number | null;
  /** Track length in seconds — 0/undefined parks the progress split at 0. */
  duration: number;
}

export default memo(function Waveform({ audioRef, tunedIn, trackStartedAt, duration }: WaveformProps) {
  const { ready, read } = useAnalyser(audioRef, tunedIn);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // Progress is derived locally and quantised to whole bars, so this component
  // re-renders only when another bar should flip colour (~every few seconds),
  // not on a 1s elapsed tick.
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

  // Drive real-analyser bars via rAF when available; otherwise the fallback
  // effect below paints heights from a pseudo-random walk. Bar heights are
  // written via DOM mutation in both paths so the component stays free of
  // inline style props (issue #50) and free of per-frame React renders.
  useEffect(() => {
    if (!ready || !tunedIn) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    const tick = () => {
      const bins = read();
      const container = containerRef.current;
      if (bins && container) {
        const spans = container.querySelectorAll<HTMLSpanElement>('[data-bar]');
        const step = Math.max(1, Math.floor(bins.length / BARS));
        for (let i = 0; i < spans.length; i++) {
          const v = (bins[Math.min(bins.length - 1, i * step)] ?? 0) / 255;
          const span = spans[i];
          if (span) span.style.height = `${10 + Math.pow(v, 0.7) * 95}%`;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [ready, tunedIn, read]);

  // Fallback when the real analyser can't attach — notably iOS Safari, where
  // createMediaElementSource on a live HTTP MP3 stream returns silence (WebKit
  // limitation). A pseudo-random walk is written straight to the spans: no
  // React state, so a fallback session costs zero renders, and the interval
  // pauses while the tab is hidden.
  useEffect(() => {
    if (ready || !tunedIn) return;
    const container = containerRef.current;
    if (!container) return;
    const spans = container.querySelectorAll<HTMLSpanElement>('[data-bar]');
    const levels: number[] = Array(spans.length).fill(0.1);
    return pollWhileVisible(() => {
      for (let i = 0; i < spans.length; i++) {
        const target = Math.pow(Math.random(), 1.4) * (1 - i / (spans.length * 2.2));
        const next = (levels[i] ?? 0.1) + (target - (levels[i] ?? 0.1)) * 0.45;
        levels[i] = next;
        const span = spans[i];
        if (span) span.style.height = `${10 + Math.pow(next, 0.7) * 95}%`;
      }
    }, 60);
  }, [ready, tunedIn]);

  const usingReal = ready && tunedIn;

  return (
    <div
      ref={containerRef}
      // Horizontal footprint is width-based (sm:). The tall band, however, is
      // gated on viewport HEIGHT too — a short/wide window kept the full-height
      // band and left no room above it, so the now-playing block overlapped it
      // (issue #576). Below 760px tall we fall back to the compact band so the
      // CenterStage region has room to clear it.
      className="pointer-events-none absolute inset-x-3 bottom-24 flex h-[110px] items-center gap-px px-1 opacity-[0.22] sm:right-24 sm:left-0 sm:gap-0.5 sm:px-8 [@media(min-width:640px)_and_(min-height:760px)]:bottom-[128px] [@media(min-width:640px)_and_(min-height:760px)]:h-40"
      aria-hidden="true"
    >
      {Array.from({ length: BARS }).map((_, i) => {
        const past = i < pastBars;
        return (
          <span
            key={i}
            data-bar
            className={cn(
              'h-[10%] flex-1',
              past ? 'bg-vermilion' : 'bg-ink',
              usingReal && '[transition:height_60ms_linear]',
            )}
          />
        );
      })}
    </div>
  );
});
