'use client';

// The player feed's context, apart from PlayerCore so the Appearance menu can
// read it without pulling the audio core into the admin bundle.

import { createContext, useContext } from 'react';
import type { StationFeed } from '@/hooks/useStationFeed';
import type { ClockZone } from '@/lib/clockZone';

/** The feed as skins see it. `timezone` is the zone to render wall-clock times
 *  in: the station's by default, the listener's own when they chose local time in
 *  the Appearance menu (lib/clockZone.ts). A schedule grid keys its cells off
 *  station hours, so it reads `stationTimezone` (or the schedule's own zone). */
export interface PlayerFeed extends StationFeed {
  /** The station's IANA zone, whatever the listener chose; null before the first poll. */
  stationTimezone: string | null;
  /** Which clock `timezone` is. */
  clockZone: ClockZone;
}

export const FeedContext = createContext<PlayerFeed | null>(null);

/** The feed, or null outside a PlayerCoreProvider (the admin's Appearance menu). */
export function useOptionalPlayerFeed(): PlayerFeed | null {
  return useContext(FeedContext);
}
