'use client';

// Small shared atoms for the schedule page — the design-system patterns the
// Rundown repeats everywhere: colour chips, the underlined "slot" dropdown
// (an inline editable value in a sentence), segmented text buttons, and the
// M T W T F S S day pills.

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

export interface SlotOption {
  key: string;
  label: ReactNode;
  chipColor?: string | null;
}

/** The sentence-editor "slot": an underlined bold-mono value with a ▾ caret
 *  that opens a menu of options. Reads as a word in the sentence. */
export function SlotMenu({
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
  options: SlotOption[];
  onSelect: (key: string) => void;
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
            <DropdownMenuItem key={o.key} onClick={() => onSelect(o.key)}>
              {o.chipColor !== undefined && <ColorChip color={o.chipColor} />}
              {o.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Segmented text button (the spSeg pattern) — mono caps, ink fill when on. */
export function SegBtn({
  on,
  onClick,
  children,
  title,
}: {
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={cn(
        'cursor-pointer border px-2.5 py-[5px] font-mono text-[10px] font-bold tracking-[0.2em] uppercase',
        on
          ? 'border-ink bg-ink text-bg'
          : 'border-separator-strong bg-transparent text-muted hover:border-ink hover:text-ink',
      )}
    >
      {children}
    </button>
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
              'flex size-[17px] cursor-pointer items-center justify-center border font-mono text-[8px] font-bold',
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

/** Muted mono micro-label (the spMu pattern). */
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
