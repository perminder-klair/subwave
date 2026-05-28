'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Palette } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useDynamicStyle } from '../hooks/useDynamicStyle';
import { useThemeSwitcher } from './ThemeBootstrap';

/** The columns shown in each card's swatch — paper, ink, accent, overlay.
 *  Matches admin Settings → Theme so the same vocabulary travels with the
 *  user from operator picker to listener picker. */
const SWATCH_KEYS = ['--bg', '--ink', '--accent', '--overlay'] as const;

interface SwatchProps {
  color: string | undefined;
}

// `useDynamicStyle` is how this codebase paints arbitrary per-element colours
// without using the (lint-banned) inline `style` prop. The hook routes through
// HTMLElement.style via the DOM API, which lint can't intercept.
function Swatch({ color }: SwatchProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />;
}

export interface ThemeSwitcherProps {
  /** Visual variant — player chrome (TopBar) or admin header. Controls the
   *  trigger button's text styling so it picks up the right cluster's font. */
  variant?: 'player' | 'admin';
}

// Per-listener theme override switcher. Drops into a header as an icon button
// and opens a small dropdown listing every theme the controller exposes. The
// listener's pick is persisted in localStorage and beats the station-wide
// default until they hit "Use station default".
//
// The component renders nothing while the theme registry is still loading or
// is empty — there's nothing useful to show, and bouncing a button in and out
// would draw the eye more than just appearing once.
export default function ThemeSwitcher({ variant = 'player' }: ThemeSwitcherProps) {
  const ctx = useThemeSwitcher();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  // Close on outside click and Escape. mousedown beats click so the popover
  // doesn't flicker when a listener clicks a different control elsewhere in
  // the header.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onPick = useCallback(
    (id: string | null) => {
      ctx?.setOverride(id);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [ctx],
  );

  // Bail out before the provider's first poll resolves — the trigger has
  // nothing useful to open.
  if (!ctx || ctx.themes.length === 0) return null;

  const { themes, stationActiveId, overrideId, effectiveId } = ctx;

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={popoverId}
        aria-label="Choose theme"
        title="Choose theme"
        className={cn(
          'v3-focus inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 leading-none',
          variant === 'admin' ? 'caption text-muted' : 'text-muted hover:text-ink',
        )}
      >
        <Palette className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="menu"
          aria-label="Themes"
          className={cn(
            // bg-[var(--field)] (not bg-bg) lifts the panel off the page: the
            // page background is exactly --bg, so a bg-bg panel reads as
            // transparent — content and chrome show across it. --field is the
            // per-theme "raised surface" nudge, so the menu stays opaque and
            // distinct in every theme. A real drop shadow + ring seal the edge.
            'absolute z-50 mt-1 grid w-[min(280px,calc(100vw-2rem))] gap-1 border border-ink bg-[var(--field)] p-2',
            'shadow-[0_16px_44px_-12px_rgba(0,0,0,0.7)] ring-1 ring-black/10',
            // Anchor the popover to the trigger; pull it left so the right
            // edge lines up with the icon — keeps the panel inside the
            // viewport when the trigger sits flush with the right gutter.
            'top-full right-0',
          )}
        >
          <span className="v3-eyebrow border-b border-soft-border px-1 pb-1 text-[10px] tracking-[0.3em]">
            Theme
          </span>
          {themes.map(t => {
            const isActive = t.id === effectiveId;
            return (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => onPick(t.id)}
                className={cn(
                  'flex w-full items-center gap-2 border px-2 py-1.5 text-left',
                  isActive
                    ? 'border-vermilion bg-[var(--ink-softer)]'
                    : 'border-soft-border bg-bg hover:bg-[var(--overlay)]',
                )}
              >
                <span className="inline-flex shrink-0 border border-ink" aria-hidden="true">
                  {SWATCH_KEYS.map(k => (
                    <Swatch key={k} color={t.tokens[k]} />
                  ))}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-[11px] font-bold tracking-[0.12em] uppercase">
                    {t.name}
                  </span>
                  <span className="truncate text-[10px] leading-[1.3] text-muted">
                    {t.description || (t.mode === 'dark' ? 'Dark palette' : 'Light palette')}
                  </span>
                </span>
              </button>
            );
          })}

          {/* Reset row — only meaningful when an override is in effect; muted
              when there's nothing to clear so it doesn't draw the eye. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => onPick(null)}
            disabled={!overrideId}
            className={cn(
              'mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-[10px] tracking-[0.2em] text-muted uppercase',
              overrideId ? 'cursor-pointer hover:text-ink' : 'cursor-default opacity-60',
            )}
          >
            ↺ Use station default
            {stationActiveId && (
              <span className="ml-1 normal-case opacity-70">
                ({themes.find(t => t.id === stationActiveId)?.name ?? stationActiveId})
              </span>
            )}
          </button>
        </div>
      )}
    </span>
  );
}
