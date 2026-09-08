'use client';

/* Shared admin primitives. Every panel renders inside AdminShell's
   `.admin-root` wrapper, so the unprefixed class names (.card / .tag …)
   resolve to the admin-scoped rules in globals.css. Btn / Seg / Toggle wrap
   shadcn primitives while keeping the original prop API. */

import type { ReactNode, MouseEvent, Ref, AriaAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';
import { Switch } from '../ui/switch';
import { Badge, badgeVariants } from '../ui/badge';

/** A card title reduced to a stable scroll target: `"Listener requests"` →
 *  `"listener-requests"`. Shared so a jump table can spell the same slug. */
export function cardAnchor(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
  // Drops the box border/background and side padding, for sections inside
  // EditorDialog (.card.is-flat in globals.css).
  flat?: boolean;
  /**
   * Scroll-target slug, exposed as `data-card`. Defaults to the slugged title;
   * pass one explicitly when the title is not a plain string.
   */
  anchor?: string;
}

export function Card({ title, sub, right, children, className, bodyClass, headClass, flat, anchor }: CardProps) {
  // Only a plain-string title is slugged; an interpolated one would give a slug
  // that moves with the data.
  const slug = anchor ?? (typeof title === 'string' ? cardAnchor(title) : undefined);
  return (
    <section data-card={slug} className={cn('card', flat && 'is-flat', className)}>
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
  /* Toggle state for a pill used as an on/off chip. Set it and the pill
     reports aria-pressed; leave it off for pills that fire a plain action. */
  pressed?: boolean;
  /* Unavailable but still focusable. Keep passing `onClick` — the pill
     swallows it; dropping it falls back to the Badge <span> and loses the tab stop. */
  disabled?: boolean;
}

/* Tag pill over shadcn Badge. `tone` ∈ ink | accent | solid (default =
   muted outline); `dot` prepends a small currentColor dot.

   With `onClick` this renders a real <button>, not a clickable Badge <span>,
   so chip multi-selects keep a tab stop and Enter/Space. `type="button"` is
   load-bearing inside a <form>. Without `onClick` the Badge path is unchanged. */
export function Pill({ children, tone, dot, className, onClick, title, pressed, disabled }: PillProps) {
  const content = (
    <>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        /* text-start matches the Badge <span>; a <button> centres text by default. */
        className={cn(
          badgeVariants({ variant: tone || 'default' }),
          disabled ? 'cursor-default' : 'cursor-pointer',
          'text-start',
          className,
        )}
        /* aria-disabled, not the `disabled` attribute: it keeps the tab stop so
           the state can be announced. The element stays natively clickable, so
           the handler itself has to refuse the click. */
        onClick={disabled ? undefined : onClick}
        title={title}
        aria-pressed={pressed}
        aria-disabled={disabled || undefined}
      >
        {content}
      </button>
    );
  }
  return (
    <Badge variant={tone || 'default'} className={className} title={title}>
      {content}
    </Badge>
  );
}

export interface MetaChipProps {
  children?: ReactNode;
  accent?: boolean;
  className?: string;
}

/* Read-only facet chip for the roster cards. `accent` flags a hard lock
   (strict filters, pinned feature); `className` lets a caller cap or truncate
   a long value. */
export function MetaChip({ children, accent, className }: MetaChipProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center border px-1.5 py-[3px] text-[10px] font-semibold tracking-[0.02em]',
        accent
          ? 'border-[var(--accent)] text-vermilion'
          : 'border-separator-strong text-muted',
        className,
      )}
    >
      {children}
    </span>
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
  /** React 19 passes `ref` as an ordinary prop; declared so callers can reach
   *  the element without dropping down to <Button>. */
  ref?: Ref<HTMLButtonElement>;
  /** Accessible name, for icon-only buttons whose label is the icon. */
  'aria-label'?: string;
  /** Disclosure state, when this button opens a panel/menu it owns. */
  'aria-expanded'?: boolean;
  'aria-haspopup'?: boolean | 'menu' | 'dialog' | 'listbox' | 'true';
}

export function Btn({
  children,
  tone,
  sm,
  lg,
  onClick,
  disabled,
  type,
  title,
  className,
  ref,
  ...aria
}: BtnProps) {
  return (
    <Button
      ref={ref}
      variant={tone ? BTN_VARIANT[tone] : 'default'}
      size={sm ? 'sm' : lg ? 'lg' : 'default'}
      onClick={onClick}
      disabled={disabled}
      type={type || 'button'}
      title={title}
      className={className}
      {...aria}
    >
      {children}
    </Button>
  );
}

export interface SegOption {
  id: string;
  label: ReactNode;
  /* Hover tooltip, mainly for icon-only tabs (whose accessible name comes from
     an `sr-only` span inside `label`). */
  title?: string;
}

export interface SegProps extends AriaAttributes {
  value: string;
  options: SegOption[];
  accent?: boolean;
  onChange?: (id: string) => void;
}

/* Segmented control over shadcn ToggleGroup. Clicking the active item is a
   no-op: the group always keeps a value. */
export function Seg({ value, options, accent, onChange, ...aria }: SegProps) {
  return (
    <ToggleGroup
      {...aria}
      type="single"
      value={value}
      onValueChange={(v: string) => { if (v && onChange) onChange(v); }}
      // w-fit/max-w-full keep the control hugging its tabs; a parent `.field`
      // (align-items:stretch) would otherwise stretch it to full width.
      className="inline-flex w-fit max-w-full flex-wrap gap-0 border border-ink"
    >
      {options.map((o, i) => (
        <ToggleGroupItem
          key={o.id}
          value={o.id}
          title={o.title}
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
  /** Accessible name; the switch renders no text of its own. Required so tsc
   *  catches a call site that forgets one. */
  ariaLabel: string;
}

export function Toggle({ on, onClick, disabled, ariaLabel }: ToggleProps) {
  return (
    <Switch
      checked={!!on}
      onCheckedChange={onClick ? () => onClick() : undefined}
      disabled={disabled}
      aria-label={ariaLabel}
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
