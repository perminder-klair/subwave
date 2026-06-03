'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { useAnalyser, useSpectrum } from '@/lib/hooks';
import { cn } from '@/lib/cn';

const BARS = 120;

export interface WaveformProps {
  audioRef: RefObject<HTMLAudioElement | null>;
  tunedIn: boolean;
  progress: number;
}

export default function Waveform({ audioRef, tunedIn, progress }: WaveformProps) {
  const { ready, read } = useAnalyser(audioRef, tunedIn);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const fallback = useSpectrum(BARS, tunedIn && !ready, 60);
  const [, force] = useState(0);

  // Drive real-analyser bars via rAF when available; otherwise the fallback
  // effect below paints heights from the pseudo-random spectrum. Bar heights
  // are written via DOM mutation in both paths so the component stays free of
  // inline style props (issue #50).
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

  // Fallback: paint pseudo-random bar heights when the real analyser hasn't
  // attached yet (CORS, iOS Safari, paused stream, etc.).
  useEffect(() => {
    if (ready && tunedIn) return;
    const container = containerRef.current;
    if (!container) return;
    const spans = container.querySelectorAll<HTMLSpanElement>('[data-bar]');
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (span) span.style.height = `${10 + Math.pow(fallback[i] ?? 0.1, 0.7) * 95}%`;
    }
  }, [fallback, ready, tunedIn]);

  // When the real analyser is in charge, suppress the fallback array influence;
  // we still need a single re-render to flip data attributes on mount.
  useEffect(() => { force(x => x + 1); }, [ready, tunedIn]);

  const usingReal = ready && tunedIn;

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-x-3 bottom-24 flex h-[110px] items-center gap-px px-1 opacity-[0.22] sm:right-24 sm:bottom-[128px] sm:left-0 sm:h-40 sm:gap-0.5 sm:px-8"
      aria-hidden="true"
    >
      {Array.from({ length: BARS }).map((_, i) => {
        const past = i / BARS < progress;
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
}
