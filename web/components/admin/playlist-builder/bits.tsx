'use client';


import { useRef } from 'react';
import { X } from 'lucide-react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import { EN_HIGH, EN_HIGH_BG, EN_LOW, EN_LOW_BG, EN_MED, EN_MED_BG } from './types';

export const energyColor = (e?: string | null): string => (e === 'low' ? EN_LOW : e === 'high' ? EN_HIGH : EN_MED);
export const energyBgClass = (e?: string | null): string => (e === 'low' ? EN_LOW_BG : e === 'high' ? EN_HIGH_BG : EN_MED_BG);
// Untagged tracks read '—', not a fake 'med': an untagged library must not
// masquerade as uniformly mid-energy.
export const energyLabel = (e?: string | null): string =>
  e === 'low' || e === 'medium' || e === 'high' ? (e === 'medium' ? 'med' : e) : '—';
export const energyKnown = (e?: string | null): boolean => e === 'low' || e === 'medium' || e === 'high';


export function Eyeb({ children, muted, className }: { children: React.ReactNode; muted?: boolean; className?: string }) {
  return (
    <span className={cn('font-mono text-[10px] font-bold tracking-[0.16em] uppercase', muted ? 'text-muted' : 'text-ink', className)}>
      {children}
    </span>
  );
}

export function Tog({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'border px-[11px] py-1.5 font-mono text-[11px] font-semibold tracking-[0.03em] transition',
        on ? 'border-ink bg-ink text-bg' : 'border-separator-strong bg-bg text-ink hover:border-ink',
      )}
    >
      {children}
    </button>
  );
}

export function IconBtn({ onClick, disabled, title, className, children }: {
  onClick?: () => void; disabled?: boolean; title?: string; className?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'grid size-[30px] place-items-center border border-transparent text-muted transition',
        'hover:border-separator-soft hover:bg-ink-soft hover:text-ink disabled:opacity-25 disabled:hover:border-transparent disabled:hover:bg-transparent',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Chip({ accent, onRemove, children }: { accent?: boolean; onRemove?: () => void; children: React.ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1.5 border bg-bg px-[7px] py-[3px] font-mono text-[10px] font-semibold tracking-[0.06em] uppercase',
      accent ? 'border-[var(--accent)] text-vermilion' : 'border-separator-strong text-ink',
    )}>
      {children}
      {onRemove && (
        <button type="button" onClick={onRemove} className="cursor-pointer text-muted hover:text-ink" title="remove">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

// Two overlaid native sliders sharing one track, with an accent band between the
// anchors. No dependency; thumbs stay keyboardable.
export function DualRange({ min, max, step, lo, hi, disabled, onLo, onHi, loLabel, hiLabel }: {
  min: number; max: number; step: number; lo: number; hi: number; disabled?: boolean;
  onLo: (v: number) => void; onHi: (v: number) => void; loLabel: string; hiLabel: string;
}) {
  const bandRef = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;
  useDynamicStyle(bandRef, { left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%` });
  const thumb =
    'pointer-events-none absolute inset-0 h-5 w-full appearance-none bg-transparent outline-none ' +
    '[&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto ' +
    '[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none ' +
    '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-ink [&::-webkit-slider-thumb]:bg-[var(--accent)] ' +
    '[&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:size-3.5 ' +
    '[&::-moz-range-thumb]:rounded-none [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-ink [&::-moz-range-thumb]:bg-[var(--accent)]';
  return (
    <div className={cn('relative h-5', disabled && 'opacity-40')}>
      <div className="absolute top-1/2 right-0 left-0 h-[3px] -translate-y-1/2 bg-separator-strong" />
      <div ref={bandRef} className="absolute top-1/2 h-[3px] -translate-y-1/2 bg-[var(--accent)]" />
      <input
        type="range" min={min} max={max} step={step} value={lo} disabled={disabled}
        onChange={e => onLo(Math.min(+e.target.value, hi))}
        aria-label={loLabel}
        // When both anchors crowd the right end, lift the lo thumb so it stays grabbable.
        className={cn(thumb, lo > max - step * 4 && 'z-10')}
      />
      <input
        type="range" min={min} max={max} step={step} value={hi} disabled={disabled}
        onChange={e => onHi(Math.max(+e.target.value, lo))}
        aria-label={hiLabel}
        className={thumb}
      />
    </div>
  );
}



