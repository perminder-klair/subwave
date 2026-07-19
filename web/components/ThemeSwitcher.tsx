'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LayoutTemplate, Palette, RadioTower, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useDynamicStyle } from '../hooks/useDynamicStyle';
import { useLiteMode } from '../hooks/useLiteMode';
import { useThemeSwitcher } from './ThemeBootstrap';
import { useSkinSelection } from './skins/SkinContext';
import { useChannelList } from '@/lib/channels';

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

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('v3-eyebrow border-b border-soft-border px-1 pb-1 text-[10px] tracking-[0.3em]', className)}>
      {children}
    </span>
  );
}

export interface ThemeSwitcherProps {
  /** Visual variant — player chrome (TopBar) or admin header. Controls the
   *  trigger button's text styling so it picks up the right cluster's font. */
  variant?: 'player' | 'admin';
}

// Per-listener theme + skin switcher. Drops into a header as a palette icon
// and opens a centered modal listing every theme the controller exposes, the
// player skins, and the lite-mode toggle. The listener's picks are persisted
// in localStorage and beat the station-wide defaults until reset. Modal (not a
// dropdown) so it reads the same on every skin regardless of where the icon
// sits — an anchored popover collided with each skin's own chrome.
//
// The component renders nothing while the theme registry is still loading or
// is empty — there's nothing useful to show, and bouncing a button in and out
// would draw the eye more than just appearing once.
export default function ThemeSwitcher({ variant = 'player' }: ThemeSwitcherProps) {
  const ctx = useThemeSwitcher();
  // Skin selection is only available inside a PlayerShell; the admin header
  // variant gets null and hides the section. With a single shipped skin
  // there's nothing to switch, so the section also stays hidden then.
  const skinCtx = useSkinSelection();
  const showSkins = skinCtx != null && skinCtx.skins.length > 1;
  const [open, setOpen] = useState(false);
  const { lite, setLite } = useLiteMode();
  // Sub-station channels — fetched lazily once the modal opens; hidden on a
  // single-station install (empty list) and in the admin header variant.
  // Switching is a navigation: each channel is its own page (/ch/<id>), which
  // keeps the audio element, feed polling, and origin plumbing per-page.
  const { channels, currentId } = useChannelList(open && variant === 'player');
  const showChannels = variant === 'player' && !!channels && channels.length > 0;

  const onPickTheme = useCallback(
    (id: string | null) => {
      ctx?.setOverride(id);
      setOpen(false);
    },
    [ctx],
  );

  // Bail out before the provider's first poll resolves — the trigger has
  // nothing useful to open.
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
            variant === 'admin' ? 'caption text-muted' : 'text-muted hover:text-ink',
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
            'max-h-[calc(100vh-3rem)] w-[min(360px,calc(100vw-2rem))]',
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

          <div className="v3-scroll grid flex-1 gap-1 overflow-auto px-3 py-3">
            {/* Sub-station channels — parallel always-on streams from this
                install. A pick is a plain navigation (each channel is its own
                page with its own audio element + origin), so the row is an
                anchor, not a toggle. Hidden on single-station installs. */}
            {showChannels && channels && (
              <>
                <SectionLabel>Channel</SectionLabel>
                {[{ id: null as string | null, name: 'Main station', href: '/listen' },
                  ...channels.map(c => ({ id: c.id as string | null, name: c.name, href: `/ch/${encodeURIComponent(c.id)}` }))].map(c => {
                  const isActive = c.id === currentId;
                  return (
                    <a
                      key={c.id ?? '__main'}
                      href={c.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'v3-focus flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left no-underline',
                        isActive
                          ? 'border-vermilion bg-[var(--ink-softer)]'
                          : 'border-soft-border bg-bg hover:bg-[var(--overlay)]',
                      )}
                    >
                      <RadioTower className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate text-[11px] font-bold tracking-[0.12em] uppercase">
                        {c.name}
                      </span>
                    </a>
                  );
                })}
              </>
            )}

            <SectionLabel className={showChannels ? 'mt-2' : undefined}>Theme</SectionLabel>
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

            {/* Reset row — only meaningful when an override is in effect; muted
                when there's nothing to clear so it doesn't draw the eye. */}
            <button
              type="button"
              onClick={() => onPickTheme(null)}
              disabled={!overrideId}
              className={cn(
                'mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-[10px] tracking-[0.2em] text-muted uppercase',
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

            {/* Player-skin picker — a different face for the whole player, not
                just a palette. Mirrors the theme rows: listener pick beats the
                station default until reset. */}
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
                    'mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-[10px] tracking-[0.2em] text-muted uppercase',
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

            {/* Low-power toggle. Drops backdrop blur + animations so weak GPUs
                (kiosks, Raspberry Pi) stop re-compositing frosted layers every
                frame. Persists per-browser; a kiosk can also pin it with ?lite=1
                in its start URL. Stays open on toggle so the effect is visible. */}
            <button
              type="button"
              aria-pressed={lite}
              onClick={() => setLite(!lite)}
              className={cn(
                'v3-focus mt-2 flex w-full cursor-pointer items-center gap-2 border px-2 py-1.5 text-left',
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
