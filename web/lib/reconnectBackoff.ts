// How long the web player waits before it replaces a connection that closed or
// errored. hooks/usePlayer.ts owns the timer, the media listeners and the
// reconnect itself; this decides the delay and when the count starts over.
//
// A `playing` alone proves little. Something in front of Icecast (a proxy that
// stops a response after so many bytes, a broken middlebox) can cut every
// connection a moment into the audio, and every reconnect costs a full Icecast
// burst, about 22 s of audio. When `playing` reset the count for good, a cut after
// 1 s of audio ran at 25-37 connects a minute per listener and a cut after 0.25 s
// at 49-61 (Chromium and Firefox, a real Icecast behind a cutting proxy). A proxy
// with a short timeout is not this: its cut lands after the burst has, so the
// listener hears the burst out and `ended` comes long past the threshold (a cut
// 1 s in runs at 2.4 a minute with sound 98% of the time, measured).
//
// So the reset on `playing` is provisional. A connection that closes within
// STAYED_UP_MS of it takes the reset back and counts as one more failure; one
// that closes later stands as a success. The judge is wall-clock time since the
// connection's first `playing`, never currentTime: on Opus ICY a mid-stream join
// starts the clock far above 0 (measured t=705.16). It is also not reset by the
// `playing` that ends each `waiting`, or a slow link would look like a new
// connection every few seconds.
//
// The threshold sits between what it has to catch and what it has to leave alone.
// A connection cut just past it cycles in about STAYED_UP_MS + 0.6 s, the base
// delay plus the connect, so the worst case is about 12 a minute (measured 8-11
// at 4.2 s), what a source flapping 3 s up and 1 s down already costs. A cut after
// 5 s stays at 7-8 a minute, with sound 93% of the time.
//
// An early close after `playing` waits at most PLAYED_MAX_MS. That connection
// proved the station is up, so only load argues for a longer wait, and 16 s
// already holds a 1 s cut to about 3.5 connects a minute, about one healthy
// listener's worth of bursts (37 with no rule, 1 at the full curve's minute). It
// also bounds the price of the rule: a connection that closes inside the threshold
// just after a long outage, which nothing here can tell from a proxy's cut, waits
// 16 s rather than the outage's minute (measured 17 s to the next connect). The
// count still climbs, so a refused connect after it takes the full curve.
//
// A mount that loses its source is not a close. Icecast-KH holds the listener's
// socket open for about 15 s, so the connection stalls and the watchdog replaces
// it, and that path never comes here. It fires at least 5 s (WATCHDOG_MS) after
// `playing`, which is past STAYED_UP_MS, so the reset stands by the same wall-clock
// rule. That matters: on a source flapping 3 s up and 1 s down connections play
// only 1.4-2.8 s, and a count that survived them would climb on every refused
// connect until those listeners waited a minute.
//
// One cut never comes here either. Chromium answers a TCP reset by requesting the
// stream again itself and tells the element nothing, so a proxy that resets every
// connection runs at 25 connects a minute there whatever this decides (measured).

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 60_000;
/** How long after `playing` a connection must close to count as having stayed up. */
export const STAYED_UP_MS = 4000;
/** The most a connection that reached `playing` waits after an early close. */
export const PLAYED_MAX_MS = 16_000;

export interface Backoff {
  /** Failed connections in a row. Drives the next delay. */
  retries: number;
  /** `retries` when this connection reached `playing`: what an early close takes back. */
  heldRetries: number;
  /** When this connection first reached `playing`; null until it does. */
  playingSince: number | null;
}

export const NO_BACKOFF: Backoff = { retries: 0, heldRetries: 0, playingSince: null };

function delayFor(retries: number, max: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** retries, max);
}

/** A new connection starts. What the last one played says nothing about this one,
 *  so a refused connect can't pass for a connection that stayed up. */
export function connectionStarted(backoff: Backoff): Backoff {
  return { ...backoff, playingSince: null };
}

/** `playing` fired. Only the first per connection counts. */
export function reachedPlaying(backoff: Backoff, now: number): Backoff {
  if (backoff.playingSince !== null) return backoff;
  return { retries: 0, heldRetries: backoff.retries, playingSince: now };
}

/** The connection closed or errored: how long to wait, and the state to keep.
 *  Safe to call twice for a connection that reached `playing`, as Firefox's reset
 *  does (`error` while the buffer is audible, `ended` once it runs out). Each call
 *  judges it afresh, so a listener who heard a whole burst out counts as up by
 *  `ended`, and the one failure is counted once. */
export function connectionClosed(backoff: Backoff, now: number): { delayMs: number; next: Backoff } {
  const { playingSince } = backoff;
  let retries = backoff.retries;
  if (playingSince !== null) retries = now - playingSince < STAYED_UP_MS ? backoff.heldRetries : 0;
  const max = playingSince !== null ? PLAYED_MAX_MS : RECONNECT_MAX_MS;
  return { delayMs: delayFor(retries, max), next: { ...backoff, retries: retries + 1 } };
}
