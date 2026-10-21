// Theme precedence: listener override, station theme, seeded defaults.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { vars } from 'nativewind';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View } from 'react-native';
import { useStation } from '@/config/StationContext';
import { useAppActive } from '@/hooks/useAppActive';
import { pollAsync } from '@/lib/poll';
import type { Theme, ThemeMode } from '@/lib/types';

const OVERRIDE_KEY = 'subwave.theme.override.v1';

// Matches the web ThemeProvider. `active` is the effective theme, so an on-air
// show's own theme takes over at the show change on the next read.
const THEME_POLL_MS = 30_000;

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

// Unparseable light-mode backgrounds need light defaults to keep dark text legible.
// These values match the seeded classic-light palette.
const LIGHT_DEFAULTS: ResolvedColors = {
  bg: '#f3efe6',
  ink: '#161412',
  muted: '#7a736a',
  accent: '#d94b2a',
  overlay: 'rgba(0,0,0,0.05)',
  softBorder: 'rgba(0,0,0,0.08)',
  field: '#e1ddd4',
};

// RN and Skia cannot parse oklch or color-mix; use the mode default for those tokens.
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

  useEffect(() => {
    AsyncStorage.getItem(OVERRIDE_KEY).then((v) => setOverrideState(v || null));
  }, []);

  // Foreground only. The Live Activity bakes the accent in and restarts on a
  // change, and iOS cannot start one from the background, so a flip while the
  // phone is locked would end the card. A change made meanwhile lands on return.
  const appActive = useAppActive();
  // An unchanged registry keeps its identity, or every poll would re-render the
  // whole themed tree through new colour objects.
  const themesSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!api || !appActive) return;
    return pollAsync(async (signal) => {
      const payload = await api.themes(signal);
      if (signal.aborted) return;
      const list = payload.themes || [];
      const sig = JSON.stringify(list);
      if (sig !== themesSigRef.current) {
        themesSigRef.current = sig;
        setThemes(list);
      }
      setActiveId(payload.active || null);
    }, THEME_POLL_MS);
  }, [api, appActive]);

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

  // NativeWind vars must use RN-parseable colors, not the raw registry tokens.
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
