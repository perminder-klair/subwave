'use client';

import { useCallback, useEffect, useState } from 'react';
import { applyLite, loadLitePref, saveLitePref } from '@/lib/lite';

export interface LiteModeState {
  /** Whether low-power mode is active (blur + animations dropped). */
  lite: boolean;
  /** Set the mode explicitly and sync the <html> class + localStorage. */
  setLite: (on: boolean) => void;
}

/** Listener-facing low-power toggle. The `lite` class is already applied
 *  pre-paint by LITE_INIT_SCRIPT, so this hook only surfaces the current value
 *  to the UI and keeps the class + localStorage in sync when the listener
 *  flips it. */
export function useLiteMode(): LiteModeState {
  const [lite, setLiteState] = useState(false);

  // localStorage is only safe to read in an effect. The pre-paint script
  // already set the class, so a one-tick lag before the toggle reflects the
  // stored value is invisible (the menu starts closed).
  useEffect(() => {
    setLiteState(loadLitePref() === true);
  }, []);

  const setLite = useCallback((on: boolean) => {
    saveLitePref(on);
    applyLite(on);
    setLiteState(on);
  }, []);

  return { lite, setLite };
}
