// Pacing for a bulk pass of per-track Last.fm reads. Last.fm publishes no hard
// limit, so a pass stays under about 4 requests a second, counted across the
// whole pool: request STARTS are spaced on one chain, the way musicbrainz.ts
// does it, so the width of the pool never changes the rate.
//
// A failure holds every worker, not just the one that saw it, and the hold
// doubles while failures run on. A 429 or error 29 starts from a longer hold
// than a 5xx, because that one is Last.fm telling us to stop. Nothing retries the
// request that failed: its track stays owed and a later pass asks again.
//
// Enough consecutive failures end the pass. Without this an outage would have
// phase 0 walk the whole library through 5 s timeouts, holding back the embed
// pass for new tracks to learn nothing. Requests already in flight when a hold
// begins report inside it, and they count as the same incident, not more of them.
//
// One pacer per pass, in the tagger's one process. The retag route's two calls
// are an operator's click and go unpaced.

const MIN_GAP_MS = 260; // ~3.85 req/s, leaving a margin under 4
const FAILURE_BACKOFF_MS = 5_000;
const RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
const MAX_CONSECUTIVE_FAILURES = 6;

export interface LastfmPacerOptions {
  minGapMs?: number;
  failureBackoffMs?: number;
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
  maxConsecutiveFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface LastfmPacer {
  // Resolves when the next request may start; false once the pass has given up.
  turn(): Promise<boolean>;
  answered(): void;
  failed(rateLimited: boolean): void;
  readonly gaveUp: boolean;
}

export function createLastfmPacer(opts: LastfmPacerOptions = {}): LastfmPacer {
  const {
    minGapMs = MIN_GAP_MS,
    failureBackoffMs = FAILURE_BACKOFF_MS,
    rateLimitBackoffMs = RATE_LIMIT_BACKOFF_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = opts;

  let gate: Promise<boolean> = Promise.resolve(true);
  let lastStart = -Infinity;
  let holdUntil = 0;
  let failures = 0;
  let gaveUp = false;

  return {
    get gaveUp() {
      return gaveUp;
    },
    turn() {
      gate = gate.then(async () => {
        // A loop, because a hold can begin while this turn is sleeping.
        for (;;) {
          if (gaveUp) return false;
          const wait = Math.max(lastStart + minGapMs, holdUntil) - now();
          if (wait <= 0) break;
          await sleep(wait);
        }
        lastStart = now();
        return true;
      });
      return gate;
    },
    answered() {
      failures = 0;
    },
    failed(rateLimited) {
      const at = now();
      if (at < holdUntil) return;
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        gaveUp = true;
        return;
      }
      const base = rateLimited ? rateLimitBackoffMs : failureBackoffMs;
      holdUntil = at + Math.min(maxBackoffMs, base * 2 ** (failures - 1));
    },
  };
}
