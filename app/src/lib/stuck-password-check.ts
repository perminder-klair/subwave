// Asking again about the saved station password while the player is stuck
// connecting (#478, #2141). Icecast refuses a stale password without saying
// so, as far as the player can tell: it just keeps reconnecting. So
// useStationGate asks the controller's fail-closed POST /station-auth.
//
// watchStuckLogin's shape (stuck-login-check.ts), for its reasons: one answer
// does not settle it. A check that lands while the phone is offline, one the
// rate limit turns away, or one a proxy answers before the controller sees it
// says nothing about the password; one that passes goes stale if the operator
// rotates it mid-stall. So every answer but 'denied' asks again, as long as
// the player stays stuck. Two differences:
//
// - The gap is 120 s, not 30 s. /station-auth allows 20 attempts per 15
//   minutes per IP, a pass spends one too, and a household shares an address:
//   at this gap one stuck player spends at most 8 in a window. Once that
//   address is over the limit, a 429's Retry-After holds the next check
//   longer: a refused attempt costs the limit nothing, but it tells nothing
//   either, until the window has room again (#2164).
// - A denial that lands after the stall ended is still reported. It is the
//   controller's answer about the stored password, not about the stall, and a
//   stop while the check was out must still lead to the prompt that says why.

import type { StationAuthResult } from './station-password';

export const STUCK_RECHECK_MS = 15_000;
export const RECHECK_MIN_GAP_MS = 120_000;

/** Check while stuck until the controller denies the password, then call
 *  `onDenied` once and stop. The first check waits STUCK_RECHECK_MS, and no
 *  check starts sooner than RECHECK_MIN_GAP_MS after the last one of any kind
 *  (`lastCheckAt`), or before a 429 said to ask again (`heldUntil`): a stall
 *  that starts just after one waits out the gap, and is never skipped. One
 *  runs at a time: the next is armed only once an answer is in. Returns the
 *  cancel, for when the player comes unstuck: nothing more is asked, though a
 *  denial already in flight is still reported. An answer for a client that is
 *  no longer `current` is dropped. */
export function watchStuckPassword(deps: {
  /** POST /station-auth with the saved password. Never throws. Stamps the
   *  time `lastCheckAt` reads. */
  check: () => Promise<StationAuthResult>;
  /** When the last check began, here or elsewhere (the visit check, an unlock). */
  lastCheckAt: () => number;
  /** When a 429 said to ask again, here or elsewhere; 0 for none. Read at every
   *  arming, so it outlives this watcher when a status change replaces it. */
  heldUntil: () => number;
  /** Whether the client this was armed with is still the station's. */
  current: () => boolean;
  onDenied: () => void;
}): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    const now = Date.now();
    const wait = Math.max(STUCK_RECHECK_MS, deps.lastCheckAt() + RECHECK_MIN_GAP_MS - now, deps.heldUntil() - now);
    timer = setTimeout(() => {
      void deps.check().then((result) => {
        if (!deps.current()) return;
        if (result === 'denied') deps.onDenied();
        else if (alive) arm();
      });
    }, wait);
  };
  arm();
  return () => {
    alive = false;
    clearTimeout(timer);
  };
}
