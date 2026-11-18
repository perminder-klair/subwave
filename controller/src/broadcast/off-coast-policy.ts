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
//     playlist on the older file until the next one), and a file replaced
//     inside that moment, since a show boundary writes twice in a second. Each
//     replaced file keeps its own grace, counted from its own replacement, so
//     refreshes a few seconds apart never stretch one into an endless window;
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
// How many replaced files the ledger keeps. Only a chain of unconfirmed reloads
// (a mixer that is not answering) keeps a file past its grace, and this bounds
// it, the first write's unknown predecessor included.
export const MAX_REPLACED_COASTS = 8;

export interface CoastWrite {
  contents: CoastContents;
  writtenAt: number;
  /** Whether the mixer confirmed the reload of this write; null while it is in flight. */
  reloaded: boolean | null;
}

export interface ReplacedCoast {
  /**
   * 'unknown' for the file this process's first write replaced: it was another
   * process's, so any play counts as the coast's until `until`.
   */
  contents: CoastContents | 'unknown';
  /** When a track from it stops counting as the coast's, once the newest reload is confirmed. */
  until: number;
}

export interface CoastLedger {
  current: CoastWrite | null;
  /** What the mixer may still hold from earlier writes, newest first, at most MAX_REPLACED_COASTS. */
  replaced: ReplacedCoast[];
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

function holds(coast: CoastContents | 'unknown', t: CandidateLike): boolean {
  if (coast === 'unknown') return true;
  return !!((t.id && coast.ids.has(t.id)) || (t.title && coast.keys.has(trackKey(t))));
}

export function offCoastVerdict({ play, ledger, handedOverPending, now }: OffCoastInput): OffCoastVerdict {
  if (!ledger.current) return { warn: false, why: 'no-coast' };
  if (!play || (!play.id && !play.title)) return { warn: false, why: 'unidentified' };
  if (handedOverPending) return { warn: false, why: 'handed-over' };
  if (holds(ledger.current.contents, play)) return { warn: false, why: 'in-coast' };
  // An unconfirmed (or still pending) reload keeps every replaced file airable
  // for as long as it stays unconfirmed.
  const confirmed = ledger.current.reloaded === true;
  if (ledger.replaced.some(r => (!confirmed || now < r.until) && holds(r.contents, play))) return { warn: false, why: 'replaced-coast' };
  return { warn: true };
}

// A new write. The file it replaces joins what the mixer may still hold, with a
// grace from now. Older files stay while their own grace still runs (two writes
// inside one now-playing poll, a show boundary's two refreshes, leave a track
// the mixer took before the first reload unseen until after the second), and,
// with a fresh grace, while the write they were replaced by was never confirmed,
// since only a confirmed reload dropped them. Never more than MAX_REPLACED_COASTS.
export function ledgerAfterWrite(ledger: CoastLedger, contents: CoastContents, now: number): CoastLedger {
  const prev = ledger.current;
  const until = now + REPLACED_COAST_GRACE_MS;
  const current: CoastWrite = { contents, writtenAt: now, reloaded: null };
  if (!prev) return { current, replaced: [{ contents: 'unknown', until }] };
  const older = prev.reloaded === true
    ? ledger.replaced.filter(r => now < r.until)
    : ledger.replaced.map(r => ({ ...r, until: Math.max(r.until, until) }));
  return { current, replaced: [{ contents: prev.contents, until }, ...older].slice(0, MAX_REPLACED_COASTS) };
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
let ledger: CoastLedger = { current: null, replaced: [] };

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
  ledger = { current: null, replaced: [] };
}
