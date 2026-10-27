// Which track a tuned-in listener is hearing. The station reports the live
// edge; the stream reaches the listener stream.bufferSeconds later, so for that
// long after a change they still hear the previous track. useStationFeed
// promotes a new track at audibleAt(); the App Intents (src/intents/on-air.ts)
// answer "what's playing" and "like this song" with heardTrack(), which reads
// the same rule from one /now-playing + /state snapshot.

import { MAX_LEAD_SECONDS } from './sessionFeed';

/** stream.bufferSeconds as milliseconds, clamped to 0–60 s so a bad value
 *  can't park the clock in the far future. Null when the station sent none. */
export function leadMsFrom(bufferSeconds: number | null | undefined): number | null {
  if (typeof bufferSeconds !== 'number' || !Number.isFinite(bufferSeconds)) return null;
  return Math.min(Math.max(bufferSeconds, 0), MAX_LEAD_SECONDS) * 1000;
}

/** When a track that started at the live edge at `liveStartMs` reaches the
 *  listener. */
export function audibleAt(liveStartMs: number, leadMs: number): number {
  return liveStartMs + leadMs;
}

/** The live track once it is audible, the previous one before that. With no
 *  live-edge start time to measure from, the live track. */
export function heardTrack<T>({
  live,
  previous,
  liveStartMs,
  leadMs,
  now,
}: {
  live: T | null;
  previous: T | null;
  liveStartMs: number | null;
  leadMs: number;
  now: number;
}): T | null {
  if (liveStartMs == null || !Number.isFinite(liveStartMs)) return live;
  return now < audibleAt(liveStartMs, leadMs) ? (previous ?? live) : live;
}
