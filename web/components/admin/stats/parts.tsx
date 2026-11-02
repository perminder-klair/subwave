'use client';

// The Stats page's building blocks, after the "Stats Redesign" design: sections,
// ink-ruled panels, mono eyebrow labels, share bars, LED ladders and a tuner
// scale. Colours are theme tokens only (ink, the vermilion accent, danger),
// corners stay square, and every computed length goes through useDynamicStyle
// because the lint rule forbids `style={…}`.

import type { ReactNode } from 'react';
import { useRef } from 'react';
import { useDynamicStyle } from '../../../hooks/useDynamicStyle';
import { cn } from '../../../lib/cn';
import type { Health } from '../../../lib/statsHealth';

export const LABEL = 'font-mono text-[10px] font-bold uppercase tracking-[0.2em]';
export const NOTE = 'font-mono text-[10px] uppercase tracking-[0.16em] text-muted';
export const SUB = 'font-mono text-[11px] text-muted';
export const FIGURE = 'font-mono text-[22px] font-bold leading-[1.1] tabular-nums';

export function Section({ title, sub, right, id, bare, children }: {
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
  id: string;
  // Cards that label themselves, where a heading would only repeat the dial.
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    // grid-cols-1 is minmax(0,1fr): without it a wide table's min-content
    // stretches the section past a phone screen instead of scrolling in place.
    // --stats-clearance is the top bar and the pinned dial (SectionDial).
    <section id={id} aria-label={title} className="grid scroll-mt-[var(--stats-clearance,112px)] grid-cols-1 gap-3">
      {!bare && (
        <header className={cn('flex flex-wrap gap-x-4 gap-y-1', right ? 'items-center' : 'items-baseline')}>
          <h2 className="m-0 font-display text-[30px] leading-[1.1] font-normal tracking-[-0.01em]">{title}</h2>
          {sub && <span className={cn(NOTE, 'sm:ml-auto')}>{sub}</span>}
          {right && <span className="ml-auto sm:ml-0">{right}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('border border-ink bg-[var(--card-bg)]', className)}>{children}</div>;
}

export function PanelHead({ title, sub, right }: { title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-ink px-[18px] py-3.5">
      <span className={LABEL}>{title}</span>
      {sub && <span className={NOTE}>{sub}</span>}
      {right && <span className="ml-auto flex flex-wrap gap-1.5">{right}</span>}
    </div>
  );
}

// Cells that wrap onto as many rows as fit. Each cell rules its own right and
// bottom edge, and the -1px margins tuck the outermost rules under the
// panel's border, so the dividers stay right however the grid wraps.
const GRID_MIN = {
  140: 'grid-cols-[repeat(auto-fit,minmax(140px,1fr))]',
  170: 'grid-cols-[repeat(auto-fit,minmax(170px,1fr))]',
  180: 'grid-cols-[repeat(auto-fit,minmax(180px,1fr))]',
  190: 'grid-cols-[repeat(auto-fit,minmax(190px,1fr))]',
  220: 'grid-cols-[repeat(auto-fit,minmax(220px,1fr))]',
  260: 'grid-cols-[repeat(auto-fit,minmax(260px,1fr))]',
  280: 'grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))]',
  360: 'grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))]',
} as const;

export function CellGrid({ min, children, className }: {
  min: keyof typeof GRID_MIN;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('overflow-hidden', className)}>
      <div className={cn('-mr-px -mb-px grid', GRID_MIN[min])}>{children}</div>
    </div>
  );
}

export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 content-start gap-1 border-r border-b border-separator-strong px-[18px] py-3.5', className)}>
      {children}
    </div>
  );
}

export type Tone = 'ink' | 'accent' | 'danger' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  ink: '',
  accent: 'text-vermilion',
  danger: 'text-[var(--danger)]',
  muted: 'text-muted',
};

// warn reads as the accent, bad as danger; ok and idle stay ink.
export const healthTone = (h: Health): Tone => (h === 'bad' ? 'danger' : h === 'warn' ? 'accent' : 'ink');

export function MetricCell({ label, value, sub, tone = 'ink' }: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <Cell className="gap-[3px]">
      <span className={LABEL}>{label}</span>
      <span className={cn(FIGURE, TONE_TEXT[tone])}>{value}</span>
      {sub && <span className={SUB}>{sub}</span>}
    </Cell>
  );
}

export function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('field-hint m-0 italic', className)}>{children}</p>;
}

// A span sized by computed width (and optionally left), for bars and lamps.
function Sized({ width, left, className, children }: {
  width: string;
  left?: string;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { width, left: left ?? null });
  return <span ref={ref} className={className}>{children}</span>;
}

// A thin share bar. The list's leader is drawn in the accent, the rest in ink.
export function Bar({ frac, lead, className }: { frac: number; lead?: boolean; className?: string }) {
  const pct = Math.max(1.5, Math.min(1, Math.max(0, frac)) * 100);
  return (
    <span className={cn('relative block h-1.5 bg-[var(--separator-strong)]', className)}>
      <Sized width={`${pct}%`} className={cn('absolute inset-y-0 left-0', lead ? 'bg-vermilion' : 'bg-ink')} />
    </span>
  );
}

// Fills for the parts of a mix, in order: the leader in the accent, then ink
// stepping back towards the paper.
const MIX_FILL = [
  'bg-vermilion',
  'bg-ink',
  'bg-[var(--muted)]',
  'bg-[color-mix(in_oklab,var(--ink)_30%,transparent)]',
] as const;

export const mixFill = (i: number) => MIX_FILL[Math.min(i, MIX_FILL.length - 1)];

// One bar split into the parts of a whole (which model answered, which engine
// spoke), each part sized by its share. Pair it with a legend of Swatches.
export function StackBar({ parts, label }: { parts: { key: string; frac: number }[]; label: string }) {
  return (
    <span role="img" aria-label={label} className="flex h-2.5 gap-0.5">
      {parts.map((p, i) => (
        <Sized key={p.key} width={`${Math.max(1, p.frac * 100)}%`} className={cn('block h-full', mixFill(i))} />
      ))}
    </span>
  );
}

export function Swatch({ index }: { index: number }) {
  return <span aria-hidden="true" className={cn('inline-block size-2 shrink-0', mixFill(index))} />;
}

// How long a group has been connected: the bar runs to its longest connection
// and the vermilion tick marks the average. `scale` is the longest across all
// groups, so the bars compare.
export function DurationBar({ avg, max, scale }: { avg: number; max: number; scale: number }) {
  const s = scale || 1;
  return (
    <span className="relative block h-1.5 bg-[var(--separator-strong)]">
      <Sized width={`${Math.max(2, Math.min(1, max / s) * 100)}%`} className="absolute inset-y-0 left-0 bg-ink opacity-35" />
      <Sized width="2px" left={`${Math.min(1, avg / s) * 100}%`} className="absolute -inset-y-0.5 -ml-px bg-vermilion" />
    </span>
  );
}

const LED_OFF ='bg-[repeating-linear-gradient(to_right,var(--separator-strong)_0_5px,transparent_5px_7px)]';
const LED_INK = 'bg-[repeating-linear-gradient(to_right,var(--ink)_0_5px,transparent_5px_7px)]';
const LED_RED = 'bg-[repeating-linear-gradient(to_right,var(--accent)_0_5px,transparent_5px_7px)]';

// A ladder of `n` LEDs (5px lamp, 2px gap) lit to `frac`. Past `redFrom` (a
// fraction of the ladder) the lit lamps turn vermilion: the red zone.
export function Leds({ frac, n, redFrom, tall, label }: {
  frac: number;
  n: number;
  redFrom?: number;
  tall?: boolean;
  label?: string;
}) {
  const lit = Math.round(Math.min(1, Math.max(0, frac)) * n);
  const zone = redFrom == null ? n : Math.round(redFrom * n);
  const ink = Math.min(lit, zone);
  const red = Math.max(0, lit - zone);
  return (
    <Sized
      width={`${n * 7 - 2}px`}
      className={cn('relative block max-w-full shrink-0', tall ? 'h-3' : 'h-2.5', LED_OFF)}
    >
      {label && <span className="sr-only">{label}</span>}
      {ink > 0 && <Sized width={`${ink * 7}px`} className={cn('absolute inset-y-0 left-0', LED_INK)} />}
      {red > 0 && <Sized width={`${red * 7}px`} left={`${zone * 7}px`} className={cn('absolute inset-y-0', LED_RED)} />}
    </Sized>
  );
}

export interface TunerMark {
  label: string;
  value: number;
  accent?: boolean;
}

// Places an element at a percentage along the scale.
function Along({ pct, className, children }: { pct: number; className?: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDynamicStyle(ref, { left: `${pct}%` });
  return <div ref={ref} className={className}>{children}</div>;
}

export function TickScale({ max, step, minors = 5, className, children }: {
  max: number;
  step: number;
  minors?: number;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Major ticks every `step`, `minors` divisions to each.
  useDynamicStyle(ref, {
    backgroundSize: `calc(100% / ${max / step}) 14px, calc(100% / ${(max / step) * minors}) 6px`,
  });
  return (
    <div
      ref={ref}
      className={cn(
        'relative h-7 border-b border-ink bg-[linear-gradient(to_right,var(--ink)_1px,transparent_1px),linear-gradient(to_right,var(--ink)_1px,transparent_1px)] bg-left-bottom bg-repeat-x',
        className,
      )}
    >
      {children}
    </div>
  );
}

const MARK_ROW = ['-top-3', '-top-7', '-top-11'] as const;

// A radio-dial scale from 0 to `max` seconds with needles at `marks` (at most
// three). Spread-out needles alternate between two label rows, the first set to
// the left of its needle. Bunched needles (p50 just under the mean, or a cold
// start where they are the same call) get a row each, the leftmost highest:
// labels face right, so each one runs above the shorter needles beside it
// instead of through them. `deadline` draws the red stop.
export function Tuner({ max, step, marks, deadline }: {
  max: number;
  step: number;
  marks: TunerMark[];
  deadline?: boolean;
}) {
  const labels: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) labels.push(Math.round(v * 10) / 10);
  const pcts = marks.map(m => Math.min(100, (m.value / max) * 100));
  const sorted = [...pcts].sort((a, b) => a - b);
  const spread = sorted.every((p, i) => i === 0 || p - sorted[i - 1]! >= 16);
  // Rank by position, ties in list order; the bunched layout stacks by rank.
  const rank = pcts.map((p, i) => pcts.filter((q, j) => q < p || (q === p && j < i)).length);
  return (
    <div className={spread ? 'pt-9' : 'pt-12'}>
      <TickScale max={max} step={step}>
        {deadline && (
          <>
            <span className="absolute -top-9 right-0 bottom-0 w-0.5 bg-[var(--danger)]" />
            <span className="absolute -top-9 right-1.5 font-mono text-[10px] font-bold text-[var(--danger)]">
              deadline {max}s
            </span>
          </>
        )}
        {marks.map((m, i) => {
          const pct = pcts[i]!;
          // Near either end a label faces inward, or the panel would clip it.
          const labelLeft = pct > 82 || (spread && pct >= 18 && i === 0 && marks.length > 1);
          return (
            <Along
              key={m.label}
              pct={pct}
              className={cn(
                'absolute bottom-0 w-0',
                MARK_ROW[spread ? i % 2 : Math.min(2, Math.max(0, marks.length - 1 - rank[i]!))],
              )}
            >
              <span className={cn('absolute inset-y-0 -left-px w-0.5', m.accent ? 'bg-vermilion' : 'bg-ink')} />
              <span
                className={cn(
                  'absolute -top-0.5 font-mono text-[10px] font-bold whitespace-nowrap',
                  labelLeft ? 'right-[5px]' : 'left-[5px]',
                  m.accent ? 'text-vermilion' : 'text-ink',
                )}
              >
                {m.label}
              </span>
            </Along>
          );
        })}
      </TickScale>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted">
        {labels.map((v, i) => (
          <span key={v}>{i === labels.length - 1 ? `${v}s` : v}</span>
        ))}
      </div>
    </div>
  );
}

const LAMP: Record<Health, string> = {
  ok: 'bg-ink',
  warn: 'bg-vermilion',
  bad: 'bg-[var(--danger)]',
  idle: 'bg-transparent',
};

// A square indicator lamp; decorative, the row beside it says what it means.
export function Lamp({ health }: { health: Health }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2.5 shrink-0 outline-1 outline-offset-2 outline-ink outline-solid', LAMP[health])}
    />
  );
}
