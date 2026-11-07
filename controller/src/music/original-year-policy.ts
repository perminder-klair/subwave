// The original-year facet's rules (#842, #1418): what a MusicBrainz answer
// means for a track, and when a failed lookup may be asked again. Pure; the
// lookup is music/musicbrainz.ts, the write is library-db/tracks.ts
// recordOriginalYearOutcome, and the row is derived in library-db/facets.ts.
//
// Three answers, kept apart because they mean different things:
//   found      MusicBrainz gave a confident original year → stored, facet ok
//   not-found  MusicBrainz answered and had no confident match → the track is
//              checked (original_year_checked_at) and the facet is
//              'unmeasurable / not-found', terminal at this version
//   error      the question was never answered (timeout, network, HTTP 5xx or
//              a 503 rate limit) → nothing is stamped on the track, the facet
//              is 'failed' and the lookup is retried on a widening schedule
//
// Folding an error into "not found" (the old behaviour) made a network blip a
// permanent miss: the checked stamp kept every later pass off the track.

export type OriginalYearOutcome =
  | { kind: 'found'; year: number }
  | { kind: 'not-found' }
  | { kind: 'error'; reason: string };

// A failed lookup is retried after these delays, measured from the failed
// attempt: the first retry an hour later (a blip), then a day (an outage),
// then a week (a long one). After YEAR_MAX_ATTEMPTS failures the track waits
// for an explicit `--facets year --where failed` run.
export const YEAR_RETRY_DELAYS_MS: readonly number[] = [
  60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];
export const YEAR_MAX_ATTEMPTS = YEAR_RETRY_DELAYS_MS.length;

// May a track whose lookup failed `attempts` times, the last at `lastAt`, be
// asked again automatically at `now`? An unreadable timestamp is not a reason
// to wait forever: the track is due.
export function yearRetryDue(attempts: number, lastAt: string | null | undefined, now: number): boolean {
  if (!Number.isFinite(attempts) || attempts <= 0) return true;
  if (attempts >= YEAR_MAX_ATTEMPTS) return false;
  const last = lastAt ? Date.parse(lastAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return now - last >= YEAR_RETRY_DELAYS_MS[attempts - 1];
}

// Short, single-line reason for a failed lookup, safe to store and log.
export function yearErrorReason(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const msg = err instanceof Error ? err.message : String(err ?? 'error');
  return (msg || 'error').replace(/\s+/g, ' ').slice(0, 200);
}
