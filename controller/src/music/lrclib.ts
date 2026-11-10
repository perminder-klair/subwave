// Read-only LRCLIB client (https://lrclib.net), the community synced-lyrics
// database behind the Lyrics panel's fallback (music/lyrics-sources.ts). It is
// open source and self-hostable, so `LRCLIB_URL` can point at a mirror.
//
// API etiquette: keyless, but LRCLIB asks a client to name itself in the
// User-Agent. Every request goes through one throttle chain at 1 req/s, the
// MusicBrainz client's pattern. LRCLIB also refuses with a 503 well below that
// rate (measured 2026-10-24: 7 of 24 requests paced under one a second, on
// both endpoints, with the next request answered normally), so a refused
// request (503 or 429) is asked again twice, RETRY_DELAYS_MS apart, waiting
// OUTSIDE the throttle so one stubborn track does not hold the others up.
// Past that it throws, and the caller backs that track off.
//
// Matching is narrow on purpose. A lyric file for a different cut (radio edit,
// extended mix, live) is timed against different audio, so:
//   1. GET /api/get with the track's whole signature. LRCLIB's own exact match,
//      which it holds to ±2s of the duration.
//   2. GET /api/search on the title without its "(feat. …)" and the lead
//      artist, keeping only a result within ±2s of OUR duration whose title and
//      artist agree with ours.
// No lookup at all without a duration, since nothing else tells two cuts apart.
//
// `find` THROWS when LRCLIB did not answer (transport, timeout, 429, 5xx), so
// the caller can tell "LRCLIB has nothing" (null, worth remembering) from
// "ask again later" (worth nothing).
import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { envUrl } from '../util/env.js';

const USER_AGENT = 'subwave/1.0 ( https://github.com/perminder-klair/subwave )';
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1100; // 1 req/s with a safety margin
// Waits before the second and third try of a refused request. Retry-After,
// when LRCLIB sends one, stretches a wait up to RETRY_AFTER_CAP_MS.
const RETRY_DELAYS_MS = [5_000, 15_000];
const RETRY_AFTER_CAP_MS = 30_000;
// LRCLIB's own tolerance on /api/get, applied to search results too.
export const LRCLIB_DURATION_TOLERANCE_SEC = 2;

export interface LrclibTrack {
  artist: string;
  title: string;
  album?: string | null;
  durationSec: number;
}

// The slice of an LRCLIB record the station reads; loose because it is
// third-party JSON.
export interface LrclibRecord {
  id?: number | null;
  trackName?: string | null;
  artistName?: string | null;
  duration?: number | null;
  instrumental?: boolean | null;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LrclibClient {
  find(track: LrclibTrack): Promise<LrclibRecord | null>;
}

// Case, accents and punctuation folded away, letters of every script kept: a
// Gurmukhi title must not fold to '' and then "contain" everything.
function fold(s: unknown): string {
  return String(s ?? '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** "Skrillex Feat. Chief Keef, Corbin" → "Skrillex". A bare slash is part of a
 *  name (AC/DC), so it never splits. */
export function leadArtist(artist: string): string {
  return artist.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|&)\s+|\s*[,;]\s*/i)[0].trim();
}

/** "Superman (feat. X) [Remix]" → "Superman [Remix]": only the credit goes. */
export function searchTitle(title: string): string {
  return title.replace(/\s*[([](?:feat|ft|featuring|with)\.?\s[^)\]]*[)\]]/gi, '').trim();
}

function agrees(ours: string, theirs: unknown): boolean {
  const a = fold(ours);
  const b = fold(theirs);
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

/** The search result to use for `track`, or null when none is the same cut. */
export function bestSearchMatch(results: readonly LrclibRecord[], track: LrclibTrack): LrclibRecord | null {
  const same = results.filter((r) =>
    Number.isFinite(r?.duration)
    && Math.abs(Number(r.duration) - track.durationSec) <= LRCLIB_DURATION_TOLERANCE_SEC
    && agrees(searchTitle(track.title), r.trackName)
    && agrees(leadArtist(track.artist), r.artistName));
  return same.find((r) => r.syncedLyrics) ?? same.find((r) => r.instrumental) ?? same.find((r) => r.plainLyrics) ?? null;
}

export interface LrclibClientOptions {
  baseUrl: string;
  minGapMs?: number;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export function createLrclibClient({
  baseUrl,
  minGapMs = MIN_GAP_MS,
  timeoutMs = TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
}: LrclibClientOptions): LrclibClient {
  const root = baseUrl.replace(/\/+$/, '');

  // Serialise every request on one promise chain, spacing request STARTS, so
  // a station with several lookups queued still sends at most 1 req/s.
  let gate: Promise<void> = Promise.resolve();
  let lastStart = 0;
  function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = gate.then(async () => {
      const wait = lastStart + minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastStart = Date.now();
      return fn();
    });
    // A rejected link must not poison every caller queued behind it.
    gate = run.then(() => undefined, () => undefined);
    return run;
  }

  type Attempt<T> = { answer: T | null } | { refusedFor: number };

  // One try, inside the throttle. A refusal comes back as the wait LRCLIB
  // asked for (0 when it named none), so the retry can sleep outside the gate.
  function attempt<T>(url: string): Promise<Attempt<T>> {
    return throttled(async () => {
      const res = await fetchWithTimeout(url, {
        timeoutMs,
        bodyDeadline: true,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      // 404, and a 400 (LRCLIB refusing the question rather than failing to
      // answer it), mean it has nothing.
      if (res.status === 404 || res.status === 400) {
        await res.body?.cancel();
        return { answer: null };
      }
      if (res.status === 503 || res.status === 429) {
        await res.body?.cancel();
        const retryAfterSec = Number(res.headers.get('Retry-After'));
        return { refusedFor: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0 };
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`LRCLIB answered HTTP ${res.status}`);
      }
      return { answer: (await res.json()) as T };
    });
  }

  // null when LRCLIB has nothing; throws on anything that is not an answer.
  async function request<T>(path: string, params: Record<string, string>): Promise<T | null> {
    const url = `${root}/api/${path}?${new URLSearchParams(params)}`;
    for (let tries = 0; ; tries++) {
      const result = await attempt<T>(url);
      if ('answer' in result) return result.answer;
      if (tries >= retryDelaysMs.length) throw new Error(`LRCLIB answered HTTP 503 or 429 ${tries + 1} times`);
      const wait = Math.min(RETRY_AFTER_CAP_MS, Math.max(retryDelaysMs[tries], result.refusedFor));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return {
    async find(track) {
      const durationSec = Math.round(track.durationSec);
      if (!track.artist?.trim() || !track.title?.trim() || !(durationSec > 0)) return null;
      const exact = await request<LrclibRecord>('get', {
        artist_name: track.artist,
        track_name: track.title,
        album_name: track.album ?? '',
        duration: String(durationSec),
      });
      if (exact?.syncedLyrics || exact?.instrumental) return exact;
      const results = await request<LrclibRecord[]>('search', {
        track_name: searchTitle(track.title),
        artist_name: leadArtist(track.artist),
      });
      const found = Array.isArray(results) ? bestSearchMatch(results, { ...track, durationSec }) : null;
      // A plain-only exact hit still beats a plain-only search hit.
      return found?.syncedLyrics || found?.instrumental ? found : exact ?? found;
    },
  };
}

let shared: LrclibClient | null = null;

/** The station's client, built on first use so `LRCLIB_URL` is read once. */
export function lrclib(): LrclibClient {
  shared ??= createLrclibClient({ baseUrl: envUrl('LRCLIB_URL', 'https://lrclib.net') });
  return shared;
}
