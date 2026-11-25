'use client';

// "Where is your music?" — the source cards, shared by Admin → Music source
// and the onboarding wizard. Utilities only (no admin-root helpers), because
// the wizard renders outside .admin-root. The cards come from sourceOptions().

import { cn } from '../../../lib/cn';
import type { SourceChoice, SourceOption } from './sourceDraft';

interface SourcePickerProps {
  options: SourceOption[];
  value: SourceChoice | null;
  onChange: (id: SourceChoice) => void;
  /** The card the station plays from now, marked On air. */
  onAir?: SourceChoice | null;
  /** On-air card's trouble, shown on it (a source that stopped answering). */
  onAirProblem?: string | null;
  label?: string;
  /** Two columns at most: for a narrow container such as the wizard's. */
  narrow?: boolean;
}

export function SourcePicker({ options, value, onChange, onAir, onAirProblem, label = 'Where is your music?', narrow }: SourcePickerProps) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid grid-cols-1 gap-2.5 sm:grid-cols-2', !narrow && 'xl:grid-cols-3')}>
      {options.map((o) => {
        const selected = value === o.id;
        const live = onAir === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!!o.disabled}
            title={o.disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'relative flex min-h-[112px] cursor-pointer flex-col gap-1.5 border px-4 pt-3.5 pb-3 text-left transition-colors',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'border-ink bg-ink text-bg'
                : 'border-[color-mix(in_oklab,var(--ink)_35%,transparent)] bg-[color-mix(in_oklab,var(--ink)_4%,transparent)] text-ink hover:border-ink',
            )}
          >
            {selected && <span className="absolute -top-px -right-px -left-px h-1 bg-[var(--accent)]" aria-hidden />}
            <span className="flex items-start justify-between gap-2">
              <span className="font-mono text-[13px] font-bold tracking-[0.08em] uppercase">{o.label}</span>
              {live ? (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 pt-0.5 font-mono text-[9px] font-bold tracking-[0.16em] whitespace-nowrap uppercase',
                    onAirProblem ? 'text-[var(--danger)]' : selected ? 'text-bg' : 'text-[color:var(--accent)]',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', onAirProblem ? 'bg-[var(--danger)]' : 'bg-current')} aria-hidden />
                  {onAirProblem ? 'not answering' : 'on air'}
                </span>
              ) : o.tag ? (
                <span className="shrink-0 border border-current px-1.5 py-[3px] font-mono text-[9px] leading-none font-bold tracking-[0.12em] whitespace-nowrap uppercase opacity-80">
                  {o.tag}
                </span>
              ) : null}
            </span>
            <span title={o.blurb} className={cn('line-clamp-3 text-[12.5px] leading-[1.45]', selected ? 'opacity-85' : 'text-muted')}>{o.blurb}</span>
            {o.disabled && <span className="mt-auto font-mono text-[10px] leading-[1.4] text-[var(--danger)]">{o.disabled}</span>}
          </button>
        );
      })}
    </div>
  );
}
