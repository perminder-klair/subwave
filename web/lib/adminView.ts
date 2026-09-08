'use client';

// Browser-local admin view preferences (roster view, roster sort, Rundown board
// density), stored per surface in localStorage rather than as station state.

import { useCallback, useEffect, useState } from 'react';

export type RosterSurface = 'skills' | 'shows' | 'personas';
export type RosterView = 'cards' | 'list';

const KEY_PREFIX = 'subwave-admin-view:';

function isView(v: string | null): v is RosterView {
  return v === 'cards' || v === 'list';
}

export function readRosterView(surface: RosterSurface): RosterView {
  if (typeof window === 'undefined') return 'cards';
  try {
    const raw = window.localStorage.getItem(`${KEY_PREFIX}${surface}`);
    return isView(raw) ? raw : 'cards';
  } catch {
    return 'cards';
  }
}

function writeRosterView(surface: RosterSurface, view: RosterView): void {
  try {
    window.localStorage.setItem(`${KEY_PREFIX}${surface}`, view);
  } catch { /* private-mode browsers throw on setItem */ }
}

/* `[view, setView]` for one roster surface. The stored preference is read in a
   mount effect, not in the initial state, so server and first client render
   agree. */
export function useRosterView(surface: RosterSurface): [RosterView, (v: RosterView) => void] {
  const [view, setViewState] = useState<RosterView>('cards');

  useEffect(() => { setViewState(readRosterView(surface)); }, [surface]);

  const setView = useCallback((v: RosterView) => {
    setViewState(v);
    writeRosterView(surface, v);
  }, [surface]);

  return [view, setView];
}

export type BoardDensity = 'compact' | 'comfortable';

/** Compact is the tallest unit that still holds one line of card text. */
export const BOARD_HOUR_PX: Record<BoardDensity, number> = { compact: 26, comfortable: 34 };

const DENSITY_KEY = 'subwave-admin-board-density';

function isDensity(v: string | null): v is BoardDensity {
  return v === 'compact' || v === 'comfortable';
}

export function useBoardDensity(): [BoardDensity, (d: BoardDensity) => void] {
  const [density, setDensityState] = useState<BoardDensity>('comfortable');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DENSITY_KEY);
      if (isDensity(raw)) setDensityState(raw);
    } catch { /* private-mode browsers throw on getItem */ }
  }, []);

  const setDensity = useCallback((d: BoardDensity) => {
    setDensityState(d);
    try {
      window.localStorage.setItem(DENSITY_KEY, d);
    } catch { /* as above */ }
  }, []);

  return [density, setDensity];
}

/* Roster SORT, stored per surface beside the cards/list view. The vocabulary is
 * per-surface, so this stores an opaque string and each panel owns its union and
 * fallback; an unrecognised stored value reads as absent. Filters are
 * deliberately not stored. */

const SORT_KEY_PREFIX = 'subwave-admin-sort:';

export function useRosterSort<T extends string>(
  surface: RosterSurface,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [sort, setSortState] = useState<T>(fallback);

  // Read in a mount effect, not initial state, so server and first client render agree.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`${SORT_KEY_PREFIX}${surface}`);
      if (raw && (allowed as readonly string[]).includes(raw)) setSortState(raw as T);
    } catch { /* private-mode browsers throw on getItem */ }
    // `allowed` is a module-level literal at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface]);

  const setSort = useCallback((v: T) => {
    setSortState(v);
    try {
      window.localStorage.setItem(`${SORT_KEY_PREFIX}${surface}`, v);
    } catch { /* as above */ }
  }, [surface]);

  return [sort, setSort];
}
