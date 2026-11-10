// Discogs as the original-year fallback (the year facet, original-year-policy.ts).
// Asked only when MusicBrainz has no year for an era-suspect track and the
// operator has set a personal access token (DISCOGS_TOKEN, Settings → Library →
// Enrichment). Discogs groups every pressing of a record under a master, whose
// year is the first release's, which is the year a reissue or compilation hides.
//
// One database search per track: the artist plus the title with its noise
// stripped, as `track` (a release containing that track). The answer is the
// earliest year among the artist's own masters and releases, capped by the
// file's year like MusicBrainz's. Results by any other artist (a "Various"
// compilation) never answer; artist and label results carry no " - " title.
//
// API etiquette (https://www.discogs.com/developers): a descriptive User-Agent,
// the token in the Authorization header (never the URL, which ends up in logs),
// 60 requests a minute authenticated, so requests are spaced like MusicBrainz's.

import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { primaryArtist, stripTitleNoise } from './musicbrainz.js';
import { retryWaitMs, yearErrorReason, type OriginalYearOutcome } from './original-year-policy.js';

const API = 'https://api.discogs.com/database/search';
const USER_AGENT = 'subwave/1.0 +https://github.com/perminder-klair/subwave';
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1100;
const MIN_YEAR = 1900;

export function discogsToken(): string {
  return (process.env.DISCOGS_TOKEN ?? '').trim();
}

let gate: Promise<void> = Promise.resolve();
let lastStart = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  gate = run.then(() => undefined, () => undefined);
  return run;
}

// Artist names as Discogs writes them: "Wendy Rene (2)" disambiguates two
// artists of one name, "Name*" marks a name variation; "The" is dropped on
// both sides.
function artistKey(s: string): string {
  return s
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\*+$/, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

interface DiscogsResult {
  type?: string;
  title?: string;
  year?: string | number;
}

export function earliestDiscogsYear(results: DiscogsResult[], artist: string, maxYear: number | null): number | null {
  const want = new Set([artistKey(artist), artistKey(primaryArtist(artist))].filter(Boolean));
  const cap = maxYear ?? new Date().getFullYear();
  let earliest: number | null = null;
  for (const r of results) {
    const cut = (r.title ?? '').indexOf(' - ');
    if (cut <= 0 || !want.has(artistKey(r.title!.slice(0, cut)))) continue;
    const y = parseInt(String(r.year ?? ''), 10);
    if (!Number.isFinite(y) || y < MIN_YEAR || y > cap) continue;
    if (earliest == null || y < earliest) earliest = y;
  }
  return earliest;
}

// found / not-found / error, like musicbrainz.lookupOriginalYear. Without a
// token nothing is asked and the answer is not-found. A token Discogs refuses
// (401 or 403: mistyped, revoked) also answers not-found, i.e. "Discogs took
// no part": it is the operator's setting, not a question left unanswered, so
// it must not turn MusicBrainz's settled misses into failures that use up
// their retries. Never throws.
//
// A refused token is remembered for the rest of the process, so every later
// lookup skips Discogs without a request or its 1.1 s throttle gap (a re-ask
// of thousands of misses would otherwise spend an hour on refusals). It is
// keyed on the token's value: a different token is asked again, and saving
// one from the settings clears it (forgetDiscogsRefusal, routes/settings/core).
// The refusal is logged once per refused token.
const REFUSED = new Set([401, 403]);
let refusedToken: string | null = null;
export function forgetDiscogsRefusal(): void { refusedToken = null; }
// The configured token is the one Discogs refused: lookups skip Discogs.
export function discogsRefused(): boolean {
  const token = discogsToken();
  return token !== '' && token === refusedToken;
}
export async function lookupDiscogsYear(track: {
  title?: string | null;
  artist?: string | null;
  year?: number | null;
}): Promise<OriginalYearOutcome> {
  const token = discogsToken();
  const title = stripTitleNoise((track.title ?? '').trim());
  const artist = (track.artist ?? '').trim();
  if (!token || !title || !artist || token === refusedToken) return { kind: 'not-found' };
  const url = new URL(API);
  url.searchParams.set('artist', primaryArtist(artist));
  url.searchParams.set('track', title);
  url.searchParams.set('per_page', '100');
  const get = () => fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Authorization: `Discogs token=${token}` },
  });
  try {
    const body = await throttled(async () => {
      // Refused while this lookup waited for its slot: no request.
      if (token === refusedToken) return { skipped: true as const };
      let res = await get();
      const wait = retryWaitMs(res.status, res.headers.get('retry-after'));
      if (wait != null) {
        await new Promise((r) => setTimeout(r, wait));
        // The retry is a request too: the next one keeps a full gap from it.
        lastStart = Date.now();
        res = await get();
      }
      if (REFUSED.has(res.status)) return { refused: res.status };
      if (!res.ok) throw new Error(`Discogs HTTP ${res.status}`);
      return (await res.json()) as { results?: DiscogsResult[] };
    });
    if ('skipped' in body) return { kind: 'not-found' };
    if ('refused' in body) {
      if (refusedToken !== token) {
        refusedToken = token;
        console.warn(
          `[discogs] the token was refused (HTTP ${body.refused}): Discogs is skipped from now on, ` +
            'until the token is changed or saved again (Settings → Library → Enrichment)',
        );
      }
      return { kind: 'not-found' };
    }
    const y = earliestDiscogsYear(Array.isArray(body.results) ? body.results : [], artist, track.year ?? null);
    return y != null ? { kind: 'found', year: y, source: 'discogs' } : { kind: 'not-found', source: 'discogs' };
  } catch (err) {
    return { kind: 'error', reason: yearErrorReason(err), source: 'discogs' };
  }
}
