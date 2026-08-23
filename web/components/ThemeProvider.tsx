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
  resolveAppearance,
  type Theme,
} from '@/lib/theme';
// The theme registry belongs to *this* deployment, so it always goes through the
// same-origin default client — never a showcase station's origin.
import { defaultStationClient } from '@/lib/stationClient';

interface ThemeContextValue {
  /** Every theme the controller knows about (built-ins + state/themes/*.json). */
  themes: Theme[];
  /** The station's active theme id — what every listener without an override sees. */
  stationActiveId: string | null;
  /** Which level decided `stationActiveId`: an on-air show's own themeId, or the
   *  station default. Null on a controller older than the provenance fields. */
  activeSource: 'show' | 'station' | null;
  /** settings.theme.active — what the admin picker sets, whether or not it won. */
  stationDefault: string | null;
  /** The on-air show that outranked the station default, or null when it didn't. */
  activeShow: { id: string; name: string; themeId: string } | null;
  /** Per-browser override id, or null when none is set. */
  overrideId: string | null;
  /** Override if set and still in the registry, else the station's — what the
   *  picker highlights. */
  effectiveId: string | null;
  /** Save or clear the override and re-apply immediately. null clears it. */
  setOverride: (id: string | null) => void;
  /** Re-read /themes now instead of waiting out the poll. For a caller that
   *  just changed something the next poll would otherwise report 30s late. */
  refreshThemes: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Null on the server and before the provider is mounted. */
export function useThemeSwitcher(): ThemeContextValue | null {
  return useContext(ThemeContext);
}

// App-wide theme syncer, mounted from the root layout. The pre-paint <script> in
// layout.tsx already applied the cached appearance, so this covers a first visit,
// an operator switch since last visit, and the listener override (a stale id —
// theme deleted — silently falls back to the station active).
//
// Light vs dark is a property of the palette, not a listener control: each theme
// declares its own mode. There is no per-browser mode pin.
//
// The 30s poll is the upper bound on how long a listener sees the old theme
// after an operator switch.
export default function ThemeProvider({ children }: { children?: ReactNode }) {
  const [themes, setThemes] = useState<Theme[]>([]);
  const [stationActiveId, setStationActiveId] = useState<string | null>(null);
  const [overrideId, setOverrideIdState] = useState<string | null>(null);
  // Provenance rides the same poll as the palette, so a consumer showing "why
  // is this the theme on screen" can't fall out of step with the paint itself.
  const [activeSource, setActiveSource] = useState<ThemeContextValue['activeSource']>(null);
  const [stationDefault, setStationDefault] = useState<string | null>(null);
  const [activeShow, setActiveShow] = useState<ThemeContextValue['activeShow']>(null);

  // localStorage is only safe to touch in an effect, so SSR renders through
  // cleanly. The pre-paint <script> already painted, so the one-tick lag is invisible.
  useEffect(() => {
    setOverrideIdState(loadThemeOverride());
  }, []);

  // Refs so the polling loop resolves the effective appearance without
  // re-creating itself on every state change.
  const themesRef = useRef<Theme[]>(themes);
  const overrideRef = useRef<string | null>(overrideId);
  themesRef.current = themes;
  overrideRef.current = overrideId;

  // The single place appearance reaches the DOM.
  const applyEffective = useCallback(
    (registry: Theme[], stationId: string | null, override: string | null) => {
      const resolved = resolveAppearance(registry, stationId, override);
      applyAppearance(resolved);
      cacheAppearance(resolved);
    },
    [],
  );

  // Set once the provider is torn down, so a fetch that lands afterwards
  // doesn't repaint the document on its way out. Reset on mount because in
  // StrictMode the first mount is immediately unmounted and remounted.
  const goneRef = useRef(false);
  useEffect(() => {
    goneRef.current = false;
    return () => { goneRef.current = true; };
  }, []);

  // Parameterless so it doesn't change identity on every override change — the
  // override is read from a ref inside the fetch.
  const refreshThemes = useCallback(async () => {
    try {
      const j = await defaultStationClient.themes();
      if (goneRef.current) return;
      setThemes(j.themes);
      setStationActiveId(j.active);
      // Absent on an older controller, which reads as "no provenance to show".
      setActiveSource(j.activeSource ?? null);
      setStationDefault(j.stationDefault ?? null);
      setActiveShow(j.activeShow ?? null);
      applyEffective(j.themes, j.active, overrideRef.current);
    } catch {
      // Network blip — keep the existing CSS variables for the next poll.
    }
  }, [applyEffective]);

  useEffect(() => {
    refreshThemes();
    const id = setInterval(refreshThemes, 30_000);
    return () => clearInterval(id);
  }, [refreshThemes]);

  // Applies without waiting for the next poll.
  const setOverride = useCallback(
    (id: string | null) => {
      saveThemeOverride(id);
      overrideRef.current = id;
      setOverrideIdState(id);
      applyEffective(themesRef.current, stationActiveId, id);
    },
    [applyEffective, stationActiveId],
  );

  // Mirrors resolveAppearance's palette precedence so consumers don't
  // re-implement it.
  const effectiveId =
    (overrideId && themes.some(t => t.id === overrideId) ? overrideId : stationActiveId) ?? null;

  return (
    <ThemeContext.Provider
      value={{
        themes,
        stationActiveId,
        activeSource,
        stationDefault,
        activeShow,
        overrideId,
        effectiveId,
        setOverride,
        refreshThemes,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
