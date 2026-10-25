import { useEffect, useRef, useState } from 'react';

/** True while `shown`, and for `holdMs` after it stops; never before it has
 *  started. The Live page holds its lyrics layout this way (with
 *  LYRICS_LAYOUT_HOLD_MS) through the moment between two tracks that both
 *  have lyrics. */
export function useLingeringPresence(shown: boolean, holdMs: number): boolean {
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
