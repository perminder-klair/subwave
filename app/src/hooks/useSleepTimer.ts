// Sleep timer: tune out after a listener-chosen interval — the classic
// bedside-radio feature (the native analog of the web's abandoned-tab idle
// cutoff, but listener-armed and minutes-scale).
//
// The countdown is a wall-clock deadline, deliberately NOT gated on the app
// being foregrounded: falling asleep with the phone locked is the whole point.
// While audio is playing the JS thread stays alive (iOS background-audio mode /
// Android foreground service), so the 1s interval keeps ticking; because the
// check compares Date.now() against the deadline, a suspended stretch can only
// delay the stop, never stretch the timer.

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
