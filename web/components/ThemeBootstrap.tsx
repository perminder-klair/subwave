'use client';

import { useEffect } from 'react';
import { applyTheme, cacheTheme, type Theme } from '@/lib/theme';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api';

interface ThemesPayload {
  active: string;
  themes: Theme[];
}

// Single, app-wide theme syncer. Mounted from the root layout so every page
// (player, admin, landing, onboarding, setup-guide) gets the station-wide
// theme without each one having to wire up a fetcher.
//
// The pre-paint <script> in layout.tsx already applied the cached theme, so
// this only handles two cases:
//   1. First visit (no cache) — fetch + apply + populate cache.
//   2. Operator changed the theme in admin since the last visit — refresh.
//
// 30 s poll cadence is the upper bound on how long a listener sees the old
// theme after an operator switch. Cheap call (returns a tiny JSON blob);
// every-5s would be wasteful and every-N-minutes feels stale.
export default function ThemeBootstrap() {
  useEffect(() => {
    let cancelled = false;

    const apply = async () => {
      try {
        const r = await fetch(`${API_URL}/themes`);
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as ThemesPayload;
        const theme = j.themes.find(t => t.id === j.active) ?? j.themes[0];
        if (!theme || cancelled) return;
        applyTheme(theme);
        cacheTheme(theme);
      } catch {
        // Network blip — keep the existing CSS variables. The next poll will
        // sort it out, and the pre-paint cache covers the meantime.
      }
    };

    apply();
    const id = setInterval(apply, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
