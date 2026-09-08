// Station theme application. NativeWind's `vars()` overrides the same 7 token
// names on a root <View> so `className="bg-bg text-ink"` resolves to the live
// palette; `colors` exposes raw values for Skia, gradients and icon props.
//
// Token source order: per-listener override (AsyncStorage) → station active
// theme (/themes) → seeded defaults.

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

// Light-mode fallbacks. A light theme can ship a parseable dark `--ink` next
// to an oklch()/color-mix() `--bg`/`--field` RN can't parse; falling those back
// to the dark defaults gives dark text on a dark field. Values track the seeded
// `classic-light` palette.
const LIGHT_DEFAULTS: ResolvedColors = {
  bg: '#f3efe6',
  ink: '#161412',
  muted: '#7a736a',
  accent: '#d94b2a',
  overlay: 'rgba(0,0,0,0.05)',
  softBorder: 'rgba(0,0,0,0.08)',
  field: '#e1ddd4',
};

// RN and Skia parse only hex / rgb(a) / hsl(a) / named colors, not the oklch()
// and color-mix() the /themes registry uses. Anything unparseable falls back
// to the token's default for the mode.
const RN_COLOR_RE = /^(#([0-9a-f]{3,8})|rgba?\(|hsla?\(|transparent$)/i;
function safeColor(value: string | undefined, fallback: string): string {
  if (value && RN_COLOR_RE.test(value.trim())) return value;
  return fallback;
}

function colorsFromTokens(
  tokens: Record<string, string>,
  mode: ThemeMode,
): ResolvedColors {
  const d = mode === 'light' ? LIGHT_DEFAULTS : DARK_DEFAULTS;
  return {
    bg: safeColor(tokens['--bg'], d.bg),
    ink: safeColor(tokens['--ink'], d.ink),
    muted: safeColor(tokens['--muted'], d.muted),
    accent: safeColor(tokens['--accent'], d.accent),
    overlay: safeColor(tokens['--overlay'], d.overlay),
    softBorder: safeColor(tokens['--soft-border'], d.softBorder),
    field: safeColor(tokens['--field'], d.field),
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
  const colors = useMemo(() => colorsFromTokens(tokens, mode), [tokens, mode]);

  // vars() gets the sanitized colors, not the raw tokens, since className
  // colors resolve through these and must be RN-parseable.
  const safeTokens = useMemo(
    () => ({
      '--bg': colors.bg,
      '--ink': colors.ink,
      '--muted': colors.muted,
      '--accent': colors.accent,
      '--overlay': colors.overlay,
      '--soft-border': colors.softBorder,
      '--field': colors.field,
    }),
    [colors],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ themes, activeId, mode, colors, setOverride }),
    [themes, activeId, mode, colors, setOverride],
  );

  return (
    <Ctx.Provider value={value}>
      <View style={[{ flex: 1 }, vars(safeTokens)]}>{children}</View>
    </Ctx.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used within ThemeProvider');
  return v;
}
