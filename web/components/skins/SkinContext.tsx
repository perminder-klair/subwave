'use client';

// Read/write access to the shell's skin selection, for switcher UI living
// inside a skin (ThemeSwitcher's "Player skin" section). Kept separate from
// PlayerShell so consumers don't import the shell (which imports skins).

import { createContext, useContext } from 'react';
import type { SkinManifest } from './types';

export interface SkinSelection {
  /** Every skin this build ships. */
  skins: SkinManifest[];
  /** The operator's station-wide pick (resolved to a known id). */
  stationSkinId: string;
  /** Per-browser override id, or null when following the station. */
  overrideId: string | null;
  /** What's actually rendering right now. */
  effectiveId: string;
  /** Save or clear the override and re-render immediately. null clears. */
  setOverride: (id: string | null) => void;
}

const SkinSelectionContext = createContext<SkinSelection | null>(null);

export const SkinSelectionProvider = SkinSelectionContext.Provider;

/** null outside a PlayerShell (e.g. the admin header's ThemeSwitcher) —
 *  consumers hide their skin UI in that case. */
export function useSkinSelection(): SkinSelection | null {
  return useContext(SkinSelectionContext);
}
