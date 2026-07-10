'use client';

import { isValidElement, memo, type ReactNode } from 'react';
import { m } from 'motion/react';
import { Settings } from 'lucide-react';
import { cn } from '@/lib/cn';
import OdometerNumber from './OdometerNumber';
import type { PlayerDrawer } from './CommandPalette';

interface RailItem {
  k: PlayerDrawer;
  l: string;
  icon?: ReactNode;
}

const ITEMS: readonly RailItem[] = [
  { k: 'schedule', l: 'Schedule' },
  { k: 'timeline', l: 'Timeline' },
  { k: 'booth',    l: 'Booth' },
  { k: 'request',  l: 'Request' },
  { k: 'audio', l: 'Audio', icon: <Settings size={20} strokeWidth={1.5} /> },
];

export interface DotRailProps {
  /** Counts (or icon nodes) keyed by drawer id. `request` is rendered as "+" regardless. */
  counts?: Partial<Record<PlayerDrawer, ReactNode>>;
  active: PlayerDrawer | null;
  onSelect: (id: PlayerDrawer | null) => void;
}

export default memo(function DotRail({ counts, active, onSelect }: DotRailProps) {
  return (
    <div
      // Slimmed on phones (76px vs 96px) — the reclaimed width goes to the
      // CenterStage text column, whose right reserve tracks these values. The
      // upward bias leaves room for the fifth Audio control above transport.
      className="v3-dot-rail absolute top-16 right-0 bottom-20 z-20 flex w-[76px] flex-col items-center justify-start gap-1 pt-2 sm:top-20 sm:w-24 sm:pt-4"
    >
      {ITEMS.map(item => {
        const isActive = active === item.k;
        const isRequest = item.k === 'request';
        const n: ReactNode = item.icon ?? (isRequest ? '+' : (counts?.[item.k] ?? 0));
        const isIcon = isValidElement(n);
        return (
          <button
            key={item.k}
            onClick={() => onSelect(isActive ? null : item.k)}
            className={cn(
              'v3-dot-rail-item v3-focus relative flex w-full cursor-pointer flex-col items-center gap-[6px] border-0 px-1 py-[14px] font-[inherit] sm:px-2',
              isActive ? 'text-bg' : 'bg-transparent text-ink',
              isRequest && !isActive && 'bg-[rgba(197,48,42,0.08)] shadow-[inset_2px_0_0_var(--accent)]',
            )}
            aria-pressed={isActive}
          >
            {/* Active background morphs between tabs via shared layoutId — same
                trick as the modern dock indicator. Spans below have `relative`
                so they sit above this absolutely-positioned element. */}
            {isActive && (
              <m.span
                layoutId="dot-rail-active"
                className="absolute inset-0 bg-ink"
                initial={false}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'v3-tab-num relative leading-none',
                isRequest ? 'text-[26px] font-semibold' : 'text-[22px] font-extralight',
                isIcon && 'inline-flex h-[22px] items-center justify-center',
                isActive ? 'text-vermilion' : isRequest ? 'text-vermilion' : 'text-ink',
              )}
            >
              {typeof n === 'number' ? <OdometerNumber value={n} /> : n}
            </span>
            <span
              className={cn(
                // Tighter tracking in the slim phone rail so "SCHEDULE" /
                // "TIMELINE" still fit; full spacing from sm up.
                'relative text-[8px] tracking-[0.2em] uppercase sm:text-[9px] sm:tracking-[0.3em]',
                isActive ? 'text-bg' : isRequest ? 'font-bold text-vermilion' : 'text-ink',
              )}
            >
              {item.l}
            </span>
          </button>
        );
      })}
    </div>
  );
});
