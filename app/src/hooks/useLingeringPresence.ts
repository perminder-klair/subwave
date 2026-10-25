import { useEffect, useRef, useState } from 'react';
import { LYRICS_LAYOUT_HOLD_MS } from '@/lib/lyrics';

/** True while `shown`, and for `holdMs` after it stops; never before it has
 *  started. Keeps the stage laid out for lyrics through the moment between two
 *  tracks that both have them. */
export function useLingeringPresence(shown: boolean, holdMs = LYRICS_LAYOUT_HOLD_MS): boolean {
  const [lingering, setLingering] = useState(false);
  const wasShown = useRef(shown);
  useEffect(() => {
    if (shown) {
      wasShown.current = true;
      return;
    }
    if (!wasShown.current) return;
    wasShown.current = false;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), holdMs);
    return () => clearTimeout(timer);
  }, [shown, holdMs]);
  return shown || lingering;
}
