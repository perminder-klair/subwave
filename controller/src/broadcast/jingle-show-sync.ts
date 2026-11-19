// Which show's jingle list the mixer's own rotate draws from (#2367).
//
// jingles.m3u is the mixer-counted rotate's draw list (jingles.ts writes it,
// jingle-playlist-policy.ts decides its lines). This module decides WHICH show:
//
//   - the on-air show (session.onAirShow), re-applied after every roll
//     (session.onRoll: the talk tick, the pick cycle, a request, a takeover)
//     and every settings change (an edit to the on-air show's own list rolls
//     nothing);
//   - EARLY, the incoming show, once the outgoing show's confirmed final track
//     is on air (a boundary record armed for it, with the incoming show's id).
//     The jingle at the seam that ends that track belongs to the incoming show,
//     and the mixer draws it before the roll can happen: the swap must land
//     while the final track plays. The seam BEFORE that track has already
//     drawn by then (its stinger airs as the track's now-playing is written,
//     and a reload while a stinger is on air plays it out), so it stays the
//     outgoing show's. Until the session rolls, that incoming show is what
//     every re-apply resolves to, so a settings save during the final track
//     cannot put the outgoing list back; the roll then lands on the same list
//     and writes nothing.
//
// See docs/internals/show-boundary-handoffs.md. jingles.applyShowList is
// idempotent on the written bytes, so every trigger may fire freely. A
// controller restart during the final track forgets the early swap: boot
// applies the outgoing show, and the roll applies the incoming one.

import * as session from './session.js';
import * as settings from '../settings.js';
import * as jingles from './jingles.js';
import { onCacheChange } from '../settings/store.js';

type Track = { id?: string | null; title?: string | null; artist?: string | null } | null | undefined;

// The incoming show applied ahead of the roll, valid while the session that
// armed it is still live. showId null: the boundary goes autonomous.
let ahead: { sessionId: string; showId: string | null } | null = null;
let log: (line: string) => void = () => {};

// The list the rotate should hold now; undefined is every jingle.
export function rotateShowList(): readonly string[] | undefined {
  const live = session.getSession();
  // The record that armed it must still name that show: a boundary the
  // schedule called off without a roll falls back to the on-air show.
  if (ahead && live?.id === ahead.sessionId && live.boundaryHandoff?.incomingShowId === ahead.showId) {
    if (ahead.showId === null) return undefined;
    const show = settings.resolveShowById(ahead.showId);
    if (show) return show.allowedJingles;
  }
  ahead = null;
  return session.onAirShow()?.allowedJingles;
}

async function apply(reason: string): Promise<boolean> {
  try {
    const list = rotateShowList();
    const wrote = await jingles.applyShowList(list);
    if (wrote) log(`[jingle] mixer rotate list → ${list?.length ? `the show's list (${list.length} listed)` : 'every jingle'} (${reason})`);
    return wrote;
  } catch (err) {
    log(`[jingle] rotate list update failed (${reason}): ${(err as Error).message}`);
    return false;
  }
}

// Every music start (queue.onTrackStarted), and a pick cycle that arms on the
// track already on air (queue.confirmOnAirJingleList), whose start came before
// the record. Acts only on the confirmed final outgoing track of a boundary
// record that names its incoming show.
export function onMusicStarted(track: Track): Promise<boolean> {
  const live = session.getSession();
  const handoff = live?.boundaryHandoff;
  // Absent on a record armed before #2367: wait for the roll.
  if (!live || !handoff || handoff.incomingShowId === undefined) return Promise.resolve(false);
  if (!session.boundaryHandoffReadyForTrack(track ?? null)) return Promise.resolve(false);
  ahead = { sessionId: live.id, showId: handoff.incomingShowId };
  return apply('final outgoing track on air');
}

// Boot, after session.recover and before the first jingles.m3u write.
export function initJingleShowList() {
  jingles.setShowList(rotateShowList());
}

export function syncJingleShowList(reason: string): Promise<boolean> {
  return apply(reason);
}

let started = false;
export function startJingleShowSync(opts: { log?: (line: string) => void } = {}) {
  if (opts.log) log = opts.log;
  if (started) return;
  started = true;
  session.onRoll(() => { void apply('show roll'); });
  onCacheChange(() => { void apply('settings'); });
}

// Tests only.
export function _resetForTests() {
  ahead = null;
}
