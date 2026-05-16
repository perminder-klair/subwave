'use client';

/* Shared newsprint primitives for the redesigned admin panels.
   Every panel renders inside AdminShell's `.admin-root` wrapper, so the
   unprefixed class names (.card / .tag …) resolve to the admin-scoped
   rules in globals.css.

   Btn / Seg / Toggle are thin wrappers over shadcn/ui primitives (Button,
   ToggleGroup, Switch) — retuned in components/ui/* to the newsprint look —
   keeping the original prop API so existing call sites need no changes. */

import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';

export function Eyebrow({ children, color, style }) {
  return (
    <span className="eyebrow" style={{ color: color || 'var(--muted)', ...style }}>
      {children}
    </span>
  );
}

export function Card({ title, sub, right, children, bodyStyle, headStyle, bodyClass, style }) {
  return (
    <section className="card" style={style}>
      {(title || right) && (
        <div className="card-head" style={headStyle}>
          {title && <span className="title">{title}</span>}
          {sub && <span className="sub">{sub}</span>}
          {right && <span className="right">{right}</span>}
        </div>
      )}
      <div className={`card-body ${bodyClass || ''}`} style={bodyStyle}>{children}</div>
    </section>
  );
}

/* Tag pill over shadcn Badge. `tone` ∈ ink | accent | solid (default =
   muted outline); `dot` prepends a small currentColor dot. */
export function Pill({ children, tone, dot, style, onClick, title }) {
  return (
    <Badge
      variant={tone || 'default'}
      style={{ ...(onClick ? { cursor: 'pointer' } : null), ...style }}
      onClick={onClick}
      title={title}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </Badge>
  );
}

/* Legacy `tone` → shadcn Button `variant`. `danger` maps to `destructive`. */
const BTN_VARIANT = { solid: 'solid', accent: 'accent', danger: 'destructive' };

export function Btn({ children, tone, sm, lg, style, onClick, disabled, type, title, className }) {
  return (
    <Button
      variant={BTN_VARIANT[tone] || 'default'}
      size={sm ? 'sm' : lg ? 'lg' : 'default'}
      style={style}
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

/* Segmented control over shadcn ToggleGroup. `options` is [{ id, label }];
   `onChange(id)` fires on selection. Clicking the active item is a no-op
   (the group always keeps a value, matching the original behaviour). */
export function Seg({ value, options, accent, onChange }) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={v => { if (v && onChange) onChange(v); }}
      className="inline-flex flex-wrap gap-0 border border-ink"
    >
      {options.map((o, i) => (
        <ToggleGroupItem
          key={o.id}
          value={o.id}
          className={cn(
            'h-auto min-w-0 rounded-none border-0 px-[13px] py-[7px] text-[10px] font-bold uppercase tracking-[0.18em] text-ink',
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

export function Toggle({ on, onClick, disabled }) {
  return (
    <Switch
      checked={!!on}
      onCheckedChange={onClick ? () => onClick() : undefined}
      disabled={disabled}
    />
  );
}

export function Metric({ n, l, accent }) {
  return (
    <div className={`metric ${accent ? 'accent' : ''}`}>
      <div className="n mono-num">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

/* Stable seeded pseudo-random waveform bars. */
export function Wave({ bars = 60, seed = 1, h = 60, tone = '', maxHeight }) {
  const out = [];
  let x = seed * 9301 + 49297;
  for (let i = 0; i < bars; i++) {
    x = (x * 9301 + 49297) % 233280;
    out.push(Math.round(8 + (x / 233280) * (h - 8)));
  }
  return (
    <div className={`wave ${tone}`} style={{ height: h, maxHeight: maxHeight || h }}>
      {out.map((b, i) => <span key={i} style={{ height: b }} />)}
    </div>
  );
}
