// Station theme application for native.
//
// The web sets CSS variables on <html>. Here we use NativeWind's `vars()` to
// override the same 7 token names (--bg/--ink/--muted/--accent/--overlay/
// --soft-border/--field) on a root <View>, so all `className="bg-bg text-ink"`
// usages resolve to the live station palette. We also expose a resolved
// `colors` object for places that need raw values (Skia canvas, gradients,
// icon `color` props) where class names don't apply.
//
// Token source order: per-listener override (AsyncStorage) → station active
// theme (/themes) → seeded defaults. The override lets a listener pick a
// palette without affecting other listeners (mirrors web lib/theme.ts).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { vars } from 'nativewind';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { View } from 'react-native';
import { useStation } from '@/config/StationContext';
import type { Theme, ThemeMode } from '@/lib/types';

const OVERRIDE_KEY = 'subwave.theme.override.v1';

export interface ResolvedColors {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
  overlay: string;
  softBorder: string;
  field: string;
}

const DARK_DEFAULTS: ResolvedColors = {
  bg: '#100e0c',
  ink: '#ece6dc',
  muted: '#c1c0bd',
  accent: '#d94b2a',
  overlay: 'rgba(0,0,0,0.55)',
  softBorder: 'rgba(255,255,255,0.1)',
  field: '#1b1815',
};

function colorsFromTokens(tokens: Record<string, string>): ResolvedColors {
  return {
    bg: tokens['--bg'] || DARK_DEFAULTS.bg,
    ink: tokens['--ink'] || DARK_DEFAULTS.ink,
    muted: tokens['--muted'] || DARK_DEFAULTS.muted,
    accent: tokens['--accent'] || DARK_DEFAULTS.accent,
    overlay: tokens['--overlay'] || DARK_DEFAULTS.overlay,
    softBorder: tokens['--soft-border'] || DARK_DEFAULTS.softBorder,
    field: tokens['--field'] || DARK_DEFAULTS.field,
  };
}

interface ThemeContextValue {
  themes: Theme[];
  activeId: string | null;
  mode: ThemeMode;
  colors: ResolvedColors;
  /** Pick a per-listener override theme, or null to follow the station. */
  setOverride: (id: string | null) => void;
}

const Ctx = createContext<ThemeContextValue | null>(null);

const DARK_TOKENS: Record<string, string> = {
  '--bg': '#100e0c',
  '--ink': '#ece6dc',
  '--muted': '#c1c0bd',
  '--accent': '#d94b2a',
  '--overlay': 'rgba(0,0,0,0.55)',
  '--soft-border': 'rgba(255,255,255,0.1)',
  '--field': '#1b1815',
};

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { api } = useStation();
  const [themes, setThemes] = useState<Theme[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [override, setOverrideState] = useState<string | null>(null);

  // Load the saved override once.
  useEffect(() => {
    AsyncStorage.getItem(OVERRIDE_KEY).then((v) => setOverrideState(v || null));
  }, []);

  // Fetch the station's theme registry + active id when the station changes.
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api
      .themes()
      .then((payload) => {
        if (!alive) return;
        setThemes(payload.themes || []);
        setActiveId(payload.active || null);
      })
      .catch(() => {
        /* keep defaults */
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const setOverride = useCallback((id: string | null) => {
    setOverrideState(id);
    if (id) AsyncStorage.setItem(OVERRIDE_KEY, id).catch(() => {});
    else AsyncStorage.removeItem(OVERRIDE_KEY).catch(() => {});
  }, []);

  const activeTheme = useMemo<Theme | null>(() => {
    const byId = (id: string | null) => themes.find((t) => t.id === id) || null;
    return byId(override) || byId(activeId) || themes[0] || null;
  }, [themes, override, activeId]);

  const tokens = activeTheme?.tokens ?? DARK_TOKENS;
  const mode: ThemeMode = activeTheme?.mode ?? 'dark';
  const colors = useMemo(() => colorsFromTokens(tokens), [tokens]);

  const value = useMemo<ThemeContextValue>(
    () => ({ themes, activeId, mode, colors, setOverride }),
    [themes, activeId, mode, colors, setOverride],
  );

  return (
    <Ctx.Provider value={value}>
      <View style={[{ flex: 1 }, vars(tokens)]}>{children}</View>
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used within ThemeProvider');
  return v;
}
