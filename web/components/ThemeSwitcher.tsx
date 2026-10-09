'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LayoutTemplate, Palette, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useDynamicStyle } from '../hooks/useDynamicStyle';
import { useLiteMode } from '../hooks/useLiteMode';
import { useThemeSwitcher } from './ThemeProvider';
import { useSkinSelection } from './skins/SkinContext';
import { SWATCH_KEYS } from '@/lib/theme-tokens.generated';


interface SwatchProps {
  color: string | undefined;
}

// `useDynamicStyle` paints arbitrary per-element colours without the (lint-banned)
// inline `style` prop — it routes through HTMLElement.style via the DOM API.
function Swatch({ color }: SwatchProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useDynamicStyle(ref, { background: color || 'transparent' });
  return <span ref={ref} className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />;
}

// Spans the full grid so the heading sits above its whole row of cards, never
// beside the first one.
function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'v3-eyebrow col-span-full border-b border-soft-border px-1 pb-1 text-[10px] tracking-[0.3em]',
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface ThemeSwitcherProps {
  /** Trigger button text styling, so it picks up the right cluster's font. */
  variant?: 'player' | 'admin';
}

// Per-listener theme + skin switcher; picks persist in localStorage and beat the
// station-wide defaults until reset. Modal rather than a dropdown so it reads the
// same on every skin — an anchored popover collided with each skin's own chrome.
// Renders nothing while the registry is loading or empty.
export default function ThemeSwitcher({ variant = 'player' }: ThemeSwitcherProps) {
  const ctx = useThemeSwitcher();
  // Skin selection only exists inside a PlayerShell; the admin variant gets null
  // and hides the section, as does a build shipping a single skin.
  const skinCtx = useSkinSelection();
  const showSkins = skinCtx != null && skinCtx.skins.length > 1;
  const [open, setOpen] = useState(false);
  const { lite, setLite } = useLiteMode();

  const onPickTheme = useCallback(
    (id: string | null) => {
      ctx?.setOverride(id);
      setOpen(false);
    },
    [ctx],
  );

  if (!ctx || ctx.themes.length === 0) return null;

  const { themes, stationActiveId, overrideId, effectiveId } = ctx;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Appearance — theme and skin"
          title="Appearance"
          className={cn(
            'v3-focus inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 leading-none',
            // The admin header packs this next to other icon-only controls, so it
            // needs a thumb-sized box on a phone; the dense desktop icon returns at sm.
            variant === 'admin'
              ? 'caption min-h-9 min-w-9 text-muted sm:min-h-0 sm:min-w-0'
              : 'text-muted hover:text-ink',
          )}
        >
          <Palette className="h-4 w-4" aria-hidden="true" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="v3-drawer-overlay fixed inset-0 z-40 bg-overlay [backdrop-filter:blur(6px)] [-webkit-backdrop-filter:blur(6px)]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'v3-modal-pop fixed top-1/2 left-1/2 z-50 flex flex-col border border-ink bg-bg text-ink shadow-drawer outline-none',
            '-translate-x-1/2 -translate-y-1/2',
            // Two columns of cards need roughly twice the old 360px; still clamped
            // to the viewport, so a phone gets the grid's single-column fallback.
            'max-h-[calc(100vh-3rem)] w-[min(620px,calc(100vw-2rem))]',
          )}
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-ink px-5 py-3.5">
            <Dialog.Title className="v3-eyebrow m-0 text-[12px] tracking-[0.3em]">
              Appearance
            </Dialog.Title>
            <Dialog.Close
              className="v3-focus cursor-pointer border-0 bg-transparent text-xl leading-none text-muted hover:text-ink"
              aria-label="Close"
            >
              ×
            </Dialog.Close>
          </div>

          <div className="v3-scroll grid flex-1 grid-cols-1 gap-1 overflow-auto px-3 py-3 sm:grid-cols-2">
            <SectionLabel>Theme</SectionLabel>
            {themes.map(t => {
              const isActive = t.id === effectiveId;
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => onPickTheme(t.id)}
                  className={cn(
                    'v3-focus flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left',
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

            <button
              type="button"
              onClick={() => onPickTheme(null)}
              disabled={!overrideId}
              className={cn(
                'col-span-full mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-[10px] tracking-[0.2em] text-muted uppercase',
                overrideId ? 'v3-focus cursor-pointer hover:text-ink' : 'cursor-default opacity-60',
              )}
            >
              ↺ Use station default
              {stationActiveId && (
                <span className="ml-1 normal-case opacity-70">
                  ({themes.find(t => t.id === stationActiveId)?.name ?? stationActiveId})
                </span>
              )}
            </button>

            {showSkins && skinCtx && (
              <>
                <SectionLabel className="mt-2">Player skin</SectionLabel>
                {skinCtx.skins.map(s => {
                  const isActive = s.id === skinCtx.effectiveId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => {
                        skinCtx.setOverride(s.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'v3-focus flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left',
                        isActive
                          ? 'border-vermilion bg-[var(--ink-softer)]'
                          : 'border-soft-border bg-bg hover:bg-[var(--overlay)]',
                      )}
                    >
                      <LayoutTemplate className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-[11px] font-bold tracking-[0.12em] uppercase">
                          {s.name}
                        </span>
                        <span className="truncate text-[10px] leading-[1.3] text-muted">
                          {s.description}
                        </span>
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    skinCtx.setOverride(null);
                    setOpen(false);
                  }}
                  disabled={!skinCtx.overrideId}
                  className={cn(
                    'col-span-full mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-[10px] tracking-[0.2em] text-muted uppercase',
                    skinCtx.overrideId ? 'v3-focus cursor-pointer hover:text-ink' : 'cursor-default opacity-60',
                  )}
                >
                  ↺ Use station skin
                  <span className="ml-1 normal-case opacity-70">
                    ({skinCtx.skins.find(s => s.id === skinCtx.stationSkinId)?.name ?? skinCtx.stationSkinId})
                  </span>
                </button>
              </>
            )}

            {/* Keep the menu open so the listener can see the effect of toggling lite mode. */}
            <button
              type="button"
              aria-pressed={lite}
              onClick={() => setLite(!lite)}
              className={cn(
                'v3-focus col-span-full mt-2 flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left',
                lite
                  ? 'border-vermilion bg-[var(--ink-softer)]'
                  : 'border-soft-border bg-bg hover:bg-[var(--overlay)]',
              )}
            >
              <Zap className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-[11px] font-bold tracking-[0.12em] uppercase">
                  Lite mode
                </span>
                <span className="truncate text-[10px] leading-[1.3] text-muted">
                  Improves performance on low-power screens
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 text-[10px] font-bold tracking-[0.2em] uppercase',
                  lite ? 'text-vermilion' : 'text-muted',
                )}
                aria-hidden="true"
              >
                {lite ? 'On' : 'Off'}
              </span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
