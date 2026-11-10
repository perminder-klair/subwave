// The feed's copy of a GET /state payload (#2072), mirroring web's
// `feedState()` in web/hooks/useStationFeed.ts. `streamIdleWindow` is
// published as ages, so it differs on every poll once the controller has
// paused: kept, it would defeat useStationFeed's per-field signature and hand
// the memoized pages (PlayerScreen's Timeline) new `upcoming`/`history`
// identities every 5s. Nothing in the app reads it; the web player's idle skip
// reads /state fresh, and the app's port of that skip will too.

import type { StationState } from './types';

export function feedState(st: StationState): StationState {
  if (!st || typeof st !== 'object') return st;
  const { streamIdleWindow: _ages, ...rest } = st;
  return rest;
}
