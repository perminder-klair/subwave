'use client';

import { useSyncExternalStore } from 'react';
import { isLite, setLite, subscribeLite } from '@/lib/lite';

export interface LiteModeState {
  /** Whether low-power mode is active (blur + animations dropped). */
  lite: boolean;
  /** Set the mode for this browser: saves it, flips the <html> class and
   *  re-renders every reader, so skins still their JS motion at once. */
  setLite: (on: boolean) => void;
}

/** Low-power mode, for the Appearance menu's toggle and for skins that must
 *  still their own motion. LITE_INIT_SCRIPT already applies the `lite` class
 *  pre-paint, so this reads that class. The server snapshot is off; hydration
 *  then picks up the class, so the one-render lag only touches JS-driven motion. */
export function useLiteMode(): LiteModeState {
  const lite = useSyncExternalStore(subscribeLite, isLite, () => false);
  return { lite, setLite };
}
