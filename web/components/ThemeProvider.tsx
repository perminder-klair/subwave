'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  applyAppearance,
  cacheAppearance,
  loadThemeOverride,
  saveThemeOverride,
  loadModeOverride,
  saveModeOverride,
  resolveAppearance,
  systemMode,
  type Theme,
  type ThemeMode,
} from '@/lib/theme';
// Install-level concern: the theme registry belongs to *this* deployment, so
// this always goes through the same-origin default client — never a showcase
// station's origin.
import { defaultStationClient } from '@/lib/stationClient';

interface ThemeContextValue {
  /** Every theme the controller knows about (built-ins + state/themes/*.json). */
  themes: Theme[];
  /** The station's active theme id — what every listener without an override sees. */
  stationActiveId: string | null;
  /** Per-browser override id, or null when none is set. */
  overrideId: string | null;
  /** Effective theme *selection* (override if set + still in registry, else
   *  station). This is what the picker highlights and what `t` cycles from —
   *  it stays the listener's choice even while a pinned mode pauses it. */
  effectiveId: string | null;
  /** The palette actually on screen, or null when a pinned light/dark mode has
   *  paused it in favour of the built-in base. Differs from `effectiveId` only
   *  in that paused case. */
  paintedId: string | null;
  /** Save or clear the override and re-apply immediately. null clears it. */
  setOverride: (id: string | null) => void;
  /** The listener's pinned light/dark mode, or null when following the active
   *  palette / system preference ("auto"). */
  mode: ThemeMode | null;
  /** What the document is rendering right now, whatever got it there. */
  renderedMode: ThemeMode;
  /** Pin a mode, or hand back to auto with null. */
  setMode: (mode: ThemeMode | null) => void;
  /** Flip the rendered mode — the `d` hotkey and the switcher row. Lands back
   *  on auto whenever auto would render the mode being asked for, so the
   *  listener is never permanently pinned by a single keypress. */
  cycleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read theme state from any client component. Returns null on the server
 *  and before the provider is mounted. */
export function useThemeSwitcher(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

// Bare-letter shortcuts must never fire while the listener is entering text.
// Beyond the obvious form controls that means the popup widgets that implement
// their own first-letter typeahead — Radix's Select/DropdownMenu content is a
// div with a listbox/menu role, not a <select>, so a `d` inside one belongs to
// the widget, not to us.
const TYPEAHEAD_CONTAINERS =
  '[role="listbox"],[role="menu"],[role="menubar"],[role="tree"],[role="grid"],[role="combobox"]';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return !!target.closest(TYPEAHEAD_CONTAINERS);
}

// Single, app-wide theme syncer + provider. Mounted from the root layout so
// every page (player, admin, landing, onboarding, setup-guide) gets the
// station-wide theme without each one having to wire up a fetcher.
//
// The pre-paint <script> in layout.tsx already applied the cached appearance,
// so this only handles:
//   1. First visit (no cache) — fetch + apply + populate cache.
//   2. Operator changed the theme in admin since the last visit — refresh.
//   3. A listener override beats the station — apply it whenever it exists in
//      the live registry. Stale ids (theme deleted under our feet) silently
//      fall back to the station active.
//   4. A listener pinned light/dark — see resolveAppearance for how that
//      interacts with the palette.
//
// 30 s poll cadence is the upper bound on how long a listener sees the old
// theme after an operator switch. Cheap call (returns a tiny JSON blob);
// every-5s would be wasteful and every-N-minutes feels stale.
export default function ThemeProvider({ children }: { children?: ReactNode }) {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [stationActiveId, setStationActiveId] = useState<string | null>(null);
  const [overrideId, setOverrideIdState] = useState<string | null>(null);
  const [mode, setModeState] = useState<ThemeMode | null>(null);
  const [paintedId, setPaintedId] = useState<string | null>(null);
  const [systemDark, setSystemDark] = useState(false);

  // Read the overrides on mount so SSR can render through cleanly — localStorage
  // is only safe to touch in an effect. The pre-paint <script> already painted
  // the right tokens + mode, so a one-tick lag in state is invisible.
  useEffect(() => {
    setOverrideIdState(loadThemeOverride());
    setModeState(loadModeOverride());
  }, []);

  // Track `prefers-color-scheme` so `renderedMode` stays honest while the
  // listener is on auto with no palette. The CSS repaints itself off the media
  // query; this is only so the UI can *say* which way it went.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // Hold the latest themes + overrides in refs so the polling loop can resolve
  // the effective appearance without re-creating itself on every state change.
  const themesRef = useRef<Theme[]>(themes);
  const overrideRef = useRef<string | null>(overrideId);
  const modeRef = useRef<ThemeMode | null>(mode);
  themesRef.current = themes;
  overrideRef.current = overrideId;
  modeRef.current = mode;

  // Resolve + paint + cache from the latest registry and both overrides. The
  // single place appearance reaches the DOM.
  const applyEffective = useCallback(
    (
      registry: Theme[],
      stationId: string | null,
      override: string | null,
      modeOverride: ThemeMode | null,
    ) => {
      const resolved = resolveAppearance(registry, stationId, override, modeOverride);
      applyAppearance(resolved);
      cacheAppearance(resolved);
      setPaintedId(resolved.theme?.id ?? null);
    },
    [],
  );

  // Poll /themes on mount + every 30s. The effect is parameterless so it
  // doesn't restart on every override change — the overrides are read from
  // refs inside the fetch.
  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const j = await defaultStationClient.themes();
        if (cancelled) return;
        setThemes(j.themes);
        setStationActiveId(j.active);
        applyEffective(j.themes, j.active, overrideRef.current, modeRef.current);
      } catch {
        // Network blip — keep the existing CSS variables. The next poll will
        // sort it out, and the pre-paint cache covers the meantime.
      }
    };

    refresh();
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [applyEffective]);

  // Public setter the switcher buttons call. Persists to localStorage, updates
  // local state, and applies the theme without waiting for the next poll.
  const setOverride = useCallback(
    (id: string | null) => {
      saveThemeOverride(id);
      overrideRef.current = id;
      setOverrideIdState(id);
      applyEffective(themesRef.current, stationActiveId, id, modeRef.current);
    },
    [applyEffective, stationActiveId],
  );

  // Pin (or, with null, release) the explicit light/dark mode. Applies
  // immediately; releasing re-applies the active palette's own mode.
  const setMode = useCallback(
    (next: ThemeMode | null) => {
      saveModeOverride(next);
      // Keep the ref in lock-step so the resolve below sees the new value on
      // this same tick (releasing must not re-apply the old mode).
      modeRef.current = next;
      setModeState(next);
      applyEffective(themesRef.current, stationActiveId, overrideRef.current, next);
    },
    [applyEffective, stationActiveId],
  );

  // Auto is a real, reachable state, not just the initial one: flipping *back*
  // releases the pin rather than pinning the opposite mode. Without this a
  // single stray `d` would detach the listener from the operator's palette
  // forever, since a two-state toggle can only ever move between light and
  // dark.
  const cycleMode = useCallback(() => {
    const auto = resolveAppearance(themesRef.current, stationActiveId, overrideRef.current, null);
    const autoMode = auto.mode ?? systemMode();
    const rendered = modeRef.current ?? autoMode;
    const next: ThemeMode = rendered === 'dark' ? 'light' : 'dark';
    setMode(autoMode === next ? null : next);
  }, [setMode, stationActiveId]);

  // Global dark-mode shortcut: bare `d`, ignoring auto-repeat, modifier combos,
  // and anything aimed at a text field or a typeahead popup.
  const cycleModeRef = useRef(cycleMode);
  cycleModeRef.current = cycleMode;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'd') return;
      if (isTypingTarget(e.target)) return;
      // Stand down while focus is inside an open modal, matching the player
      // shell's s/t cycling — a keypress aimed at a dialog shouldn't restyle
      // the app behind it.
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]')) return;
      // Deliberately neither preventDefault nor act inline. Several listeners
      // share this keypress — each skin's shortcut map, and the "press any key"
      // tune-in gate that doubles as the browser's audio-unblock gesture — and
      // which one is registered first is mount-order dependent (skins are lazy
      // chunks, so they can register *after* this root-level provider). Handing
      // the press back and settling on the next task lets every other listener
      // run first; if any of them claimed it, `defaultPrevented` is now true
      // and we stand down. Tuning in always beats changing the theme.
      setTimeout(() => {
        if (e.defaultPrevented) return;
        cycleModeRef.current();
      }, 0);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // The resolved effective id — what the picker highlights as "active".
  // Mirrors resolveAppearance's palette precedence so context consumers don't
  // need to re-implement it.
  const effectiveId =
    (overrideId && themes.some(t => t.id === overrideId) ? overrideId : stationActiveId) ?? null;
  const renderedMode: ThemeMode =
    mode ?? themes.find(t => t.id === effectiveId)?.mode ?? (systemDark ? 'dark' : 'light');

  return (
    <ThemeContext.Provider
      value={{
        themes,
        stationActiveId,
        overrideId,
        effectiveId,
        paintedId,
        setOverride,
        mode,
        renderedMode,
        setMode,
        cycleMode,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
