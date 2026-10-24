'use client';

// Skin precedence: listener override, station default, built-in fallback. Contained showcases
// follow the remote station.

import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useThemeSwitcher } from '@/components/ThemeProvider';
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
import { StationPasswordGate, useStationAuth } from './StationGate';

export interface PlayerShellProps {
  /** Explicit skin — bypasses registry resolution (previews, tests). */
  skin?: SkinComponent;
  /** Rendered inside a showcase frame (landing page) rather than full-page:
   *  absolute instead of fixed positioning, and dialogs portal into the
   *  frame. */
  contained?: boolean;
}

export default function PlayerShell({ skin, contained = false }: PlayerShellProps) {
  return (
    <PlayerCoreProvider personalScrobble={!contained}>
      <ShellChrome skin={skin} contained={contained} />
    </PlayerCoreProvider>
  );
}

/** Drop SKIN_INIT_SCRIPT's pre-paint hide. */
function revealShell(): void {
  if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-skin-pending');
}

/** Rendered beside the skin inside its Suspense boundary, so its effect runs
 *  only once the resolved skin has committed. Revealing on hydration instead
 *  uncovered an empty stage while a non-default skin's chunk was still loading. */
function RevealWhenMounted({ ready }: { ready: boolean }) {
  useEffect(() => { if (ready) revealShell(); }, [ready]);
  return null;
}

/** True when the keypress landed inside an open modal. */
function targetInsideDialog(e?: KeyboardEvent): boolean {
  return e?.target instanceof HTMLElement && e.target.closest('[role="dialog"]') != null;
}

function ShellChrome({ skin, contained }: { skin?: SkinComponent; contained: boolean }) {
  const { attachAudio } = usePlayerAudio();
  const { state } = usePlayerFeed();
  const stationSkinRaw = typeof state.ui?.skin === 'string' && state.ui.skin ? state.ui.skin : null;

  // Hide the shell with SKIN_INIT_SCRIPT until hydration resolves browser skin preferences,
  // avoiding a flash of the default skin.
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
    if (contained || !stationSkinRaw) return;
    // Cache the RESOLVED id: a skin this build doesn't ship falls back to the
    // default, and caching the raw id would pre-paint-hide the shell forever.
    cacheStationSkin(resolveSkinId(stationSkinRaw, null));
  }, [contained, stationSkinRaw]);

  const stationSkinId = stationSkinRaw ?? cachedStation ?? DEFAULT_SKIN_ID;
  const effectiveId = resolveSkinId(stationSkinId, contained ? null : overrideId);

  // A transition, so the outgoing skin stays painted while the incoming one's
  // chunk loads and its lazy wrapper suspends (it does so once even when the
  // chunk is warm). An urgent update swapped in the empty Suspense fallback,
  // and the stage sat blank through React's ~300 ms reveal throttle.
  const setOverride = useCallback((id: string | null) => {
    saveSkinOverride(id);
    startTransition(() => setOverrideId(id));
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

  // Skip skin/theme cycling inside dialogs so shortcuts do not unmount an active modal.
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

  // The <audio> element lives in the shell, so a skin swap never interrupts
  // playback.
  const Skin = skin ?? SKIN_COMPONENTS[effectiveId] ?? DEFAULT_SKIN_COMPONENT;

  // Private-station gate (#478): no skin and no <audio> element until the
  // password is accepted. 'checking' counts as hidden, so a stored token
  // still being validated can't flash the face at a locked-out visitor.
  const auth = useStationAuth();
  const hideFace = state.privacy?.privatePlayer === true && auth.phase !== 'ok';
  // The password gate renders no skin, so nothing inside the boundary would
  // ever reveal the shell around it.
  useEffect(() => { if (hydrated && hideFace) revealShell(); }, [hydrated, hideFace]);

  return (
    <SkinSelectionProvider value={selection}>
      <div
        ref={rootRef}
        className={cn(
          // sw-player-shell is the pre-paint hide hook (SKIN_INIT_SCRIPT) —
          // full-page shells only; showcase embeds never set/clear the attr.
          contained ? 'absolute' : 'sw-player-shell fixed',
          // sw-theme-stage carries the theme's --texture overlay and --finish
          // filter (globals.css), in a showcase embed too.
          'sw-theme-stage inset-0 overflow-hidden bg-bg text-ink',
        )}
      >
        {hideFace ? (
          // Live-flipped by the /state poll, like themes and skins.
          <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid />
        ) : (
          <>
            <audio ref={attachAudio} crossOrigin="anonymous" preload="auto" />
            {/* Contain skin suspension here so the landing page does not replay its reveal and remain at opacity 0. */}
            <Suspense fallback={null}>
              <Skin contained={contained} portalNode={portalNode} />
              <RevealWhenMounted ready={hydrated} />
            </Suspense>
            <StationPasswordGate phase={auth.phase} unlock={auth.unlock} solid={false} />
          </>
        )}
      </div>
    </SkinSelectionProvider>
  );
}
