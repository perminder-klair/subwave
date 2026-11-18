'use client';

import { useEffect, useState } from 'react';
import { talkingState } from '@/lib/sessionFeed';
import type { SessionTurn } from '@/lib/types';

/** True while one of the DJ's lines is on air (talkingState). Held in state and
 *  re-evaluated on its own timer, so the window opens and closes on time with
 *  no feed update. A listener surface passes its buffer as `leadMs` so the
 *  window opens when the line is HEARD; an operator surface passes 0. */
export function useTalking(feed: SessionTurn[] | null | undefined, leadMs = 0): boolean {
  const [talking, setTalking] = useState(false);
  useEffect(() => {
    let timer: number | null = null;
    const apply = () => {
      const now = Date.now();
      const { talking: next, nextChangeMs } = talkingState(feed, leadMs, now);
      setTalking(next);
      timer = nextChangeMs == null ? null : window.setTimeout(apply, Math.max(0, nextChangeMs - now));
    };
    apply();
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [feed, leadMs]);
  return talking;
}
