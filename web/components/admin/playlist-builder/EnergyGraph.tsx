'use client';

import { useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { ARCS, EN_HIGH_BG, EN_LOW_BG, EN_MED_BG } from './types';
import type { ArcShape, DraftTrack } from './types';
import { energyPct } from './generate';
import { Eyeb, energyColor, energyKnown } from './bits';

// Slim per-track bars under a dashed target arc; every bar is a jump-link that
// scrolls its track row into view.

export function EnergyGraph({ tracks, arc, open, onToggle, onBarClick }: {
  tracks: DraftTrack[]; arc: ArcShape; open: boolean; onToggle: () => void; onBarClick: (i: number) => void;
}) {
  const n = tracks.length;
  const arcLabel = ARCS.find(a => a.id === arc)?.label || 'Steady';
  const noneTagged = useMemo(() => tracks.every(t => !energyKnown(t.energy)), [tracks]);
  const targetPts = useMemo(() => {
    const f = (p: number): number => {
      if (arc === 'build') return p;
      if (arc === 'wind-down') return 1 - p;
      if (arc === 'peak-then-cool') return p < 0.6 ? p / 0.6 : 1 - ((p - 0.6) / 0.4) * 0.65;
      return 0.5;
    };
    return tracks.map((_, i) => {
      const p = n > 1 ? i / (n - 1) : 0;
      return `${(i + 0.5).toFixed(2)},${(82 - f(p) * 64).toFixed(2)}`;
    }).join(' ');
  }, [tracks, arc, n]);
  if (n === 0) return null;
  return (
    <div className="flex-none border-b border-separator-soft px-4 sm:px-6">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-7 w-full items-center justify-between gap-3 text-left"
        title={open ? 'collapse the energy strip' : 'expand the energy strip'}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <Eyeb muted>Energy</Eyeb>
          {noneTagged && open && (
            <span className="truncate font-mono text-[9px] text-muted/80">
              untagged — run the library tagger (Library → Tag) to chart the real arc
            </span>
          )}
        </span>
        <span className="flex flex-none items-center gap-3 font-mono text-[9px] text-muted">
          {open && !noneTagged && (
            <>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_LOW_BG)} />low</span>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_MED_BG)} />med</span>
              <span className="hidden items-center gap-1 sm:flex"><span className={cn('inline-block size-2', EN_HIGH_BG)} />high</span>
            </>
          )}
          {open && (
            <span className="flex items-center gap-1">
              <svg width="14" height="8" aria-hidden><line x1="0" y1="4" x2="14" y2="4" stroke="var(--accent-2)" strokeWidth="1.5" strokeDasharray="3 2" /></svg>
              target · {arcLabel}
            </span>
          )}
          {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {open && (
        <div className="relative h-11 pb-1.5">
          <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" className="block h-full w-full">
            {tracks.map((t, i) => {
              const pct = energyPct(t.energy);
              return (
                <rect
                  key={`${t.id}-${i}`}
                  x={(i + 0.1).toFixed(3)}
                  y={(100 - pct).toFixed(2)}
                  width={0.8}
                  height={pct}
                  fill={energyColor(t.energy)}
                  onClick={() => onBarClick(i)}
                  className={cn('cursor-pointer hover:opacity-70', !energyKnown(t.energy) && 'opacity-35')}
                >
                  <title>{i + 1}. {t.title} — {t.artist}</title>
                </rect>
              );
            })}
            <polyline
              points={targetPts}
              fill="none"
              stroke="var(--accent-2)"
              strokeWidth="1.5"
              strokeDasharray="3 2"
              vectorEffect="non-scaling-stroke"
              className="pointer-events-none opacity-80"
            />
          </svg>
        </div>
      )}
    </div>
  );
}


