// IO shell around stream-mounts-pure.ts, which owns every decision (#2142).

import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import * as settings from '../settings.js';
import { listenerBufferSeconds, renderedBufferSeconds } from './stream-mounts-pure.js';

// A 2s memo, as in music-starve.ts: /now-playing is every listener's 5s poll,
// and the file changes only when the broadcast pair relaunches.
const MEMO_MS = 2_000;
let memo: { at: number; value: number | null } | null = null;

function rendered(now: number): number | null {
  if (memo && now - memo.at < MEMO_MS) return memo.value;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(config.liquidsoap.streamMountsFile, 'utf8'));
  } catch {
    // Absent is normal on a broadcast image that predates the marker.
    parsed = null;
  }
  const value = renderedBufferSeconds(parsed);
  memo = { at: now, value };
  return value;
}

/** Seconds every listener sits behind the live edge: the burst the running
 *  mounts were rendered with, else the saved stream.bufferSeconds. */
export function advertisedBufferSeconds(now: number = Date.now()): number {
  let setting: unknown;
  try {
    setting = (settings.get() as { stream?: { bufferSeconds?: unknown } } | null)?.stream?.bufferSeconds;
  } catch {
    setting = undefined;
  }
  return listenerBufferSeconds(rendered(now), setting);
}
