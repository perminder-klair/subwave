// Asking again about a saved Station login while the player is stuck
// connecting (#1873). The stream cannot say why it will not start, so
// useLoginCheck asks /api/health with the saved login, which only a proxy in
// front of the station can refuse (loginRefused).
//
// One answer does not settle it. A check that lands while the phone is still
// offline or on a weak link (a timeout, a network error), or while something
// in front of the proxy fails (a tunnel's 502 as the origin restarts), says
// nothing about the login; and one that passes says only that the login was
// good when asked, while the stall it was asked in can outlast a password
// change. So every answer but a refusal asks again, as long as the player
// stays stuck, spaced by RECHECK_MIN_GAP_MS.

import type { HealthResult } from './api';
import { loginRefused } from './station-login';

// Sooner than useStationGate's 15 s stuck recheck: a proxy that refuses the
// login refuses /station-auth too (stationAuthResult reads its challenge as
// 'unavailable', not a wrong password), so stopping first clears the gate's
// timer and saves it a rate-limited attempt that cannot get through. A health
// check costs no rate limit; the gap keeps a long stall to one check per 30 s,
// a fraction of what the feed polls cost.
export const STUCK_RECHECK_MS = 8_000;
export const RECHECK_MIN_GAP_MS = 30_000;

/** Check while stuck until the station refuses the login, then call
 *  `onRefused` once and stop. The first check waits STUCK_RECHECK_MS, and no
 *  check starts sooner than RECHECK_MIN_GAP_MS after the last one of any kind
 *  (`lastCheckAt`). One runs at a time: the next is armed only once an answer
 *  is in. Returns the cancel, for when the player comes unstuck or the station
 *  changes; an answer that lands after it, or one for a client that is no
 *  longer `current`, is dropped and asks nothing more. */
export function watchStuckLogin(deps: {
  /** GET /api/health with the saved login. Never throws. Stamps the time
   *  `lastCheckAt` reads. */
  probe: () => Promise<HealthResult>;
  /** When the last check began, here or elsewhere (the visit check, Try again). */
  lastCheckAt: () => number;
  /** Whether the client this was armed with is still the station's. */
  current: () => boolean;
  onRefused: () => void;
}): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const wait = Math.max(STUCK_RECHECK_MS, deps.lastCheckAt() + RECHECK_MIN_GAP_MS - Date.now());
    timer = setTimeout(() => {
      void deps.probe().then((result) => {
        if (!alive || !deps.current()) return;
        if (loginRefused(result)) deps.onRefused();
        else arm();
      });
    }, wait);
  };
  arm();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}
