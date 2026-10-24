// Read-only MusicBrainz client resolving a track's ORIGINAL release year (#842),
// from each recording's `first-release-date`. One search returns many distinct
// recordings for a title+artist (studio, live, remaster, noise) and the studio
// original is rarely the top hit, so the resolver filters to genuine matches and
// takes the EARLIEST plausible year. A per-song recording MBID is looked up
// first and needs no fuzzy matching.
//
// API etiquette (https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting):
// keyless, but strictly 1 req/s per client with a descriptive User-Agent, so
// every call funnels through the module-level throttle chain below. Failures
// return null with no retry — the enrichment loop is resumable and a miss is
// stamped so it isn't re-queried every pass.

import { fetchWithTimeout } from '../util/fetch-timeout.js';

const MB_API = 'https://musicbrainz.org/ws/2';
// MB asks for app + contact in the UA; version stays coarse so it can't drift
// from package.json.
const USER_AGENT = 'subwave/1.0 ( https://github.com/perminder-klair/subwave )';
const TIMEOUT_MS = 8000;
const MIN_GAP_MS = 1100; // 1 req/s with a safety margin
const MIN_SCORE = 90;    // Lucene match score floor for search candidates
const MIN_YEAR = 1900;   // sanity window for a "real" recording year

// Serialise every MB request on one promise chain, spacing request STARTS by
// MIN_GAP_MS, so a concurrent enrichment pool still emits <=1 req/s.
let gate: Promise<void> = Promise.resolve();
let lastStart = 0;

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return fn();
  });
  // Keep the chain alive past failures: a rejected link poisons every queued
  // caller behind it.
  gate = run.then(() => undefined, () => undefined);
  return run;
}

// Normalised comparison token, same shape as show-filter.normGenre, so
// "Dancing Queen (Remastered)" still contains "dancingqueen".
function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The slice of an MB recording the resolver reads; loose because it's
// third-party JSON.
export interface MbRecording {
  score?: number;
  title?: string;
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

export interface MbReleaseGroup {
  id?: string;
  score?: number;
  title?: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string; id?: string } }>;
}

function mbNameKey(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function mbDateRank(value: unknown, now = new Date()): { rank: number; precision: number } | null {
  const match = String(value ?? '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 0;
  const day = match[3] ? Number(match[3]) : 0;
  if (year < MIN_YEAR || month > 12 || day > 31) return null;
  const currentYear = now.getUTCFullYear();
  const currentRank = currentYear * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
  const rank = year * 10000 + month * 100 + day;
  if (rank > currentRank) return null;
  return { rank, precision: match[3] ? 3 : match[2] ? 2 : 1 };
}

const EXCLUDED_RELEASE_TYPES = new Set([
  'audio drama', 'audiobook', 'compilation', 'demo', 'dj-mix', 'field recording',
  'interview', 'live', 'mixtape/street', 'remix', 'soundtrack', 'spokenword',
]);

export function isCoreReleaseGroup(group: MbReleaseGroup, kind: 'single' | 'album'): boolean {
  const primary = String(group['primary-type'] || '').toLocaleLowerCase();
  if (primary !== kind) return false;
  return !(group['secondary-types'] || []).some(type => EXCLUDED_RELEASE_TYPES.has(String(type).toLocaleLowerCase()));
}

export function latestCoreReleaseGroup(
  groups: MbReleaseGroup[],
  kind: 'single' | 'album',
  now = new Date(),
): MbReleaseGroup | null {
  return groups
    .filter(group => isCoreReleaseGroup(group, kind) && mbDateRank(group['first-release-date'], now))
    .sort((left, right) => {
      const l = mbDateRank(left['first-release-date'], now)!;
      const r = mbDateRank(right['first-release-date'], now)!;
      return r.rank - l.rank
        || r.precision - l.precision
        || mbNameKey(left.title).localeCompare(mbNameKey(right.title))
        || String(left.id || '').localeCompare(String(right.id || ''));
    })[0] || null;
}

function creditNames(r: MbRecording): string[] {
  return (r['artist-credit'] ?? [])
    .flatMap((c) => [c?.name, c?.artist?.name])
    .filter((n): n is string => typeof n === 'string' && !!n);
}

// Earliest plausible original year across the recordings that genuinely match
// title+artist. `trusted: true` (an MBID lookup, where the id IS the match)
// skips the score/title/artist gate and only sanity-checks the year. `maxYear`
// is the track's own file year: a hard upper bound, since the song evidently
// existed by then. Null when nothing matches; the caller stamps a miss.
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

// Which tracks are worth an MB round-trip. Shared by phase-0 enrichment and the
// single-track retag route; `idsNeedingOriginalYear` is the SQL twin and must
// agree.
//
// The gate is era SUSPICION, not Navidrome's compilation flag (#1418) — the
// reissue anthologies it exists for arrive as `isCompilation: false`.
// `yearUntrusted` is composed once in the row mapper (flag OR derived
// judgement); passing the raw flag would silently reopen the gap.
//
// Any resolved year means there is nothing to ask. A checked-but-missed stamp
// skips the track unless the operator asked for a re-enrich; a MANUAL answer is
// never re-asked.
export function needsOriginalYearLookup(
  t: {
    yearUntrusted?: boolean | null;
    originalYear?: number | null;
    originalYearSource?: string | null;
    originalYearCheckedAt?: string | null;
  },
  reEnrich = false,
): boolean {
  if (t.yearUntrusted !== true) return false;
  if (t.originalYear != null) return false;
  if (t.originalYearSource === 'manual') return false;
  return reEnrich || !t.originalYearCheckedAt;
}

async function searchRecordings(query: string): Promise<MbRecording[]> {
  // limit=100 (the API max): results are relevance-ranked with no date sort, so
  // a heavily re-released track's original often falls outside the top 25 and
  // the earliest-year fold wants the widest set one request can carry.
  const url = `${MB_API}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=100`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { recordings?: MbRecording[] };
  return Array.isArray(body.recordings) ? body.recordings : [];
}

async function searchLatestArtist(name: string, signal?: AbortSignal): Promise<{ id: string; name: string } | null> {
  const escaped = name.replace(/[\\"]/g, '\\$&');
  const url = `${MB_API}/artist/?query=${encodeURIComponent(`artist:"${escaped}"`)}&fmt=json&limit=10`;
  const res = await throttled(() => fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  }));
  if (!res.ok) return null;
  const body = await res.json() as { artists?: Array<{ id?: string; name?: string; score?: number; aliases?: Array<{ name?: string; primary?: boolean }> }> };
  const wanted = mbNameKey(name);
  const candidates = (Array.isArray(body.artists) ? body.artists : [])
    .filter(artist => artist.id && artist.name && (artist.score || 0) >= MIN_SCORE)
    .filter(artist => mbNameKey(artist.name) === wanted
      || (artist.aliases || []).some(alias => mbNameKey(alias.name) === wanted))
    .sort((left, right) => (right.score || 0) - (left.score || 0)
      || mbNameKey(left.name).localeCompare(mbNameKey(right.name))
      || String(left.id).localeCompare(String(right.id)));
  const best = candidates[0];
  return best?.id && best.name ? { id: best.id, name: best.name } : null;
}

async function searchLatestReleaseGroups(
  artistId: string,
  kind: 'single' | 'album',
  fromYear: number,
  toYear: number,
  signal?: AbortSignal,
): Promise<MbReleaseGroup[]> {
  const primaryType = kind === 'album' ? 'Album' : 'Single';
  const query = `arid:${artistId} AND primarytype:${primaryType} AND firstreleasedate:[${fromYear} TO ${toYear}]`;
  const url = `${MB_API}/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=100`;
  const res = await throttled(() => fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal,
  }));
  if (!res.ok) return [];
  const body = await res.json() as { 'release-groups'?: MbReleaseGroup[] };
  return Array.isArray(body['release-groups']) ? body['release-groups'] : [];
}

/**
 * Find the newest core official release for an artist. The search is bounded
 * to three date windows; generic web evidence remains the freshness fallback
 * when MusicBrainz does not return a confident result.
 */
export async function lookupLatestReleaseGroup(
  artistName: string,
  kind: 'single' | 'album',
  signal?: AbortSignal,
): Promise<{ title: string; artist: string; releaseDate: string; source: 'musicbrainz'; sourceUrls: string[] } | null> {
  try {
    const artist = await searchLatestArtist(artistName, signal);
    if (!artist) return null;
    const currentYear = new Date().getUTCFullYear();
    const windows: Array<[number, number]> = [
      [currentYear, currentYear],
      [Math.max(MIN_YEAR, currentYear - 5), currentYear - 1],
      [MIN_YEAR, Math.max(MIN_YEAR, currentYear - 6)],
    ];
    const groups: MbReleaseGroup[] = [];
    for (const [fromYear, toYear] of windows) {
      if (fromYear > toYear) continue;
      groups.push(...await searchLatestReleaseGroups(artist.id, kind, fromYear, toYear, signal));
      const best = latestCoreReleaseGroup(groups, kind);
      if (best?.title && best['first-release-date'] && best.id) {
        return {
          title: best.title,
          artist: artist.name,
          releaseDate: best['first-release-date'],
          source: 'musicbrainz',
          sourceUrls: [`https://musicbrainz.org/release-group/${best.id}`],
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Escape a value for use inside a quoted Lucene phrase.
function phrase(s: string): string {
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

// Strip trailing parenthetical/bracket noise ("(Mixed)", "[feat. X]") from a
// title. The query is a Lucene PHRASE, so "Super Gremlin (Mixed)" matches
// nothing even when MB has "Super Gremlin". Loops for stacked suffixes; never
// strips a title down to nothing.
export function stripTitleNoise(title: string): string {
  let t = (title ?? '').trim();
  for (;;) {
    const next = t.replace(/\s*[([][^()[\]]*[)\]]$/, '').trim();
    if (next === t || !next) break;
    t = next;
  }
  return t;
}

// First credited artist ("DJ Khaled feat. Future & Lil Baby" -> "DJ Khaled").
// Used only for the retry QUERY; the candidate matcher still compares the full
// artist string, whose containment check handles joint credits.
export function primaryArtist(artist: string): string {
  const cut = (artist ?? '').split(/\s+(?:feat\.?|ft\.?|featuring|with)\s+|\s*[,&]\s*|\s+x\s+/i)[0];
  return (cut || artist || '').trim();
}

// Resolve the original release year for one track: MBID first (exact), then a
// title+artist phrase search, then a retry with suffixes stripped and the
// primary artist only. `year` (the file's own) caps every candidate. Returns
// null on no confident match or any request failure; never throws.
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
      // Match the ATTEMPT's title (stripped-to-stripped on the retry) but always
      // the full artist string.
      const y = earliestOriginalYear(recs, { title: at.t, artist, maxYear });
      if (y != null) return y;
    }
    return null;
  } catch {
    return null;
  }
}
