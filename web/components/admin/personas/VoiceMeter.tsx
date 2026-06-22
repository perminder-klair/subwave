'use client';
// LED output-trim meter (±12 dB). Pointer-draggable AND keyboard-operable
// (role="slider"), so it keeps the accessibility the native range input had.
// Lit cells track --accent; off-cells/centre marker track --ink so it reads in
// both themes.
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '../../../lib/cn';
import { VOICE_CELLS } from './constants';

interface VoiceMeterProps {
  value: number;   // gain in dB
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}

export function VoiceMeter({ value, min = -12, max = 12, step = 0.5, onChange }: VoiceMeterProps) {
  const span = max - min;
  const lit = Math.round(((value - min) / span) * VOICE_CELLS);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const snap = (v: number) => Math.round(clamp(v) / step) * step;

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    const rect = el.getBoundingClientRect();
    let last = value;
    const apply = (clientX: number) => {
      const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const next = snap(min + p * span);
      if (next !== last) { last = next; onChange(next); }
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = value;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp':   next = snap(value + step); break;
      case 'ArrowLeft':  case 'ArrowDown': next = snap(value - step); break;
      case 'PageUp':   next = snap(value + 2); break;
      case 'PageDown': next = snap(value - 2); break;
      case 'Home':     next = min; break;
      case 'End':      next = max; break;
      default: return;
    }
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Voice level in decibels"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value > 0 ? '+' : ''}${value.toFixed(1)} dB`}
      aria-orientation="horizontal"
      onPointerDown={startDrag}
      onKeyDown={onKeyDown}
      className="relative mt-2.5 cursor-ew-resize touch-none py-1.5 outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
    >
      <div className="flex h-[34px] items-stretch gap-[2px]">
        {Array.from({ length: VOICE_CELLS }, (_, i) => (
          <span
            key={`cell-${i}`}
            className={cn(
              'flex-1 transition-colors',
              i < lit ? 'bg-[var(--accent)]' : 'bg-[color-mix(in_oklab,var(--ink)_16%,transparent)]',
            )}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute top-[1px] bottom-[1px] left-1/2 w-px bg-[color-mix(in_oklab,var(--ink)_45%,transparent)]" />
    </div>
  );
}
