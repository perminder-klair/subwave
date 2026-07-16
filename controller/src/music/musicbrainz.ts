// Direct MusicBrainz client (read-only) — resolves a track's ORIGINAL release
// year (issue #842).
//
// Compilation albums carry the compilation's release date, not each song's —
// "100 Hits: 70s Chartbusters" (2013) is full of 1970s recordings tagged 2013,
// so era-bounded shows both mis-include it (a "2010s" show) and miss it (a
// "70s" show). Per-track original-date tags aren't standard practice and
// Navidrome doesn't surface them per-song anyway, so the enrichment pass asks
// MusicBrainz: every MB recording carries `first-release-date`, the earliest
// release known to contain that recording.
//
// One recording search returns MANY distinct recordings for a title+artist
// (studio, live, remaster, cover-adjacent noise), each with its own
// first-release-date — the studio original is rarely the top hit. So the
// resolver filters to candidates that genuinely match (score + normalised
// title/artist) and takes the EARLIEST plausible year across them. When
// Navidrome supplies a per-song recording MBID (musicBrainzId), that exact
// recording is looked up first — no fuzzy matching needed.
//
// API etiquette (https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting):
// keyless, but strictly 1 request/second per client with a descriptive
// User-Agent. All calls funnel through a module-level throttle chain so
// callers can fire concurrently and still emit ≤1 req/s. Failures return null
// with no retry (project convention — the enrichment loop is resumable and a
// miss is stamped so it isn't re-queried every pass).

import { fetchWithTimeout } from '../util/fetch-timeout.js';

const MB_API = 'https://musicbrainz.org/ws/2';
// MB asks for app + contact in the UA; version intentionally coarse so it
// doesn't drift from package.json.
const USER_AGENT = 'subwave/1.0 ( https://github.com/perminder-klair/subwave )';
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1100; // 1 req/s with a safety margin
const MIN_SCORE = 90;    // Lucene match score floor for search candidates
const MIN_YEAR = 1900;   // sanity window for a "real" recording year

// ── 1 req/s throttle ─────────────────────────────────────────────────────────
// Serialise every MB request on one promise chain, spacing request STARTS by
// MIN_GAP_MS. The enrichment pool runs tracks concurrently; this keeps the
// station a polite MB citizen regardless of pool width.
let gate: Promise<void> = Promise.resolve();
let lastStart = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  // Keep the chain alive past failures — a rejected link would poison every
  // queued caller behind it.
  gate = run.then(() => undefined, () => undefined);
  return run;
}

// ── Pure candidate filtering (unit-pinned in scripts/original-year.test.ts) ──

// Normalised comparison token — same shape as show-filter.normGenre so titles
// like "Dancing Queen (Remastered)" still contain "dancingqueen".
function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The slice of an MB recording the resolver reads. Search results carry all of
// it; the shape is loose because it's third-party JSON.
export interface MbRecording {
  score?: number;
  title?: string;
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

function creditNames(r: MbRecording): string[] {
  return (r['artist-credit'] ?? [])
    .flatMap((c) => [c?.name, c?.artist?.name])
    .filter((n): n is string => typeof n === 'string' && !!n);
}

// Earliest plausible original year across the recordings that genuinely match
// title+artist. `trusted: true` (MBID lookup — the id IS the match) skips the
// score/title/artist gate and only sanity-checks the year. `maxYear` is the
// track's own file year when known — a hard upper bound, since the song
// evidently existed by then: without it, a 2022 song on a DJ-mix compilation
// resolved to 2025 because a later mix release carries a recording with the
// exact suffixed title. Returns null when nothing usable matches — the caller
// records a checked-but-missed.
export function earliestOriginalYear(
  recordings: MbRecording[],
  match: { title: string; artist: string; trusted?: boolean; maxYear?: number | null },
): number | null {
  const wantTitle = norm(match.title);
  const wantArtist = norm(match.artist);
  const absMax = new Date().getUTCFullYear() + 1;
  const maxYear = Number.isFinite(match.maxYear as number) && (match.maxYear as number) > 0
    ? Math.min(match.maxYear as number, absMax)
    : absMax;
  let earliest: number | null = null;
  for (const r of recordings ?? []) {
    if (!match.trusted) {
      if ((r.score ?? 0) < MIN_SCORE) continue;
      const gotTitle = norm(r.title);
      if (!wantTitle || !gotTitle) continue;
      if (gotTitle !== wantTitle && !gotTitle.includes(wantTitle) && !wantTitle.includes(gotTitle)) continue;
      const credits = creditNames(r).map(norm);
      if (wantArtist && credits.length && !credits.some((c) => c === wantArtist || c.includes(wantArtist) || wantArtist.includes(c))) continue;
    }
    const frd = r['first-release-date'] ?? '';
    const y = parseInt(frd.slice(0, 4), 10);
    if (!Number.isFinite(y) || y < MIN_YEAR || y > maxYear) continue;
    if (earliest == null || y < earliest) earliest = y;
  }
  return earliest;
}

// Which tracks are worth an MB round-trip (shared by phase-0 enrichment and
// the single-track retag route so the two can't drift). Only compilation-album
// tracks — their plain `year` is the compilation's date, so era filtering
// treats them as unknown until resolved. Non-compilation reissues are covered
// by the walk-time album-tag path; everything else keeps its `year`. A prior
// checked-but-missed stamp skips the track unless the operator asked for a
// re-enrich.
export function needsOriginalYearLookup(
  t: {
    isCompilation?: boolean | null;
    originalYear?: number | null;
    originalYearCheckedAt?: string | null;
  },
  reEnrich = false,
): boolean {
  if (t.isCompilation !== true) return false;
  if (t.originalYear != null) return false;
  return reEnrich || !t.originalYearCheckedAt;
}

// ── Lookup ───────────────────────────────────────────────────────────────────

async function searchRecordings(query: string): Promise<MbRecording[]> {
  // limit=100 (the API max) matters: results are relevance-ranked with no
  // date sort, and a heavily re-released track ("Le Freak") has so many
  // recordings that the ORIGINAL often falls outside the top 25 — a 25-cap
  // resolved it to 1988 instead of 1978. The earliest-year fold below wants
  // the widest candidate set one request can carry.
  const url = `${MB_API}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=100`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { recordings?: MbRecording[] };
  return Array.isArray(body.recordings) ? body.recordings : [];
}

// Escape a value for use inside a quoted Lucene phrase.
function phrase(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

// Strip trailing parenthetical/bracket noise from a compilation track title —
// "(Mixed)", "[feat. Doja Cat] [Mixed]", "(Remix)", etc. The search query is a
// Lucene PHRASE, so "Super Gremlin (Mixed)" matches nothing even though MB has
// "Super Gremlin" — DJ-mix albums missed wholesale until the retry searched
// the stripped title. Loops so stacked suffixes all come off; never strips a
// title down to nothing.
export function stripTitleNoise(title: string): string {
  let t = (title ?? '').trim();
  for (;;) {
    const next = t.replace(/\s*[([][^()[\]]*[)\]]$/, '').trim();
    if (next === t || !next) break;
    t = next;
  }
  return t;
}

// First credited artist — "DJ Khaled feat. Future & Lil Baby" → "DJ Khaled".
// Used only for the retry QUERY; the candidate matcher still compares against
// the full artist string (its normalised-containment check handles joint
// credits like "Future & Gunna" against MB's split artist-credit).
export function primaryArtist(artist: string): string {
  const cut = (artist ?? '').split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s*[,&]\s*|\s+x\s+/i)[0];
  return (cut || artist || '').trim();
}

// Resolve the original release year for one track. MBID first (exact), then a
// title+artist phrase search, then — because compilation titles carry noise
// the phrase search can't see past — a retry with suffixes stripped and the
// primary artist only. `year` (the file's own year, when known) caps every
// candidate: the original can't post-date the release the file came from.
// Returns null on no confident match or any request failure — never throws.
export async function lookupOriginalYear(track: {
  title?: string | null;
  artist?: string | null;
  mbid?: string | null;
  year?: number | null;
}): Promise<number | null> {
  const title = (track.title ?? '').trim();
  const artist = (track.artist ?? '').trim();
  const mbid = (track.mbid ?? '').trim();
  const maxYear = track.year ?? null;
  try {
    if (mbid) {
      const recs = await throttled(() => searchRecordings(`rid:${mbid}`));
      const y = earliestOriginalYear(recs, { title, artist, trusted: true, maxYear });
      if (y != null) return y;
    }
    if (!title || !artist) return null;
    const attempts: Array<{ t: string; a: string }> = [{ t: title, a: artist }];
    const stripped = stripTitleNoise(title);
    const primary = primaryArtist(artist);
    if (stripped !== title || primary !== artist) attempts.push({ t: stripped, a: primary });
    for (const at of attempts) {
      const recs = await throttled(() =>
        searchRecordings(`recording:${phrase(at.t)} AND artist:${phrase(at.a)}`),
      );
      // Match against the ATTEMPT's title (the stripped retry must compare
      // stripped-to-stripped) but always the full artist string — the
      // containment check handles joint credits either way.
      const y = earliestOriginalYear(recs, { title: at.t, artist, maxYear });
      if (y != null) return y;
    }
    return null;
  } catch {
    return null;
  }
}
