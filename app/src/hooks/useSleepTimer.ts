// Keep the timer running during background audio. A wall-clock deadline
// lets a suspended JS thread catch up without extending the chosen duration.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SleepTimer {
  /** True while a timer is armed. */
  active: boolean;
  /** The duration the running timer was armed with, or null when not armed. */
  armedMinutes: number | null;
  /** Whole seconds until the timer fires, or null when not armed. */
  remainingSec: number | null;
  /** Arm (or re-arm) the timer. */
  start: (minutes: number) => void;
  cancel: () => void;
}

export function useSleepTimer(onExpire: () => void): SleepTimer {
  const [armed, setArmed] = useState<{ endsAt: number; minutes: number } | null>(null);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; }, [onExpire]);

  useEffect(() => {
    if (armed == null) {
      setRemainingSec(null);
      return;
    }
    const tick = () => {
      const left = Math.ceil((armed.endsAt - Date.now()) / 1000);
      if (left <= 0) {
        setArmed(null);
        setRemainingSec(null);
        onExpireRef.current();
        return;
      }
      setRemainingSec(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [armed]);

  const start = useCallback((minutes: number) => {
    setArmed({ endsAt: Date.now() + minutes * 60_000, minutes });
  }, []);
  const cancel = useCallback(() => setArmed(null), []);

  return {
    active: armed != null,
    armedMinutes: armed?.minutes ?? null,
    remainingSec,
    start,
    cancel,
  };
}
