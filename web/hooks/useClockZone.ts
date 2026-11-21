'use client';

import { useSyncExternalStore } from 'react';
import { getClockZone, setClockZone, subscribeClockZone, type ClockZone } from '@/lib/clockZone';

export interface ClockZoneState {
  /** Which clock the player's times read in (lib/clockZone.ts). */
  zone: ClockZone;
  /** Saves it for this browser and re-renders every reader. */
  setZone: (zone: ClockZone) => void;
}

/** The listener's station/local clock choice. The server snapshot is station
 *  time, so the first paint matches the server render and a local-time
 *  listener's stamps flip once on hydration. */
export function useClockZone(): ClockZoneState {
  const zone = useSyncExternalStore(subscribeClockZone, getClockZone, () => 'station' as const);
  return { zone, setZone: setClockZone };
}
