'use client';

import { useEffect, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';

// Seconds since `startedAt`, ticking once per second; 0 when startedAt is
// null. The interval pauses while the tab is hidden and recomputes the moment
// it returns, so the readout never drifts but background tabs stay quiet.
// Call this in the leaf component that displays the time — keeping the 1s
// tick out of useStationFeed is what stops it re-rendering the whole player.
export function useElapsed(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt == null) {
      setElapsed(0);
      return;
    }
    return pollWhileVisible(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
      1000,
    );
  }, [startedAt]);
  return elapsed;
}
