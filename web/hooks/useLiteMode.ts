'use client';

import { useEffect, useState } from 'react';
import { loadLitePref } from '@/lib/lite';

export interface LiteModeState {
  /** Whether low-power mode is active (blur + animations dropped). */
  lite: boolean;
}

/** Low-power mode, for skins that must still their own motion. LITE_INIT_SCRIPT
 *  already applies the `lite` class pre-paint (from `?lite=` or the stored
 *  preference), so this only surfaces the value to JS. */
export function useLiteMode(): LiteModeState {
  const [lite, setLite] = useState(false);

  // localStorage is only safe to read in an effect. The pre-paint script already
  // set the class, so the one-tick lag here only affects JS-driven motion.
  useEffect(() => {
    setLite(loadLitePref() === true);
  }, []);

  return { lite };
}
