'use client';
// Newsprint radio option used for talk-frequency and script-length pickers.
import type { ReactNode } from 'react';
import { cn } from '../../../lib/cn';

interface RadioOptionProps {
  active: boolean;
  label: ReactNode;
  desc: ReactNode;
  onSelect: () => void;
}

export function RadioOption({ active, label, desc, onSelect }: RadioOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'grid cursor-pointer gap-1.5 border p-3 text-left font-[inherit]',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
          : 'border-ink bg-transparent',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'size-2.5 rounded-full border',
            active
              ? 'border-[var(--accent)] bg-[var(--accent)]'
              : 'border-ink bg-transparent',
          )}
        />
        <span
          className={cn(
            'text-[11px] font-bold tracking-[0.2em] uppercase',
            active ? 'text-vermilion' : 'text-ink',
          )}
        >
          {label}
        </span>
      </div>
      <div className="text-[10px] leading-[1.5] text-muted">{desc}</div>
    </button>
  );
}
