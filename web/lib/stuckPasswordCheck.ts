// Asking again about the stored station password while the player is stuck connecting (#2176), the
// web twin of app/src/lib/stuck-password-check.ts: no package here imports another, so the rules
// are mirrored, and a change to them goes in both. Icecast refuses a stale password without saying
// so, as far as the player can tell: it just keeps reconnecting. So useStationAuth asks the
// controller's fail-closed POST /station-auth.
//
// One answer does not settle it. A check that lands while the device is offline, one the rate limit
// turns away, or one a proxy answers before the controller sees it says nothing about the password;
// one that passes goes stale if the operator rotates it mid-stall. So every answer but 'denied'
// asks again, as long as the player stays stuck.
//
// - The gap is 120 s. /station-auth allows 20 attempts per 15 minutes per IP, a pass spends one too,
//   and a household shares an address: at this gap one stuck player spends at most 8 in a window.
//   Once that address is over the limit, a 429's Retry-After holds the next check longer: a refused
//   attempt costs the limit nothing, but it tells nothing either, until the window has room again.
// - A denial that lands after the stall ended is still reported. It is the controller's answer
//   about the stored password, not about the stall, and a stop while the check was out must still
//   lead to the prompt that says why.

import type { PlayerStatus } from '@/hooks/usePlayer';
import type { StationAuthResult } from './stationAuth';

export const STUCK_RECHECK_MS = 15_000;
export const RECHECK_MIN_GAP_MS = 120_000;

/** Tuned in and hearing nothing. Keyed on "not playing" rather than 'connecting', so the watcher
 *  doesn't depend on which status the player shows while it retries: `usePlayer` holds 'connecting'
 *  through the backoff now, but it used to drop to 'idle' on Firefox's refused connect (an element
 *  error), and a watcher keyed on 'connecting' was replaced before its first check came due.
 *  (Chromium parks a same-origin connect on the 401's Basic challenge, behind its own sign-in
 *  dialog, and stays on 'connecting'.) */
export function stuckConnecting(tunedIn: boolean, status: PlayerStatus): boolean {
  return tunedIn && status !== 'playing';
}

/** Check while stuck until the controller denies the password, then call `onDenied` once and stop.
 *  The first check waits STUCK_RECHECK_MS, and no check starts sooner than RECHECK_MIN_GAP_MS after
 *  the last one of any kind (`lastCheckAt`), or before a 429 said to ask again (`heldUntil`): a
 *  stall that starts just after one waits out the gap, and is never skipped. One runs at a time:
 *  the next is armed only once an answer is in. Returns the cancel, for when the player comes
 *  unstuck: nothing more is asked, though a denial already in flight is still reported. An answer
 *  for a client that is no longer `current` is dropped. */
export function watchStuckPassword(deps: {
  /** POST /station-auth with the stored password. Never throws. Stamps the time `lastCheckAt`
   *  reads. */
  check: () => Promise<StationAuthResult>;
  /** When the last check began, here or elsewhere (the visit check, an unlock). */
  lastCheckAt: () => number;
  /** When a 429 said to ask again, here or elsewhere; 0 for none. Read at every arming, so it
   *  outlives this watcher when a status change replaces it. */
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
      void deps.check().then(result => {
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
