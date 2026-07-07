'use client';
// Detented horizontal fader for the behaviour settings (talk frequency, script
// length) — the mixing-desk counterpart to the rotary ToneKnob, and kept
// visually distinct on purpose: knobs are continuous personality colour, faders
// are discrete behaviour stops with real scheduling consequences, so every
// stop is named and directly clickable. Pointer-draggable AND keyboard-operable
// (role="slider" with arrows/Home/End). Cap/tick/fill positions come from the
// fixed lookups in constants.ts (inline styles are forbidden in admin sources —
// issue #50). Same dark "physical hardware" body as the knob in both themes;
// the lit fill and cap stripe track --accent.
import { useRef } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { cn } from '../../../lib/cn';
import { FADER_STOP_LEFT, FADER_FILL_WIDTH } from './constants';

export interface FaderStop {
  id: string;
  label: string;
  desc: string;
}

interface SteppedFaderProps {
  ariaLabel: string;      // group name for the slider, e.g. "Talk frequency"
  stops: readonly FaderStop[];
  value: string;          // current stop id
  onChange: (id: string) => void;
}

export function SteppedFader({ ariaLabel, stops, value, onChange }: SteppedFaderProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const n = stops.length;
  const lefts = FADER_STOP_LEFT[n] ?? [];
  const fills = FADER_FILL_WIDTH[n] ?? [];
  const idx = Math.max(0, stops.findIndex(s => s.id === value));
  const current = stops[idx];

  const clamp = (i: number) => Math.max(0, Math.min(n - 1, Math.round(i)));
  const select = (i: number) => {
    const next = stops[clamp(i)];
    if (next && next.id !== value) onChange(next.id);
  };

  const indexFromX = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return idx;
    return clamp(((clientX - r.left) / r.width) * (n - 1));
  };

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.focus();
    // Track the last-applied stop locally — the window listeners outlive this
    // render, so comparing against the captured `value` would go stale mid-drag.
    let last = idx;
    const apply = (clientX: number) => {
      const next = indexFromX(clientX);
      if (next !== last && stops[next]) {
        last = next;
        onChange(stops[next].id);
      }
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
    let next = idx;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': next = clamp(idx + 1); break;
      case 'ArrowDown': case 'ArrowLeft': next = clamp(idx - 1); break;
      case 'Home': next = 0; break;
      case 'End':  next = n - 1; break;
      default: return;
    }
    e.preventDefault();
    if (next !== idx) select(next);
  };

  return (
    <div>
      {/* Horizontal padding = half the cap width, so the cap and the edge
          ticks stay inside the card at both ends of the travel. */}
      <div className="px-2.5">
        <div
          ref={railRef}
          role="slider"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={idx}
          aria-valuetext={current?.label}
          aria-orientation="horizontal"
          onPointerDown={startDrag}
          onKeyDown={onKeyDown}
          className="relative h-8 cursor-ew-resize touch-none rounded outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        >
          {/* groove */}
          <div className="absolute top-1/2 right-0 left-0 h-[6px] -translate-y-1/2 rounded-full border border-[#0e0c0a] bg-[linear-gradient(180deg,#161412,#2a2420)] shadow-[inset_0_2px_4px_rgba(0,0,0,0.6)]" />
          {/* lit fill up to the cap */}
          <div className={cn(
            'absolute top-1/2 left-0 h-[6px] -translate-y-1/2 rounded-l-full bg-[color-mix(in_oklab,var(--accent)_45%,transparent)]',
            fills[idx],
          )} />
          {/* detent ticks */}
          {stops.map((s, i) => (
            <span
              key={s.id}
              className={cn(
                'absolute top-1/2 h-[14px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-[1px]',
                lefts[i],
                i <= idx
                  ? 'bg-[color-mix(in_oklab,var(--accent)_60%,transparent)]'
                  : 'bg-separator-strong',
              )}
            />
          ))}
          {/* cap */}
          <div className={cn('absolute top-1/2 -translate-x-1/2 -translate-y-1/2', lefts[idx])}>
            <span className="flex h-7 w-4 justify-center rounded-[3px] border border-[#0e0c0a] bg-[radial-gradient(circle_at_50%_30%,#2a2420,#161412)] shadow-[0_2px_5px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.08)]">
              <span className="h-full w-[2px] rounded-[1px] bg-[var(--accent)] shadow-[0_0_6px_color-mix(in_oklab,var(--accent)_60%,transparent)]" />
            </span>
          </div>
        </div>

        {/* clickable stop labels — first/last hug the rail ends, middles
            centre on their tick */}
        <div className="relative mt-1 h-4">
          {stops.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => select(i)}
              className={cn(
                'absolute top-0 text-[9px] leading-tight font-bold whitespace-nowrap uppercase',
                i === 0 ? 'left-0' : i === n - 1 ? 'right-0' : cn(lefts[i], '-translate-x-1/2'),
                i === idx ? 'text-[var(--accent)]' : 'text-muted hover:text-[var(--ink)]',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* what the selected stop actually does on air */}
      <div className="field-hint mt-2">
        <span className="font-bold text-[var(--ink)]">{current?.label}</span> — {current?.desc}
      </div>
    </div>
  );
}
