// The original-year facet's rules (#842, #1418): what a MusicBrainz answer
// means for a track, and when a failed lookup may be asked again. Pure; the
// lookup is music/musicbrainz.ts, the write is library-db/tracks.ts
// recordOriginalYearOutcome, and the row is derived in library-db/facets.ts.
//
// Three answers, kept apart because they mean different things:
//   found      a source (MusicBrainz, then Discogs when a token is set) gave
//              a confident original year → stored with its source, facet ok
//   not-found  every source answered and none had a confident match → the track is
//              checked (original_year_checked_at) and the facet is
//              'unmeasurable / not-found', terminal at this version
//   error      the question was never answered (timeout, network, HTTP 5xx or
//              a 503 rate limit) → nothing is stamped on the track, the facet
//              is 'failed' and the lookup is retried on a widening schedule
//
// Folding an error into "not found" (the old behaviour) made a network blip a
// permanent miss: the checked stamp kept every later pass off the track.

// Where a found year came from (tracks.original_year_source). MusicBrainz is
// asked first; Discogs only when MusicBrainz has no year and a token is set.
export type YearSource = 'musicbrainz' | 'discogs';

// Per-track years the library walk never overwrites with its album-tag year:
// one a lookup found (either source) or one the operator typed. The walk's
// upsert (library-db/tracks.ts) and an id adoption (id-adoption.ts) both keep
// them; the SQL form is the same list, for the upsert's CASE.
export const KEPT_YEAR_SOURCES: readonly string[] = ['musicbrainz', 'discogs', 'manual'];
export const SQL_KEPT_YEAR_SOURCES = `(${KEPT_YEAR_SOURCES.map((s) => `'${s}'`).join(', ')})`;
export function yearSourceKept(source: string | null | undefined): boolean {
  return source != null && KEPT_YEAR_SOURCES.includes(source);
}

// `source` is the source that gave this answer (for not-found and error, the
// last host asked; Discogs is asked only after a MusicBrainz miss, so
// `discogs` on a miss means both missed). A Discogs that took no part (no
// token, a refused one) answers not-found with no source, and the combined
// lookup keeps MusicBrainz's answer. The year row records it
// (track_facet_status.source), so a failure names the host that failed.
export type OriginalYearOutcome =
  | { kind: 'found'; year: number; source?: YearSource }
  | { kind: 'not-found'; source?: YearSource }
  | { kind: 'error'; reason: string; source?: YearSource };

// A failed lookup is retried after these delays, measured from the failed
// attempt: the first retry an hour later (a blip), then a day (an outage),
// then a week (a long one). YEAR_MAX_ATTEMPTS counts the first failure plus
// one per delay, so the week-long retry does run; after that many failures the
// automatic passes stop asking and the track waits for an explicit run
// (`--facets year --where failed`, `--where all`, or `--re-enrich` over it).
export const YEAR_RETRY_DELAYS_MS: readonly number[] = [
  60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];
export const YEAR_MAX_ATTEMPTS = YEAR_RETRY_DELAYS_MS.length + 1;

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

// How long to wait before asking a rate-limited request once more, or null
// when the answer is not worth a retry. Only a rate-limit answer (429, or the
// 503 MusicBrainz sends when it is busy) is retried, once, after Retry-After
// (in seconds), capped so one busy server never parks the whole pass.
const RETRY_DEFAULT_MS = 2000;
const RETRY_MAX_MS = 10_000;
export function retryWaitMs(status: number, retryAfter: string | null | undefined): number | null {
  if (status !== 429 && status !== 503) return null;
  const s = retryAfter != null && /^\s*\d+\s*$/.test(retryAfter) ? Number(retryAfter) * 1000 : RETRY_DEFAULT_MS;
  return Math.min(s, RETRY_MAX_MS);
}

// Short, single-line reason for a failed lookup, safe to store and log.
export function yearErrorReason(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const msg = err instanceof Error ? err.message : String(err ?? 'error');
  return (msg || 'error').replace(/\s+/g, ' ').slice(0, 200);
}
