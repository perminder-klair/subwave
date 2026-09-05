'use client';

// Small shared atoms for the schedule page: colour chips, the underlined "slot"
// dropdown, and the M T W T F S S day pills.

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { DAYS } from './lib';

/** Square show-colour swatch. `color` null renders the silent-hour chip —
 *  transparent with a vermilion hairline. */
export function ColorChip({ color, className }: { color: string | null; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color ?? 'transparent' });
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn(
        'inline-block size-[9px] flex-none',
        color == null && 'border border-[var(--accent)]',
        className,
      )}
    />
  );
}

export interface SlotOption<T extends string | null = string> {
  key: T;
  label: ReactNode;
  chipColor?: string | null;
}

/** The sentence-editor "slot": an underlined value with a ▾ caret opening a menu. */
export function SlotMenu<T extends string | null = string>({
  label,
  chipColor,
  options,
  onSelect,
  disabled,
  ariaLabel,
  className,
}: {
  label: ReactNode;
  /** Set (even to null) to lead the value with a colour chip. */
  chipColor?: string | null;
  options: SlotOption<T>[];
  onSelect: (key: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex cursor-pointer items-center gap-1.5 border-0 border-b-[1.5px] border-solid border-b-ink bg-transparent px-1 pb-0.5 font-mono text-[13px] font-bold tracking-[0.04em] text-ink',
            'hover:border-b-[var(--accent)] hover:text-vermilion',
            'disabled:cursor-default disabled:opacity-50',
            className,
          )}
        >
          {chipColor !== undefined && <ColorChip color={chipColor} />}
          {label}
          <span aria-hidden="true" className="text-[9px] text-muted">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-[9rem] overflow-y-auto">
        <DropdownMenuGroup>
          {options.map(o => (
            <DropdownMenuItem key={o.key ?? '__default__'} onClick={() => onSelect(o.key)}>
              {o.chipColor !== undefined && <ColorChip color={o.chipColor} />}
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The seven M T W T F S S day toggles. `selected` holds storage day keys. */
export function DayPills({
  selected,
  onToggle,
}: {
  selected: number[];
  onToggle: (day: number) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {DAYS.map(d => {
        const on = selected.includes(d.key);
        return (
          <button
            key={d.key}
            type="button"
            aria-pressed={on}
            aria-label={d.name}
            title={d.name}
            onClick={() => onToggle(d.key)}
            className={cn(
              // 7 × 32px + gaps still fits a 390px screen; back to the dense 17px
              // chip from sm up.
              'flex size-8 cursor-pointer items-center justify-center border font-mono text-[10px] font-bold sm:size-[17px] sm:text-[8px]',
              on
                ? 'border-ink bg-ink text-bg'
                : 'border-separator-strong bg-transparent text-muted hover:border-ink hover:text-ink',
            )}
          >
            {d.label[0]}
          </button>
        );
      })}
    </div>
  );
}

/** Weekday / weekend / whole-week presets for the sentence editor's day set.
 *  `selected` is compared as a set, so the matching preset lights up however the
 *  days were chosen. */
export function DayPresets({
  selected,
  onSelect,
}: {
  selected: number[];
  onSelect: (days: number[]) => void;
}) {
  const sets: { label: string; title: string; days: number[] }[] = [
    { label: 'Weekdays', title: 'Monday through Friday', days: [1, 2, 3, 4, 5] },
    { label: 'Weekend', title: 'Saturday and Sunday', days: [6, 0] },
    { label: 'Every day', title: 'All seven days', days: [1, 2, 3, 4, 5, 6, 0] },
  ];
  const same = (a: number[], b: number[]) =>
    a.length === b.length && a.every(d => b.includes(d));
  return (
    <div className="flex gap-1.5">
      {sets.map(s => {
        const on = same(selected, s.days);
        return (
          <button
            key={s.label}
            type="button"
            aria-pressed={on}
            title={s.title}
            onClick={() => onSelect(s.days)}
            className={cn(
              'flex min-h-8 cursor-pointer items-center border px-2 font-mono text-[8px] font-bold tracking-[0.14em] uppercase sm:min-h-[17px]',
              on
                ? 'border-ink bg-ink text-bg'
                : 'border-separator-strong bg-transparent text-muted hover:border-ink hover:text-ink',
            )}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/** Muted mono micro-label. */
export function Mu({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-[9.5px] tracking-[0.16em] text-muted uppercase',
        className,
      )}
    >
      {children}
    </span>
  );
}
