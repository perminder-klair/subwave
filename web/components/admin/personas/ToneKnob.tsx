'use client';
// Detented rotary knob (0–10). Pointer-draggable AND keyboard-operable
// (role="slider" with arrow/Home/End/PageUp/Down) so it keeps the accessibility
// the native range input had. The body is intentionally dark "physical
// hardware" in both themes; the lit indicator and rings track --accent/--ink so
// it reads correctly under light and dark palettes. 80px on phones, 96px md+.
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '../../../lib/cn';
import { KNOB_ROTATIONS } from './constants';

interface ToneKnobProps {
  label: string;
  value: number;   // 0–10, integer (detented)
  band: string;    // one-word readout for the current band
  low: string;     // caption under the knob's low end
  high: string;    // caption under the knob's high end
  onChange: (v: number) => void;
}

export function ToneKnob({ label, value, band, low, high, onChange }: ToneKnobProps) {
  const clamp = (v: number) => Math.max(0, Math.min(10, Math.round(v)));
  const rotation = KNOB_ROTATIONS[clamp(value)] ?? 'rotate-0';

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.focus();
    const startY = e.clientY;
    const start = value;
    let last = value;
    const SENS = 14; // px of vertical travel per unit
    const move = (ev: PointerEvent) => {
      const next = clamp(start + (startY - ev.clientY) / SENS);
      if (next !== last) { last = next; onChange(next); }
    };
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
      case 'ArrowUp': case 'ArrowRight': next = clamp(value + 1); break;
      case 'ArrowDown': case 'ArrowLeft': next = clamp(value - 1); break;
      case 'PageUp':   next = clamp(value + 2); break;
      case 'PageDown': next = clamp(value - 2); break;
      case 'Home':     next = 0;  break;
      case 'End':      next = 10; break;
      default: return;
    }
    e.preventDefault();
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col items-center gap-2.5">
      {/* Stacked + centred on phones (the ~80px column can't fit label and
          value side-by-side without truncating the label to one letter);
          side-by-side from md up, where the column is wide enough. */}
      <div className="flex w-full flex-col items-center gap-0.5 text-center md:flex-row md:items-baseline md:justify-between md:gap-1 md:text-left">
        <span className="text-[12px] leading-tight font-bold md:truncate">{label}</span>
        <span className="flex-none text-[11px] leading-tight font-bold text-[var(--accent)] tabular-nums">{value}/10 · {band}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={value}
        aria-valuetext={`${value} of 10, ${band}`}
        aria-orientation="vertical"
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        className="relative size-20 cursor-ns-resize touch-none rounded-full outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] md:size-24"
      >
        <div className="absolute inset-0 rounded-full border border-separator-strong" />
        <div className="absolute inset-[11px] rounded-full border border-[#0e0c0a] bg-[radial-gradient(circle_at_50%_32%,#2a2420,#161412)] shadow-[inset_0_3px_8px_rgba(0,0,0,0.55),inset_0_-2px_4px_rgba(255,255,255,0.05)] md:inset-[13px]" />
        <div className={cn('absolute inset-[11px] flex justify-center md:inset-[13px]', rotation)}>
          <span className="mt-[7px] h-[18px] w-[3px] rounded-[1px] bg-[var(--accent)] shadow-[0_0_6px_color-mix(in_oklab,var(--accent)_60%,transparent)]" />
        </div>
        <div className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#0c0a08] shadow-[inset_0_1px_2px_rgba(0,0,0,0.8)]" />
      </div>
      <div className="flex w-20 justify-between text-[8px] font-bold text-muted tabular-nums md:w-24">
        <span>0</span><span>5</span><span>10</span>
      </div>
      <div className="flex w-full justify-between gap-1.5 text-[9px] leading-tight text-muted uppercase">
        <span className="max-w-[48%]">{low}</span>
        <span className="max-w-[48%] text-right">{high}</span>
      </div>
    </div>
  );
}
