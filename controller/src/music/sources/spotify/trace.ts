// The Spotify seam's verbose channel.
//
// WHY THIS IS NOT `queue.log`. The booth log is a 200-entry ring (queue.ts) that
// the admin UI and the DJ recap both read. The transport ticks at 2 Hz, so one
// trace line per tick would evict every operator-facing message in under two
// minutes — the log would be technically more detailed and practically useless.
// So verbose output goes to the container log and to the durable event stream
// (state/logs/events-*.jsonl, which the subwave-log-analysis skill reads), and
// the booth log keeps only the concise lines a human is meant to see.
//
// Off by default, and READ LIVE: settings.spotify.verboseLog is an admin toggle
// that takes effect on the next line, with no restart and no rebuild. The env
// var can only force it ON, never off — the same shape as LLM_DEBUG_RAW, so an
// operator debugging a boot problem can set it before the UI is reachable.

import * as settings from '../../../settings.js';
import { logEvent } from '../../../observability/events.js';

// Read once at startup, like rawDebugEnabledViaEnv(). An env flag exists to
// survive a controller that cannot serve its own admin UI yet.
const ENV_ENABLED = /^(1|true|yes|on)$/i.test(process.env.SPOTIFY_VERBOSE_LOG || '');

export function spotifyVerboseViaEnv(): boolean {
  return ENV_ENABLED;
}

/**
 * Is tracing on right now? Cheap — a cached boolean plus an in-memory settings
 * read — so call sites may use it to guard string building rather than paying
 * to format a line nobody will read.
 */
export function traceWanted(): boolean {
  if (ENV_ENABLED) return true;
  try {
    return (settings.get() as any)?.spotify?.verboseLog === true;
  } catch {
    return false;
  }
}

/**
 * One verbose line. `event` becomes the `spotify.<event>` type in the durable
 * event log, so keep it a stable dotted-free token (`seam`, `command`, `keep`).
 * Never throws: a tracing bug must not reach the transport's tick.
 */
export function strace(event: string, message: string, data: Record<string, unknown> = {}): void {
  if (!traceWanted()) return;
  try {
    console.log(`[spotify+] ${message}`);
    logEvent(`spotify.${event}`, { message, ...data });
  } catch { /* logging must never break a broadcast */ }
}

// The seam decision is evaluated twice a second. Printing it every tick is
// ~172,000 lines a day and buries everything else even in the container log, so
// it is emitted only when the decision CHANGES — plus a heartbeat, so a station
// parked on one decision still shows a sign of life.
const HEARTBEAT_MS = 10_000;
let lastKey = '';
let lastAt = 0;

export function straceThrottled(
  event: string,
  key: string,
  message: string,
  data: Record<string, unknown> = {},
  now: number = Date.now(),
): void {
  if (!traceWanted()) return;
  if (key === lastKey && now - lastAt < HEARTBEAT_MS) return;
  const repeat = key === lastKey;
  lastKey = key;
  lastAt = now;
  strace(event, message, { ...data, ...(repeat ? { repeat: true } : {}) });
}

/** Test seam — the throttle is module state. */
export function resetTraceThrottle(): void {
  lastKey = '';
  lastAt = 0;
}
