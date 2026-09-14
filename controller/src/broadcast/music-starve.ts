// Reads radio.liq's music-starved.json (#1300 bug 7). The IO shell around
// music-starve-pure.ts, which owns every decision and is separately pinned.

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { starveState, type StarveState } from './music-starve-pure.js';

export type { StarveState };

// A 2s memo rather than util/ttl-cache.ts, which wraps an ASYNC producer; this
// is a sync readFileSync behind a sync /state handler.
const MEMO_MS = 2_000;
let memo: { at: number; value: StarveState } | null = null;

/** The mixer's current starve verdict. Absent/unreadable/malformed → not
 *  starved; see starveState for why every failure resolves that way. */
export function currentStarve(now: number = Date.now()): StarveState {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.musicStarvedFile, 'utf8'));
  } catch {
    parsed = null; // absent is the normal case on a station that never starved
  }
  const value = starveState(parsed, now);
  memo = { at: now, value };
  return value;
}
