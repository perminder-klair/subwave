// Whether an untracked play came from the fallback the controller wrote (#2213).
//
// A play the queue cannot match to an item is recorded as `source: 'auto'`, the
// auto.m3u coast, and nothing checked that the coast held it. A strict-playlist
// show then aired a track from a file the controller had already replaced (a
// request the mixer was still resolving when `auto.reload` landed), and the
// booth log showed only a bare `[playing]`. This module answers one question,
// warn or stay quiet, and never acts: the station keeps playing whatever the
// mixer chose, and the warning is for the operator.
//
// Quiet, by design, whenever the controller cannot vouch for what the mixer was
// meant to be playing:
//   - nothing to compare: no coast written by this process yet (a boot, or a
//     controller restart over a mixer that kept running), and through the
//     first write's grace, since the file it replaced is a previous process's;
//   - an unidentified play (no id, no title), which no rule can place;
//   - a DJ pick or request handed to the mixer and not yet matched: its id or
//     title may differ from what the mixer reports, and then it reaches this
//     branch as untracked although the queue sent it;
//   - a track from the file the last write replaced, inside the moment the
//     reload takes to land, or for as long as the mixer has not confirmed the
//     reload of the newer file (an unconfirmed reload leaves an off-air
//     playlist on the older file until the next one);
//   - a match by `title|artist` as well as by id, so a duplicate rip of a
//     coasted song is the coast's.
// Jingles, beds and pause-talk never reach the untracked branch: radio.liq
// writes now-playing.json only for music on `music_meta`, above the jingle
// switch, and beds and pause-talk branch before its title gate.
//
// See docs/internals/broadcast.md, "An untracked play is checked against the coast".

import { trackKey, type CandidateLike } from '../music/recency.js';
import type { CoastContents } from './coast-handover.js';

// How long after a write a track from the replaced file still counts as the
// coast's: the mixer took it before the reload, and the controller sees its
// start a now-playing poll later.
export const REPLACED_COAST_GRACE_MS = 15_000;

export interface CoastWrite {
  contents: CoastContents;
  writtenAt: number;
  /** Whether the mixer confirmed the reload of this write; null while it is in flight. */
  reloaded: boolean | null;
}

export interface CoastLedger {
  current: CoastWrite | null;
  /**
   * What the mixer may still hold from earlier writes, until `replacedUntil`.
   * 'unknown' after this process's first write: the file it replaced was
   * another process's, so any play counts as the coast's until then.
   */
  replaced: CoastContents | 'unknown' | null;
  replacedUntil: number;
}

export interface OffCoastInput {
  play: CandidateLike | null | undefined;
  ledger: CoastLedger;
  /** A queue item has been handed to the mixer and has not been matched yet. */
  handedOverPending: boolean;
  now: number;
}

export type OffCoastVerdict =
  | { warn: false; why: 'no-coast' | 'unidentified' | 'handed-over' | 'in-coast' | 'replaced-coast' }
  | { warn: true };

function holds(coast: CoastContents | 'unknown' | null, t: CandidateLike): boolean {
  if (coast === 'unknown') return true;
  if (!coast) return false;
  return !!((t.id && coast.ids.has(t.id)) || (t.title && coast.keys.has(trackKey(t))));
}

export function offCoastVerdict({ play, ledger, handedOverPending, now }: OffCoastInput): OffCoastVerdict {
  if (!ledger.current) return { warn: false, why: 'no-coast' };
  if (!play || (!play.id && !play.title)) return { warn: false, why: 'unidentified' };
  if (handedOverPending) return { warn: false, why: 'handed-over' };
  if (holds(ledger.current.contents, play)) return { warn: false, why: 'in-coast' };
  if (now < replacedUntil(ledger) && holds(ledger.replaced, play)) return { warn: false, why: 'replaced-coast' };
  return { warn: true };
}

// An unconfirmed (or still pending) reload keeps the replaced file airable for
// as long as it stays unconfirmed.
function replacedUntil(ledger: CoastLedger): number {
  return ledger.current?.reloaded === true ? ledger.replacedUntil : Infinity;
}

function mergeContents(a: CoastContents | 'unknown' | null, b: CoastContents): CoastContents | 'unknown' {
  if (a === 'unknown') return a;
  if (!a) return b;
  return { ids: new Set([...a.ids, ...b.ids]), keys: new Set([...a.keys, ...b.keys]), builtAt: b.builtAt };
}

// A new write. The file it replaces joins what the mixer may still hold; files
// older than that stay in it only while the write they were replaced by was
// never confirmed, since a confirmed reload dropped them.
export function ledgerAfterWrite(ledger: CoastLedger, contents: CoastContents, now: number): CoastLedger {
  const prev = ledger.current;
  if (!prev) return { current: { contents, writtenAt: now, reloaded: null }, replaced: 'unknown', replacedUntil: now + REPLACED_COAST_GRACE_MS };
  const keepOlder = prev.reloaded !== true && ledger.replaced;
  return {
    current: { contents, writtenAt: now, reloaded: null },
    replaced: keepOlder ? mergeContents(ledger.replaced, prev.contents) : prev.contents,
    replacedUntil: now + REPLACED_COAST_GRACE_MS,
  };
}

export function ledgerAfterReload(ledger: CoastLedger, contents: CoastContents, reloaded: boolean): CoastLedger {
  // A newer write has landed since: its own reload answers for it.
  if (ledger.current?.contents !== contents) return ledger;
  return { ...ledger, current: { ...ledger.current, reloaded } };
}

export function offCoastWarning(play: CandidateLike, showName: string | null, strictPlaylist: boolean): string {
  const what = `"${play.title ?? play.id}"${play.artist ? ` — ${play.artist}` : ''}`;
  const where = showName ? ` during show "${showName}"${strictPlaylist ? ' (strict playlist)' : ''}` : '';
  return `Off-coast play: ${what} aired from the fallback${where} but is not in the auto.m3u the controller last wrote — the mixer played a track from a replaced file (#2213)`;
}

// Everything above this line stays pure; this is the module's only state. The
// scheduler writes it beside auto.m3u and the queue reads it, which keeps the
// queue from importing the scheduler that already imports it.
let ledger: CoastLedger = { current: null, replaced: null, replacedUntil: 0 };

export function noteCoastWritten(contents: CoastContents, now = Date.now()): void {
  ledger = ledgerAfterWrite(ledger, contents, now);
}

export function noteCoastReloaded(contents: CoastContents, reloaded: boolean): void {
  ledger = ledgerAfterReload(ledger, contents, reloaded);
}

export function coastLedger(): CoastLedger {
  return ledger;
}

/** Tests only. */
export function resetCoastLedger(): void {
  ledger = { current: null, replaced: null, replacedUntil: 0 };
}
