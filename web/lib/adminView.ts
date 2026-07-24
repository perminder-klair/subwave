'use client';

// Roster view preference — cards or list — for the three admin rosters that
// share the "broadcast slate" card recipe (/admin/skills, /admin/shows,
// /admin/personas). Cards stay the default; the list view is the second gear
// for a roster that has outgrown a card stack.
//
// Stored per surface, not globally: an operator may well want Skills as a
// dense list while Shows stays on cards (that page already has the weekly grid
// above it doing the scanning job). Browser-local like the skin/theme
// overrides — this is a cheap preference, not station state.

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
  } catch { /* private-mode browsers throw on setItem — the view still works */ }
}

/* `[view, setView]` for one roster surface. Starts on 'cards' and reads the
   stored preference in a mount effect rather than in the initial state, so
   server and first client render agree. A list-view operator sees one frame of
   cards on a cold load; the panels render a skeleton while the roster fetch is
   in flight, so in practice the view resolves before there is a roster to
   draw. */
export function useRosterView(surface: RosterSurface): [RosterView, (v: RosterView) => void] {
  const [view, setViewState] = useState<RosterView>('cards');

  useEffect(() => { setViewState(readRosterView(surface)); }, [surface]);

  const setView = useCallback((v: RosterView) => {
    setViewState(v);
    writeRosterView(surface, v);
  }, [surface]);

  return [view, setView];
}
