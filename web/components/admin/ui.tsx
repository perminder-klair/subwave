'use client';

/* Shared newsprint primitives for the redesigned admin panels.
   Every panel renders inside AdminShell's `.admin-root` wrapper, so the
   unprefixed class names (.card / .tag …) resolve to the admin-scoped
   rules in globals.css.

   Btn / Seg / Toggle are thin wrappers over shadcn/ui primitives (Button,
   ToggleGroup, Switch) — retuned in components/ui/* to the newsprint look —
   keeping the original prop API so existing call sites need no changes. */

import type { CSSProperties, ReactNode, MouseEvent } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';

export interface EyebrowProps {
  children?: ReactNode;
  className?: string;
}

export function Eyebrow({ children, className }: EyebrowProps) {
  return <span className={cn('eyebrow text-muted', className)}>{children}</span>;
}

export interface CardProps {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClass?: string;
  headClass?: string;
}

export function Card({ title, sub, right, children, className, bodyClass, headClass }: CardProps) {
  return (
    <section className={cn('card', className)}>
      {(title || right) && (
        <div className={cn('card-head', headClass)}>
          {title && <span className="title">{title}</span>}
          {sub && <span className="sub">{sub}</span>}
          {right && <span className="right">{right}</span>}
        </div>
      )}
      <div className={cn('card-body', bodyClass)}>{children}</div>
    </section>
  );
}

export type PillTone = 'default' | 'ink' | 'accent' | 'solid';

export interface PillProps {
  children?: ReactNode;
  tone?: PillTone;
  dot?: boolean;
  className?: string;
  onClick?: () => void;
  title?: string;
}

/* Tag pill over shadcn Badge. `tone` ∈ ink | accent | solid (default =
   muted outline); `dot` prepends a small currentColor dot. */
export function Pill({ children, tone, dot, className, onClick, title }: PillProps) {
  return (
    <Badge
      variant={tone || 'default'}
      className={cn(onClick && 'cursor-pointer', className)}
      onClick={onClick}
      title={title}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </Badge>
  );
}

/* Legacy `tone` → shadcn Button `variant`. `danger` maps to `destructive`. */
type BtnTone = 'solid' | 'accent' | 'danger';

const BTN_VARIANT: Record<BtnTone, 'solid' | 'accent' | 'destructive'> = {
  solid: 'solid',
  accent: 'accent',
  danger: 'destructive',
};

export interface BtnProps {
  children?: ReactNode;
  tone?: BtnTone;
  sm?: boolean;
  lg?: boolean;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  title?: string;
  className?: string;
}

export function Btn({ children, tone, sm, lg, onClick, disabled, type, title, className }: BtnProps) {
  return (
    <Button
      variant={tone ? BTN_VARIANT[tone] : 'default'}
      size={sm ? 'sm' : lg ? 'lg' : 'default'}
      onClick={onClick}
      disabled={disabled}
      type={type || 'button'}
      title={title}
      className={className}
    >
      {children}
    </Button>
  );
}

export interface SegOption {
  id: string;
  label: ReactNode;
}

export interface SegProps {
  value: string;
  options: SegOption[];
  accent?: boolean;
  onChange?: (id: string) => void;
}

/* Segmented control over shadcn ToggleGroup. `options` is [{ id, label }];
   `onChange(id)` fires on selection. Clicking the active item is a no-op
   (the group always keeps a value, matching the original behaviour). */
export function Seg({ value, options, accent, onChange }: SegProps) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(v: string) => { if (v && onChange) onChange(v); }}
      // w-fit/max-w-full keep the control hugging its tabs: a parent flex/grid
      // `.field` (align-items:stretch) would otherwise stretch this inline-flex
      // to full width, leaving dead bordered space to the right of the tabs.
      className="inline-flex w-fit max-w-full flex-wrap gap-0 border border-ink"
    >
      {options.map((o, i) => (
        <ToggleGroupItem
          key={o.id}
          value={o.id}
          className={cn(
            'h-auto min-w-0 rounded-none border-0 px-[13px] py-[7px] text-[10px] font-bold tracking-[0.18em] text-ink uppercase',
            'hover:bg-[var(--ink-soft)] hover:text-ink',
            i > 0 && 'border-l border-ink',
            accent
              ? 'data-[state=on]:bg-[var(--accent)] data-[state=on]:text-white'
              : 'data-[state=on]:bg-ink data-[state=on]:text-bg',
          )}
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export interface ToggleProps {
  on?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export function Toggle({ on, onClick, disabled }: ToggleProps) {
  return (
    <Switch
      checked={!!on}
      onCheckedChange={onClick ? () => onClick() : undefined}
      disabled={disabled}
    />
  );
}

export interface MetricProps {
  n: ReactNode;
  l: ReactNode;
  accent?: boolean;
}

export function Metric({ n, l, accent }: MetricProps) {
  return (
    <div className={cn('metric', accent && 'accent')}>
      <div className="n mono-num">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

export interface WaveProps {
  bars?: number;
  seed?: number;
  h?: number;
  tone?: string;
  maxHeight?: number;
}

/* Stable seeded pseudo-random waveform bars. Heights are set via DOM
   mutation in useLayoutEffect because Tailwind can't express per-element
   dynamic pixel values without inline `style`. */
export function Wave({ bars = 60, seed = 1, h = 60, tone = '', maxHeight }: WaveProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const heights: number[] = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < bars; i++) {
    x = (x * 9301 + 49297) % 233280;
    heights.push(Math.round(8 + (x / 233280) * (h - 8)));
  }

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const max = maxHeight ?? h;
    root.style.setProperty('--wave-h', `${h}px`);
    root.style.setProperty('--wave-max-h', `${max}px`);
    const spans = root.querySelectorAll<HTMLSpanElement>(':scope > span');
    spans.forEach((span, i) => {
      const bar = heights[i];
      if (bar != null) span.style.height = `${bar}px`;
    });
  });

  return (
    <div
      ref={ref}
      className={cn(
        'wave h-[var(--wave-h)] max-h-[var(--wave-max-h)]',
        tone,
      )}
    >
      {heights.map((_, i) => <span key={i} />)}
    </div>
  );
}

/* Helper: turn a `CSSProperties`-shaped object into an inline `style` prop.
   Some panels need to express dynamic per-element values (computed colours,
   gradient angles, geometry) that can't be encoded in Tailwind utilities.
   They route through this so the lint allow-list stays scoped to truly
   dynamic styles — every static layout should be Tailwind. */
export function styleVars(vars: Record<string, string | number | undefined>): CSSProperties {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v == null || v === '') continue;
    out[k] = v;
  }
  return out as CSSProperties;
}
