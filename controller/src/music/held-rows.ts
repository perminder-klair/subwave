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

import { readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
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

/** Drop held rows from a candidate list. Returns the input itself when nothing is held. */
export function rejectHeld<T extends { id?: unknown }>(rows: T[]): T[] {
  const held = heldIds();
  if (!held.size) return rows;
  return rows.filter((r) => !(typeof r?.id === 'string' && held.has(r.id)));
}

export function isHeld(id: string): boolean {
  return heldIds().has(id);
}
