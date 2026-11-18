// When the auto-DJ stops picking, the station coasts on auto.m3u from the end of the
// track on air. Three things stop it: nobody listening (llm.pauseWhenEmpty), the daily
// token cap's hard tier, and the operator switching auto-pick off. A file written before
// the queue's last plays can hold them, and a full rotation's coast always does: it is the
// rotation's longest-waiting half and both pickers take its most overdue track, so every
// pick after a rebuild is the head of that file. The queue reports the moment picking
// stopped; the scheduler rebuilds the file only when it holds something the queue aired
// since it was built. See docs/internals/broadcast.md. #1975, #1992, #1919.

import { trackKey, type CandidateLike } from '../music/recency.js';

/** What a coast build put in auto.m3u, and when it read the air history it filtered by. */
export interface CoastContents {
  ids: Set<string>;
  keys: Set<string>;
  builtAt: number;
}

export function coastContents(tracks: CandidateLike[], builtAt: number): CoastContents {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const t of tracks) {
    if (t?.id) ids.add(t.id);
    if (t?.title) keys.add(trackKey(t));
  }
  return { ids, keys, builtAt };
}

// How many of `aired` the coast still holds, by id or by title|artist so a
// duplicate rip of a just-aired song counts too.
export function coastRepeats(coast: CoastContents, aired: CandidateLike[]): number {
  let n = 0;
  for (const t of aired) {
    if ((t?.id && coast.ids.has(t.id)) || (t?.title && coast.keys.has(trackKey(t)))) n++;
  }
  return n;
}

// Why picking stopped, for the booth line the scheduler writes.
export type HandoverReason = 'listeners' | 'token-cap' | 'auto-pick-off';

export const HANDOVER_REASON_TEXT: Record<HandoverReason, string> = {
  listeners: 'nobody listening',
  'token-cap': 'daily token cap reached',
  'auto-pick-off': 'auto-pick off',
};

// The edge, not the level: true at the first moment picking stops after a track
// the queue put on air started, then false for every coast track after it until
// the next one starts. Armed by what LANDED, never by a pick cycle that ran: a
// capped cycle runs at every coast boundary and makes no pick, so arming there
// would fire at each one. A queued track starting also covers what no cycle
// picked: a request, a studio push, a pick recovered from queue.json. So a
// departure costs at most one check however long picking stays stopped, and a
// flapping listener at most one per track the queue airs. Starts unarmed: a
// boot into an empty room has nothing the file could be missing, since the boot
// build filters by the persisted history and the recovered on-air track.
export function createHandoverEdge() {
  let aired = false;
  return {
    aired(): void { aired = true; },
    held(): boolean {
      const edge = aired;
      aired = false;
      return edge;
    },
  };
}

// Everything above this line stays pure; this is the module's only state. The
// queue notifies and the scheduler subscribes, which keeps the queue from
// importing the scheduler that already imports it.
type HandoverListener = (reason: HandoverReason) => void;
const handoverListeners = new Set<HandoverListener>();

export function onCoastHandover(fn: HandoverListener): void {
  handoverListeners.add(fn);
}

export function notifyCoastHandover(reason: HandoverReason): void {
  for (const fn of handoverListeners) {
    // A subscriber's failure must not reach the track-start path that notifies.
    try { fn(reason); } catch { /* subscriber's problem */ }
  }
}
