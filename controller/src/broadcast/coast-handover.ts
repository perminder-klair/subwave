// When the auto-DJ stops picking because nobody is listening (llm.pauseWhenEmpty), the
// station coasts on auto.m3u from the end of the track on air. A file written before the
// DJ's last picks can hold them, and a full rotation's coast always does: it is the
// rotation's longest-waiting half and both pickers take its most overdue track, so every
// pick after a rebuild is the head of that file. The queue reports the boundary where
// picking stopped; the scheduler rebuilds the file only when it holds something the queue
// aired since it was built. See docs/internals/broadcast.md. #1975, #1919.

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

// The edge, not the level: true at the first boundary the listener gate holds
// after the DJ picked, then false for every coast track after it until the DJ
// picks again. So a departure costs at most one check however long the room
// stays empty, and a flapping listener at most one per pick. Starts unarmed: a
// boot into an empty room has no picks the file could be missing, since the
// boot build read the persisted history.
export function createHandoverEdge() {
  let picked = false;
  return {
    picked(): void { picked = true; },
    held(): boolean {
      const edge = picked;
      picked = false;
      return edge;
    },
  };
}

// Everything above this line stays pure; this is the module's only state. The
// queue notifies and the scheduler subscribes, which keeps the queue from
// importing the scheduler that already imports it.
type HandoverListener = () => void;
const handoverListeners = new Set<HandoverListener>();

export function onCoastHandover(fn: HandoverListener): void {
  handoverListeners.add(fn);
}

export function notifyCoastHandover(): void {
  for (const fn of handoverListeners) {
    // A subscriber's failure must not reach the track-start path that notifies.
    try { fn(); } catch { /* subscriber's problem */ }
  }
}
