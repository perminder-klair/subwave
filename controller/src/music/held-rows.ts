// Library rows a walk could not see but was not allowed to delete.
//
// A complete walk that misses more tracks than the mass-prune guard allows
// keeps them (music/prune-policy.ts): an unmounted share must not wipe tags
// and analysis that took hours to make. Those rows still name ids the music
// source does not serve, though, and after a music-source switch to a
// different library that is the whole old library. Left in the pick paths
// they kept airing as dropped picks, filled the coast with ids Liquidsoap
// cannot resolve, and led the analysis pass into a run of 404s.
//
// So the walk that decides the hold records which rows it held, and the pick
// and analysis paths leave them out until a later walk sees them again (a
// share remounted, a switch back) or the operator confirms the removal.
// The rows themselves are untouched: this file only says "not served now".
//
// One writer: id-rotation.ts adoptAndPrune, after every complete walk.
//
// A music-source switch adds a second, shorter-lived reason (#2423). The
// station streams from the new source the moment the save lands, but the rows
// only follow it once a walk carries them across, and until then they name
// the OLD source's ids: a pick of one is pushed with the new connection and
// dropped unplayed. So while a switch is pending, the only rows served are
// the ones a walk made after the switch saw on the new source
// (switch-vouched.json, stamped with the switch it belongs to). Right after a
// save nothing is vouched for, and picks come from the source's own live
// answers, as on a fresh station. A walk that keeps the switch open while the
// source scans vouches for what it saw; the walk that spends the switch ends
// the restriction. This record is never shown as "kept out of picks": the
// operator has nothing to confirm, and those rows are not missing.

import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { SOURCE_SWITCH_PATH } from '../setup/music-source.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';

export const HELD_ROWS_FILE = 'held-rows.json';

interface HeldRowsDoc {
  at: string;
  ids: string[];
}

function filePath(): string {
  return path.join(config.stateDir, HELD_ROWS_FILE);
}

/** Record the rows a walk held, or clear the record when it held none. */
export function recordHeldRows(ids: readonly string[]): void {
  if (!ids.length) {
    rmSync(filePath(), { force: true });
  } else {
    const doc: HeldRowsDoc = { at: new Date().toISOString(), ids: [...ids] };
    writeFileAtomicSync(filePath(), JSON.stringify(doc));
  }
  cache = null;
}

let cache: { mtimeMs: number; ids: ReadonlySet<string> } | null = null;
const NONE: ReadonlySet<string> = new Set();

/**
 * The held ids, re-read only when the file changes: the walk runs in a child
 * process, so the controller learns of a new record through the file alone.
 * Missing or unreadable reads as none held (the pick paths fail open).
 */
export function heldIds(): ReadonlySet<string> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(filePath()).mtimeMs;
  } catch {
    cache = null;
    return NONE;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.ids;
  try {
    const doc = JSON.parse(readFileSync(filePath(), 'utf8')) as Partial<HeldRowsDoc>;
    const ids = new Set(Array.isArray(doc.ids) ? doc.ids.filter((x): x is string => typeof x === 'string') : []);
    cache = { mtimeMs, ids };
    return ids;
  } catch {
    return NONE;
  }
}

export const SWITCH_VOUCHED_FILE = 'switch-vouched.json';

interface SwitchVouchedDoc {
  /** The `at` of the switch marker this walk answered. */
  switchAt: string;
  ids: string[];
}

function vouchedPath(): string {
  return path.join(config.stateDir, SWITCH_VOUCHED_FILE);
}

/** Record the rows a walk after the switch `switchAt` saw on the new source. */
export function recordSwitchVouched(switchAt: string, ids: Iterable<string>): void {
  const doc: SwitchVouchedDoc = { switchAt, ids: [...ids] };
  writeFileAtomicSync(vouchedPath(), JSON.stringify(doc));
  vouchedCache = null;
}

/** The switch is spent: every row is judged by the walk's own hold again. */
export function clearSwitchVouched(): void {
  rmSync(vouchedPath(), { force: true });
  vouchedCache = null;
}

// Re-read only when a file changes, like heldIds(): the walk runs in a child.
let markerCache: { mtimeMs: number; at: string | null } | null = null;
let vouchedCache: { mtimeMs: number; doc: SwitchVouchedDoc | null } | null = null;

function pendingSwitchAt(): string | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(SOURCE_SWITCH_PATH).mtimeMs;
  } catch {
    markerCache = null;
    return null;
  }
  if (markerCache && markerCache.mtimeMs === mtimeMs) return markerCache.at;
  let at: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(SOURCE_SWITCH_PATH, 'utf8'));
    if (typeof raw?.at === 'string') at = raw.at;
  } catch { /* an unreadable marker restricts nothing, as pendingSourceSwitch() reads it */ }
  markerCache = { mtimeMs, at };
  return at;
}

function vouchedDoc(): SwitchVouchedDoc | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(vouchedPath()).mtimeMs;
  } catch {
    vouchedCache = null;
    return null;
  }
  if (vouchedCache && vouchedCache.mtimeMs === mtimeMs) return vouchedCache.doc;
  let doc: SwitchVouchedDoc | null = null;
  try {
    const raw = JSON.parse(readFileSync(vouchedPath(), 'utf8')) as Partial<SwitchVouchedDoc>;
    if (typeof raw.switchAt === 'string' && Array.isArray(raw.ids)) {
      doc = { switchAt: raw.switchAt, ids: raw.ids.filter((x): x is string => typeof x === 'string') };
    }
  } catch { /* unreadable: nothing vouched for */ }
  vouchedCache = { mtimeMs, doc };
  return doc;
}

let vouchedSet: { doc: SwitchVouchedDoc; ids: ReadonlySet<string> } | null = null;

/**
 * While a switch is pending, the ids a walk after it vouched for (empty right
 * after the save, or when the record belongs to an earlier switch); null when
 * no switch is pending, so nothing is restricted.
 */
export function switchVouchedIds(): ReadonlySet<string> | null {
  const at = pendingSwitchAt();
  if (at === null) return null;
  const doc = vouchedDoc();
  if (!doc || doc.switchAt !== at) return NONE;
  if (vouchedSet?.doc !== doc) vouchedSet = { doc, ids: new Set(doc.ids) };
  return vouchedSet.ids;
}

/**
 * Whether the music source serves `id` now, as far as the library knows: not
 * held by a walk, and, during a switch, vouched for by a walk after it. Null
 * when nothing restricts, so a caller can skip the filter.
 */
export function servedFilter(): ((id: string) => boolean) | null {
  const held = heldIds();
  const vouched = switchVouchedIds();
  if (!held.size && !vouched) return null;
  return (id) => !held.has(id) && (!vouched || vouched.has(id));
}

/** Drop rows the source does not serve now from a candidate list. Returns the input itself when nothing restricts. */
export function rejectHeld<T extends { id?: unknown }>(rows: T[]): T[] {
  const served = servedFilter();
  if (!served) return rows;
  return rows.filter((r) => !(typeof r?.id === 'string' && !served(r.id)));
}

export function isHeld(id: string): boolean {
  const served = servedFilter();
  return served !== null && !served(id);
}
