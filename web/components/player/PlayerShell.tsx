'use client';

// The player chrome every skin gets for free: the headless core provider
// (feed poll, audio engine, signal probe, OS media session), the <audio>
// element skins tap for the Web Audio visualiser, the contained-embedding
// portal plumbing, the toaster — and the skin resolution itself.
//
// Skin precedence mirrors the theme system: listener override (localStorage)
// beats the station default (ui.skin on GET /state) beats the built-in
// fallback. The last-seen station skin is cached so a returning visitor
// boots straight into the right skin; contained showcases follow the remote
// station strictly (no override, no cache poisoning).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/toaster';
import { useThemeSwitcher } from '@/components/ThemeBootstrap';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/lib/cn';
import {
  cacheStationSkin,
  loadCachedStationSkin,
  loadSkinOverride,
  saveSkinOverride,
} from '@/lib/skin';
import {
  DEFAULT_SKIN_COMPONENT,
  DEFAULT_SKIN_ID,
  SKINS,
  SKIN_COMPONENTS,
  resolveSkinId,
} from '@/components/skins';
import { SkinSelectionProvider, type SkinSelection } from '@/components/skins/SkinContext';
import type { SkinComponent } from '@/components/skins/types';
import { PlayerCoreProvider, usePlayerAudio, usePlayerFeed } from './PlayerCore';

export interface PlayerShellProps {
  /** Explicit skin — bypasses registry resolution (previews, tests). */
  skin?: SkinComponent;
  /** Rendered inside a showcase frame (landing page) rather than full-page:
   *  absolute instead of fixed positioning, dialogs portal into the frame,
   *  no toaster. */
  contained?: boolean;
}

export default function PlayerShell({ skin, contained = false }: PlayerShellProps) {
  return (
    <PlayerCoreProvider>
      <ShellChrome skin={skin} contained={contained} />
    </PlayerCoreProvider>
  );
}

/** True when the keypress landed inside an open modal (see the cycling
 *  shortcuts below for why the shell stands down there). */
function targetInsideDialog(e?: KeyboardEvent): boolean {
  return e?.target instanceof HTMLElement && e.target.closest('[role="dialog"]') != null;
}

function ShellChrome({ skin, contained }: { skin?: SkinComponent; contained: boolean }) {
  const { audioRef } = usePlayerAudio();
  const { state } = usePlayerFeed();
  const stationSkinRaw = typeof state.ui?.skin === 'string' && state.ui.skin ? state.ui.skin : null;

  // localStorage is effect-only (SSR renders the default), so a listener with
  // an override or a cached non-default station skin swaps one tick after
  // hydration. SKIN_INIT_SCRIPT hides the shell pre-paint in that case
  // (data-skin-pending on <html>), so the swap shows as a quiet blank
  // instead of a flash of the default face; `hydrated` lifts the curtain
  // after the resolved skin is in the tree.
  const [overrideId, setOverrideId] = useState<string | null>(null);
  const [cachedStation, setCachedStation] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (contained) return; // showcases follow the remote station strictly
    setOverrideId(loadSkinOverride());
    setCachedStation(loadCachedStationSkin());
    setHydrated(true);
  }, [contained]);
  useEffect(() => {
    if (!hydrated || typeof document === 'undefined') return;
    document.documentElement.removeAttribute('data-skin-pending');
  }, [hydrated]);
  useEffect(() => {
    if (contained || !stationSkinRaw) return;
    // Cache the RESOLVED id, not the raw one: a station skin this build
    // doesn't ship (newer controller, API-set slug) resolves to the default,
    // and caching the raw id would make SKIN_INIT_SCRIPT pre-paint-hide the
    // shell on every future load only to render the default anyway.
    cacheStationSkin(resolveSkinId(stationSkinRaw, null));
  }, [contained, stationSkinRaw]);

  const stationSkinId = stationSkinRaw ?? cachedStation ?? DEFAULT_SKIN_ID;
  const effectiveId = resolveSkinId(stationSkinId, contained ? null : overrideId);

  const setOverride = useCallback((id: string | null) => {
    saveSkinOverride(id);
    setOverrideId(id);
  }, []);

  const selection = useMemo<SkinSelection>(
    () => ({
      skins: SKINS,
      stationSkinId: resolveSkinId(stationSkinId, null),
      overrideId,
      effectiveId,
      setOverride,
    }),
    [stationSkinId, overrideId, effectiveId, setOverride],
  );

  // Shell-level cycling shortcuts — they must work in EVERY skin (a skin
  // without a visible switcher must never strand the listener): `s` cycles
  // the skin override, `t` cycles the theme override. Toasts name the pick
  // so a rapid cycle stays legible. Bare keys are already suppressed while
  // a text field has focus (useKeyboardShortcuts); on top of that, cycling
  // stands down while a skin-owned modal (drawer, shortcuts dialog) has
  // focus — swapping the skin would tear the open modal down mid-use. Radix
  // traps focus inside role="dialog", so the event target is the tell. The
  // skin's OWN shortcut maps deliberately keep working inside drawers
  // (classic switches drawers with 1–4), so this check lives here, not in
  // useKeyboardShortcuts.
  const themeCtx = useThemeSwitcher();
  const cycleSkin = useCallback((e?: KeyboardEvent) => {
    if (contained || targetInsideDialog(e)) return;
    const i = SKINS.findIndex(s => s.id === effectiveId);
    const next = SKINS[(i + 1) % SKINS.length];
    if (!next) return;
    setOverride(next.id);
    toast(`Skin: ${next.name}`);
  }, [contained, effectiveId, setOverride]);
  const cycleTheme = useCallback((e?: KeyboardEvent) => {
    if (contained || targetInsideDialog(e) || !themeCtx || themeCtx.themes.length === 0) return;
    const { themes, effectiveId: themeId, setOverride: setThemeOverride } = themeCtx;
    const i = themes.findIndex(t => t.id === themeId);
    const next = themes[(i + 1) % themes.length];
    if (!next) return;
    setThemeOverride(next.id);
    toast(`Theme: ${next.name}`);
  }, [contained, themeCtx]);
  useKeyboardShortcuts({ s: cycleSkin, t: cycleTheme }, { disabled: contained });

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Drawers/dialogs portal here when contained so they stay inside the frame.
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  useEffect(() => { if (contained) setPortalNode(rootRef.current); }, [contained]);

  // A skin swap remounts the skin subtree, but the <audio> element lives
  // here in the shell — playback never hiccups when the face changes.
  const Skin = skin ?? SKIN_COMPONENTS[effectiveId] ?? DEFAULT_SKIN_COMPONENT;

  return (
    <SkinSelectionProvider value={selection}>
      <div
        ref={rootRef}
        className={cn(
          // sw-player-shell is the pre-paint hide hook (SKIN_INIT_SCRIPT) —
          // full-page shells only; showcase embeds never set/clear the attr.
          contained ? 'absolute' : 'sw-player-shell fixed',
          'inset-0 overflow-hidden bg-bg text-ink',
        )}
      >
        <audio ref={audioRef} crossOrigin="anonymous" preload="auto" />
        <Skin contained={contained} portalNode={portalNode} />
        {!contained && <Toaster />}
      </div>
    </SkinSelectionProvider>
  );
}
