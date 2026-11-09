// Whether library.db holds a finished walk of the music server.
//
// A tag or reconcile run walks the whole catalogue, adds the rows it finds and
// prunes the ones the server no longer has. A run killed half-way (a Stop, a
// crash, a restart mid-run) leaves the table part-walked: some songs not yet
// re-read under their new ids, others already pruned. Anything that infers "this
// id left, and that row is the same song" from the table (music/heart-follow.ts)
// is only safe on a finished walk, so the tagger stamps each walking run here when
// it starts and when it ends, and the stamp outlives a controller restart (the
// boot pass reads it too).
//
// state/library-walk.json: { mode, state: 'running' | 'ok' | 'failed' | 'stopped', at }.
// No file (a station that has not walked since this landed) reads as unsettled.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { writeFileAtomicSync } from '../util/atomic-file.js';

export type WalkState = 'running' | 'ok' | 'failed' | 'stopped';

export interface WalkRecord {
  mode: string;
  state: WalkState;
  at: string;
}

const STATES = new Set<WalkState>(['running', 'ok', 'failed', 'stopped']);
const file = () => join(config.stateDir, 'library-walk.json');

/** Stamp a walking run's start or end. Never throws: a failed write leaves the last stamp, which only errs toward unsettled once a run starts. */
export function recordWalk(mode: string, state: WalkState, now: Date = new Date()): void {
  try {
    writeFileAtomicSync(file(), JSON.stringify({ mode, state, at: now.toISOString() }));
  } catch (err) {
    console.warn(`[library-walk] could not record the ${mode} run as ${state}: ${err instanceof Error ? err.message : err}`);
  }
}

export function lastWalk(): WalkRecord | null {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    if (raw && typeof raw.mode === 'string' && STATES.has(raw.state) && typeof raw.at === 'string') return raw;
  } catch { /* missing or unreadable: no record */ }
  return null;
}

/** The table is a finished walk only when the last walking run ended cleanly. */
export function walkSettled(rec: WalkRecord | null = lastWalk()): boolean {
  return rec?.state === 'ok';
}
