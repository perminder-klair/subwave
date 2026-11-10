'use client';


import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SectionTab {
  id: string;
  label: string;
  count?: number;
  icon: LucideIcon;
}

// 4+ tabs drop to a 2-col grid on phones: one row of long uppercase labels
// overflows a ~390px screen.
const COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-4',
  5: 'grid-cols-2 sm:grid-cols-5',
  6: 'grid-cols-3 sm:grid-cols-6',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function SectionTabs({
  tabs, value, onChange, label,
}: {
  tabs: SectionTab[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  // When the grid wraps, dividers must follow it: left rule on the right
  // column, top rule on the second row.
  const wraps = tabs.length >= 4;
  return (
    <nav
      className={cn('grid border-t border-ink', COLS[tabs.length] ?? 'grid-cols-2 sm:grid-cols-4')}
      role="tablist"
      aria-label={label}
    >
      {tabs.map((t) => {
        const active = value === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              'relative flex cursor-pointer items-center justify-center gap-2 px-2 py-[17px] transition-colors sm:gap-2.5 sm:px-3 sm:py-[19px]',
              wraps
                ? 'border-ink max-sm:even:border-l sm:[&:not(:first-child)]:border-l max-sm:[&:nth-child(n+3)]:border-t'
                : 'border-ink [&:not(:first-child)]:border-l',
              active ? 'bg-ink text-bg' : 'text-ink hover:bg-[var(--ink-soft)]',
            )}
          >
            {active && (
              <span className="absolute -top-px -right-px -left-px h-1 bg-[var(--accent)]" aria-hidden />
            )}
            <Icon size={16} strokeWidth={2} aria-hidden />
            <span className="font-mono text-[11px] font-bold tracking-[0.1em] uppercase sm:text-[12px] sm:tracking-[0.16em]">
              {t.label}
            </span>
            {t.count != null && (
              <span className="min-w-[14px] border border-current px-1.5 py-[2px] text-center font-mono text-[10px] leading-none font-bold">
                {pad2(t.count)}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
