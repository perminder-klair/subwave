import { useEffect, useState } from 'react';
import { talkingState } from '@/lib/voice-turn';
import type { SessionTurn } from '@/lib/types';

/** True while the DJ's latest line is being heard by THIS listener. `leadMs`
 *  is the listener's buffer behind the live edge (useStationFeed). */
export function useTalking(boothFeed: SessionTurn[] | undefined, leadMs: number): boolean {
  const [talking, setTalking] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Re-evaluated on its own timer, so the window opens and closes on time
    // rather than on the next poll.
    const apply = () => {
      const now = Date.now();
      const { talking: next, nextChangeMs } = talkingState(boothFeed, leadMs, now);
      setTalking(next);
      timer = nextChangeMs == null ? null : setTimeout(apply, Math.max(0, nextChangeMs - now));
    };
    apply();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [boothFeed, leadMs]);

  return talking;
}
