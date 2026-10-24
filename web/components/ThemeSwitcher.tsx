'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Headphones, Palette, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { resolveFont, type Theme } from '@/lib/theme';
import { useDynamicStyle } from '../hooks/useDynamicStyle';
import { useLiteMode } from '../hooks/useLiteMode';
import { useThemeSwitcher } from './ThemeProvider';
import { useSkinSelection } from './skins/SkinContext';
import { usePersonalScrobbleContext } from './player/PersonalScrobbleContext';

// The skin miniatures only matter once the menu is open, so they load with it
// rather than riding every skin's first paint; hovering or focusing the trigger
// starts the fetch early. Loaded by hand, not through next/dynamic: its lazy
// component suspends on the first render that meets it however warm the chunk
// is, and with `ssr` on and no `loading` it brings no Suspense boundary of its
// own — so the first open suspended the whole player. The face blanked, sat
// hidden through React's reveal throttle (~300ms) and remounted its effects.
type SkinPreviewComponent = typeof import('./skins/SkinPreview').default;
let skinPreview: SkinPreviewComponent | null = null;
let skinPreviewLoad: Promise<SkinPreviewComponent> | null = null;
function loadSkinPreview(): Promise<SkinPreviewComponent> {
  skinPreviewLoad ??= import('./skins/SkinPreview').then(
    m => (skinPreview = m.default),
    err => {
      skinPreviewLoad = null;
      throw err;
    },
  );
  return skinPreviewLoad;
}
const prefetchSkinPreview = () => { loadSkinPreview().catch(() => {}); };

// Each specimen tile sets its theme's display face, and next/font fetches a face
// only once something uses it — so the first open after a load fetched five or
// six at once, blanked their text for the block period and reflowed when they
// landed. Every later open was smooth. A stack names its faces through the
// next/font variables, which `document.fonts.load` can't read, so they resolve
// against <html> first.
function warmDisplayFonts(fontIds: string[]) {
  const root = getComputedStyle(document.documentElement);
  for (const id of new Set(fontIds)) {
    const stack = resolveFont(id).replace(/var\((--[\w-]+)\)/g, (_, name: string) => root.getPropertyValue(name).trim() || 'serif');
    void document.fonts.load(`22px ${stack}`).catch(() => {});
  }
}

// A theme as a type specimen: its own paper, ink and display face, with the
// accent as a stripe along the foot. The colours are scoped to this one tile, so
// it shows the theme whatever is painted around it. `useDynamicStyle` sets them
// without the (lint-banned) inline `style` prop.
function ThemeSpecimen({ theme }: { theme: Theme }) {
  const ref = useRef<HTMLSpanElement>(null);
  const t = theme.tokens;
  useDynamicStyle(ref, {
    '--chip-bg': t['--bg'],
    '--chip-ink': t['--ink'],
    '--chip-accent': t['--accent'],
    fontFamily: resolveFont(t['--display-font'] ?? 'fraunces'),
  });
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="relative grid size-full place-items-center overflow-hidden bg-[var(--chip-bg,var(--bg))] text-[var(--chip-ink,var(--ink))]"
    >
      <span className="text-[22px] leading-none">Aa</span>
      <span className="absolute inset-x-0 bottom-0 h-1.5 bg-[var(--chip-accent,var(--accent))]" />
    </span>
  );
}

// Names whatever is under the cursor or focus, else the current pick, so the
// tiles can stay wordless and the menu stays one row of themes tall.
function Readout({ name, description }: { name: string; description?: string }) {
  return (
    <p className="m-0 flex min-w-0 items-baseline gap-2 px-1 font-mono text-[10px] leading-[1.4]">
      <span className="shrink-0 text-vermilion" aria-hidden="true">▸</span>
      <span className="shrink-0 font-bold tracking-[0.14em] text-ink uppercase">{name}</span>
      {description && <span className="truncate text-muted">{description}</span>}
    </p>
  );
}

interface SectionHeadProps {
  label: string;
  /** Whether the listener has an override to clear. */
  overridden: boolean;
  /** What the station is running, named on the reset button. */
  stationName: string | null;
  resetLabel: string;
  followingLabel: string;
  onReset: () => void;
}

// The section's reset lives on its heading row: a button while an override is
// set, a quiet status line while the listener follows the station.
function SectionHead({ label, overridden, stationName, resetLabel, followingLabel, onReset }: SectionHeadProps) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-soft-border px-1 pb-1">
      <span className="v3-eyebrow text-[10px] tracking-[0.3em]">{label}</span>
      {overridden ? (
        <button
          type="button"
          onClick={onReset}
          className="v3-focus min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-[9px] tracking-[0.2em] text-muted uppercase hover:text-ink"
        >
          ↺ {resetLabel}
          {stationName && <span className="ml-1 normal-case opacity-70">· {stationName}</span>}
        </button>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[9px] tracking-[0.2em] text-muted uppercase">
          <span className="size-1.5 rounded-full bg-vermilion" aria-hidden="true" />
          {followingLabel}
        </span>
      )}
    </div>
  );
}

export interface ThemeSwitcherProps {
  /** Trigger button text styling, so it picks up the right cluster's font. */
  variant?: 'player' | 'admin';
  /** Extra classes for the trigger, e.g. a skin's alignment nudge. */
  className?: string;
}

// Per-listener theme + skin switcher, plus this browser's lite-mode toggle; picks
// persist in localStorage and beat the station-wide defaults until reset. Modal rather than a dropdown so it reads the
// same on every skin — an anchored popover collided with each skin's own chrome.
// Renders nothing while the registry is loading or empty.
export default function ThemeSwitcher({ variant = 'player', className }: ThemeSwitcherProps) {
  const ctx = useThemeSwitcher();
  // Skin selection only exists inside a PlayerShell; the admin variant gets null
  // and hides the section, as does a build shipping a single skin.
  const skinCtx = useSkinSelection();
  const showSkins = skinCtx != null && skinCtx.skins.length > 1;
  const [open, setOpen] = useState(false);
  const [peekTheme, setPeekTheme] = useState<string | null>(null);
  const [peekSkin, setPeekSkin] = useState<string | null>(null);
  const [, setPreviewLoaded] = useState(false);
  const activeChipRef = useRef<HTMLButtonElement>(null);
  const { lite, setLite } = useLiteMode();
  const personalScrobble = usePersonalScrobbleContext();

  // Opened before the warm-up below landed: the cards draw empty and fill in
  // when the chunk arrives, without suspending anything around them.
  useEffect(() => {
    if (!open || !showSkins || skinPreview) return;
    let live = true;
    loadSkinPreview().then(() => { if (live) setPreviewLoaded(true); }, () => {});
    return () => { live = false; };
  }, [open, showSkins]);

  // A custom theme can push the pick past the strip's visible end.
  useEffect(() => {
    if (open) activeChipRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open]);

  // Warm what the first open would otherwise fetch mid-animation — the
  // miniatures' chunk and the specimens' faces — once the page is idle, so the
  // first open runs like every later one. Keyed by the face list rather than the
  // registry array, which the theme poll replaces.
  const specimenFonts = ctx?.themes.map(t => t.tokens['--display-font'] ?? 'fraunces').join(',') ?? '';
  useEffect(() => {
    if (!specimenFonts) return;
    const warm = () => {
      if (showSkins) prefetchSkinPreview();
      warmDisplayFonts(specimenFonts.split(','));
    };
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(warm, { timeout: 4000 });
      return () => cancelIdleCallback(handle);
    }
    const handle = setTimeout(warm, 2000);
    return () => clearTimeout(handle);
  }, [specimenFonts, showSkins]);

  if (!ctx || ctx.themes.length === 0) return null;

  const { themes, stationActiveId, overrideId, effectiveId } = ctx;
  const shownTheme = themes.find(t => t.id === peekTheme) ?? themes.find(t => t.id === effectiveId);
  const shownSkin = skinCtx?.skins.find(s => s.id === peekSkin)
    ?? skinCtx?.skins.find(s => s.id === skinCtx.effectiveId);
  const SkinPreview = skinPreview;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={next => {
        setOpen(next);
        setPeekTheme(null);
        setPeekSkin(null);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Appearance — theme and skin"
          title="Appearance"
          onPointerEnter={showSkins ? prefetchSkinPreview : undefined}
          onFocus={showSkins ? prefetchSkinPreview : undefined}
          className={cn(
            'v3-focus inline-flex shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 leading-none',
            // The admin header packs this next to other icon-only controls, so it
            // needs a thumb-sized box on a phone; the dense desktop icon returns at sm.
            variant === 'admin'
              ? 'caption min-h-9 min-w-9 text-muted sm:min-h-0 sm:min-w-0'
              : 'text-muted hover:text-ink',
            className,
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
            // Four skin cards a row want the room; the admin's theme strip alone
            // doesn't. Clamped to the viewport either way.
            'max-h-[calc(100vh-3rem)]',
            showSkins ? 'w-[min(760px,calc(100vw-2rem))]' : 'w-[min(560px,calc(100vw-2rem))]',
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

          <div className="v3-scroll grid flex-1 content-start gap-4 overflow-auto px-4 py-4">
            <section className="grid gap-1.5">
              <SectionHead
                label="Theme"
                overridden={!!overrideId}
                stationName={
                  stationActiveId
                    ? (themes.find(t => t.id === stationActiveId)?.name ?? stationActiveId)
                    : null
                }
                resetLabel="Use station default"
                followingLabel="Station default"
                onReset={() => ctx.setOverride(null)}
              />
              {/* One row: the tiles widen to fill it, then hold at a square and
                  scroll sideways once custom themes outgrow it. A pick
                  repaints at once and the menu stays open, so the skin cards below
                  recolour too and a listener can try palettes before closing. The
                  vertical padding keeps the active ring and hover lift unclipped. */}
              <div
                className="v3-scroll flex snap-x snap-mandatory scroll-px-3 gap-2 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)] px-3 py-2.5"
                onPointerLeave={() => setPeekTheme(null)}
              >
                {themes.map(t => {
                  const isActive = t.id === effectiveId;
                  return (
                    <button
                      key={t.id}
                      ref={isActive ? activeChipRef : undefined}
                      type="button"
                      aria-pressed={isActive}
                      aria-label={t.name}
                      onClick={() => ctx.setOverride(t.id)}
                      onPointerEnter={() => setPeekTheme(t.id)}
                      onFocus={() => setPeekTheme(t.id)}
                      onBlur={() => setPeekTheme(null)}
                      className={cn(
                        'v3-focus h-14 max-w-28 flex-[1_0_3.5rem] cursor-pointer snap-start border p-0 transition-[translate,box-shadow] duration-150',
                        isActive
                          ? 'border-vermilion ring-2 ring-vermilion ring-offset-2 ring-offset-bg'
                          : 'border-ink hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--ink)]',
                      )}
                    >
                      <ThemeSpecimen theme={t} />
                    </button>
                  );
                })}
              </div>
              {shownTheme && (
                <Readout
                  name={shownTheme.name}
                  description={
                    shownTheme.description || (shownTheme.mode === 'dark' ? 'Dark palette' : 'Light palette')
                  }
                />
              )}
            </section>

            {showSkins && skinCtx && (
              <section className="grid gap-1.5">
                <SectionHead
                  label="Player skin"
                  overridden={!!skinCtx.overrideId}
                  stationName={skinCtx.skins.find(s => s.id === skinCtx.stationSkinId)?.name ?? skinCtx.stationSkinId}
                  resetLabel="Use station skin"
                  followingLabel="Station skin"
                  onReset={() => {
                    skinCtx.setOverride(null);
                    setOpen(false);
                  }}
                />
                {/* Each card is the `group` its miniature's motion gates on: it
                    idles until hovered, and the live pick keeps playing. A skin
                    pick swaps the face this menu lives in, so it closes. */}
                <div
                  className="grid grid-cols-2 gap-2 px-1 pt-1.5 sm:grid-cols-4"
                  onPointerLeave={() => setPeekSkin(null)}
                >
                  {skinCtx.skins.map((s, i) => {
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
                        onPointerEnter={() => setPeekSkin(s.id)}
                        onFocus={() => setPeekSkin(s.id)}
                        onBlur={() => setPeekSkin(null)}
                        className={cn(
                          'v3-focus group flex cursor-pointer flex-col overflow-hidden border bg-bg p-0 text-left transition-[translate,box-shadow] duration-200',
                          isActive
                            ? 'border-vermilion shadow-[0_0_0_1px_var(--accent)]'
                            : 'border-ink hover:-translate-y-0.5 hover:shadow-[3px_3px_0_0_var(--ink)]',
                        )}
                      >
                        <span
                          className={cn(
                            'relative block aspect-[16/10] w-full overflow-hidden border-b',
                            isActive ? 'border-vermilion bg-[var(--accent-soft)]' : 'border-ink bg-field',
                          )}
                        >
                          {SkinPreview && <SkinPreview id={s.id} />}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
                          {isActive && (
                            <span className="size-1.5 shrink-0 rounded-full bg-vermilion" aria-hidden="true" />
                          )}
                          <span
                            className={cn(
                              'truncate text-[10px] font-bold tracking-[0.14em] uppercase',
                              isActive && 'text-vermilion',
                            )}
                          >
                            {s.name}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[8px] font-bold tracking-[0.14em] text-muted">
                            {String(i + 1).padStart(2, '0')}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {shownSkin && <Readout name={shownSkin.name} description={shownSkin.description} />}
              </section>
            )}

            {personalScrobble?.authenticated && (
              <section className="grid gap-1.5">
                <div className="border-b border-soft-border px-1 pb-1">
                  <span className="v3-eyebrow text-[10px] tracking-[0.3em]">Listening history</span>
                </div>
                <button
                  type="button"
                  aria-pressed={personalScrobble.enabled}
                  disabled={!personalScrobble.enabled && personalScrobble.available !== true}
                  onClick={() => personalScrobble.setEnabled(!personalScrobble.enabled)}
                  className={cn(
                    'v3-focus mx-1 mt-1.5 flex cursor-pointer items-center gap-2.5 border px-3 py-2 text-left transition-colors duration-150',
                    personalScrobble.enabled
                      ? 'border-vermilion bg-[var(--accent-soft)]'
                      : 'border-ink bg-bg hover:bg-[var(--overlay)]',
                    !personalScrobble.enabled
                      && personalScrobble.available !== true
                      && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <Headphones
                    className={cn(
                      'h-4 w-4 shrink-0',
                      personalScrobble.enabled ? 'text-vermilion' : 'text-muted',
                    )}
                    aria-hidden="true"
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[10px] font-bold tracking-[0.14em] uppercase">
                      Scrobble my listening
                    </span>
                    <span className="truncate text-[10px] leading-[1.3] text-muted">
                      {personalScrobble.available === null
                        ? 'Checking configured accounts…'
                        : personalScrobble.available
                          ? `Only while this player is audible · ${personalScrobble.providers.join(' + ')}`
                          : 'Configure a provider in admin and leave its station-wide switch off'}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 font-mono text-[9px] font-bold tracking-[0.2em] uppercase',
                      personalScrobble.enabled ? 'text-vermilion' : 'text-muted',
                    )}
                    aria-hidden="true"
                  >
                    {personalScrobble.enabled ? 'On' : 'Off'}
                  </span>
                </button>
              </section>
            )}

            {/* Lite mode belongs to this browser, not the station, so its heading
                carries no reset. The menu stays open so the listener sees the
                blur and motion drop away behind it. */}
            <section className="grid gap-1.5">
              <div className="border-b border-soft-border px-1 pb-1">
                <span className="v3-eyebrow text-[10px] tracking-[0.3em]">Performance</span>
              </div>
              <button
                type="button"
                aria-pressed={lite}
                onClick={() => setLite(!lite)}
                className={cn(
                  'v3-focus mx-1 mt-1.5 flex cursor-pointer items-center gap-2.5 border px-3 py-2 text-left transition-colors duration-150',
                  lite
                    ? 'border-vermilion bg-[var(--accent-soft)]'
                    : 'border-ink bg-bg hover:bg-[var(--overlay)]',
                )}
              >
                <Zap className={cn('h-4 w-4 shrink-0', lite ? 'text-vermilion' : 'text-muted')} aria-hidden="true" />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="truncate text-[10px] font-bold tracking-[0.14em] uppercase">Lite mode</span>
                  <span className="truncate text-[10px] leading-[1.3] text-muted">
                    Drops blur and animation, for low-power screens
                  </span>
                </span>
                <span
                  className={cn(
                    'shrink-0 font-mono text-[9px] font-bold tracking-[0.2em] uppercase',
                    lite ? 'text-vermilion' : 'text-muted',
                  )}
                  aria-hidden="true"
                >
                  {lite ? 'On' : 'Off'}
                </span>
              </button>
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
