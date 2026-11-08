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

/** Biography discovery shares the existing MusicBrainz request throttle. */
export function lookupMusicBrainzUrlRelations(entity:'artist'|'release-group',id:string):Promise<unknown|null> {
  return throttled(async()=>{
    const response=await fetchWithTimeout(`${MB_API}/${entity}/${encodeURIComponent(id)}?inc=url-rels&fmt=json`,{
      timeoutMs:TIMEOUT_MS,headers:{'User-Agent':USER_AGENT,Accept:'application/json'},
    });
    if (!response.ok) {
      if (response.status===404) return null;
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  });
}

// Normalised comparison token, same shape as show-filter.normGenre, so
// "Dancing Queen (Remastered)" still contains "dancingqueen".
function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// The slice of an MB recording the resolver reads; loose because it's
// third-party JSON.
export interface MbRecording {
  id?: string;
  score?: number;
  title?: string;
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

export interface CanonicalMusicBrainzRelease {
  id: string;
  releaseGroupId: string | null;
  title: string;
  date: string | null;
  country: string | null;
  status: string | null;
  primaryType: string | null;
  artistCredit: string | null;
  isCompilation: boolean;
}

export interface CanonicalMusicBrainzRecording {
  id: string;
  title: string;
  artist: { id: string; name: string } | null;
  releases: CanonicalMusicBrainzRelease[];
}

export interface MusicBrainzSeriesMember {
  id: string;
  title: string;
  /** Rank explicitly supplied as the relation's numeric `number` attribute. */
  rank: string | null;
}

export type MusicBrainzSeriesEntityType = 'recording' | 'release-group';

export interface MusicBrainzSeriesSnapshot {
  id: string;
  name: string;
  type: string | null;
  members: MusicBrainzSeriesMember[];
}

function creditNames(r: MbRecording): string[] {
  return (r['artist-credit'] ?? [])
    .flatMap((c) => [c?.name, c?.artist?.name])
    .filter((n): n is string => typeof n === 'string' && !!n);
}

function artistCreditText(credit: unknown): string | null {
  if (!Array.isArray(credit)) return null;
  const names = credit.map((item) => (item as { name?: unknown; artist?: { name?: unknown } })?.name
    ?? (item as { artist?: { name?: unknown } })?.artist?.name)
    .filter((name): name is string => typeof name === 'string' && !!name);
  return names.length ? names.join(', ') : null;
}

/** Projects only the recording/release fields the Sleeve Notes store owns. */
export function projectCanonicalRecording(payload: unknown): CanonicalMusicBrainzRecording | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : null;
  const title = typeof value.title === 'string' ? value.title : null;
  if (!id || !title) return null;
  const artistRow = Array.isArray(value['artist-credit']) ? value['artist-credit'][0] as Record<string, unknown> | undefined : undefined;
  const artistValue = artistRow?.artist as Record<string, unknown> | undefined;
  const artistId = typeof artistValue?.id === 'string' ? artistValue.id : null;
  const artistName = typeof artistRow?.name === 'string' ? artistRow.name : typeof artistValue?.name === 'string' ? artistValue.name : null;
  const releases: CanonicalMusicBrainzRelease[] = [];
  for (const item of Array.isArray(value.releases) ? value.releases : []) {
    if (!item || typeof item !== 'object') continue;
    const release = item as Record<string, unknown>;
    const releaseId = typeof release.id === 'string' ? release.id : null;
    const releaseTitle = typeof release.title === 'string' ? release.title : null;
    if (!releaseId || !releaseTitle) continue;
    const group = release['release-group'] as Record<string, unknown> | undefined;
    const secondary = Array.isArray(group?.['secondary-types']) ? group?.['secondary-types'] : [];
    releases.push({
      id: releaseId,
      releaseGroupId: typeof group?.id === 'string' ? group.id : null,
      title: releaseTitle,
      date: typeof release.date === 'string' && release.date ? release.date : null,
      country: typeof release.country === 'string' && release.country ? release.country : null,
      status: typeof release.status === 'string' && release.status ? release.status : null,
      primaryType: typeof group?.['primary-type'] === 'string' ? group['primary-type'] : null,
      artistCredit: artistCreditText(release['artist-credit']),
      isCompilation: secondary.some((type) => type === 'Compilation'),
    });
  }
  return { id, title, artist: artistId && artistName ? { id: artistId, name: artistName } : null, releases };
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
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new Error(`MusicBrainz search HTTP ${res.status}`);
    return [];
  }
  const body = (await res.json()) as { recordings?: MbRecording[] };
  return Array.isArray(body.recordings) ? body.recordings : [];
}

async function recordingDetail(id: string): Promise<CanonicalMusicBrainzRecording | null> {
  const url = `${MB_API}/recording/${encodeURIComponent(id)}?inc=artists+releases+release-groups&fmt=json`;
  const res = await fetchWithTimeout(url, {
    timeoutMs: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new Error(`MusicBrainz recording HTTP ${res.status}`);
    return null;
  }
  return projectCanonicalRecording(await res.json());
}

function exactRecordingId(recordings: MbRecording[], title: string, artist: string): string | null {
  const wantedTitle = norm(title);
  const wantedArtist = norm(artist);
  for (const recording of recordings) {
    if (!recording.id || (recording.score ?? 0) < MIN_SCORE) continue;
    if (norm(recording.title) !== wantedTitle) continue;
    const names = creditNames(recording).map(norm);
    if (!wantedArtist || names.some((name) => name === wantedArtist)) return recording.id;
  }
  return null;
}

/**
 * Resolve an encountered local file to an exact MusicBrainz recording, then
 * retrieve its release appearances. An existing recording MBID avoids search;
 * a title/artist fallback accepts only an exact high-score candidate.
 */
export async function lookupCanonicalRecording(track: {
  title?: string | null;
  artist?: string | null;
  mbid?: string | null;
}): Promise<CanonicalMusicBrainzRecording | null> {
  const mbid = track.mbid?.trim() ?? '';
  const title = track.title?.trim() ?? '';
  const artist = track.artist?.trim() ?? '';
  if (mbid) return await throttled(() => recordingDetail(mbid));
  if (!title || !artist) return null;
  const attempts: Array<{ title: string; artist: string }> = [{ title, artist }];
  const stripped = stripTitleNoise(title);
  const deDuplicated = dedupeRepeatedArtistCredit(artist);
  if (stripped !== title || deDuplicated !== artist) attempts.push({ title: stripped, artist: deDuplicated });
  for (const attempt of attempts) {
    const candidates = await throttled(() => searchRecordings(`recording:${phrase(attempt.title)} AND artist:${phrase(attempt.artist)}`));
    const id = exactRecordingId(candidates, attempt.title, attempt.artist);
    if (id) return await throttled(() => recordingDetail(id));
  }
  return null;
}

/** Resolve a tagged MusicBrainz release ID to its exact release group. */
export async function lookupReleaseGroupForRelease(releaseId: string): Promise<string | null> {
  const id = releaseId.toLowerCase();
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(id)) return null;
  return throttled(async () => {
    const url = `${MB_API}/release/${encodeURIComponent(id)}?inc=release-groups&fmt=json`;
    const res = await fetchWithTimeout(url, {
      timeoutMs: TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) throw new Error(`MusicBrainz release HTTP ${res.status}`);
      return null;
    }
    const value = await res.json() as Record<string, unknown>;
    if (value.id !== id) return null;
    const group = value['release-group'] as Record<string, unknown> | undefined;
    return typeof group?.id === 'string' ? group.id : null;
  });
}

/** Fetch one allowlisted Series and only its expected membership relations. */
export async function lookupMusicBrainzSeries(
  id: string,
  entityType?: MusicBrainzSeriesEntityType,
): Promise<MusicBrainzSeriesSnapshot | null> {
  return throttled(async () => {
    const relationType = entityType ? entityType === 'recording' ? 'recording-rels' : 'release-group-rels' : 'recording-rels+release-group-rels';
    const url = `${MB_API}/series/${encodeURIComponent(id)}?inc=${relationType}&fmt=json`;
    const res = await fetchWithTimeout(url, {
      timeoutMs: TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) throw new Error(`MusicBrainz Series HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (body.id !== id || typeof body.name !== 'string' || !body.name.trim()) return null;
    const seriesType = typeof body.type === 'string' ? body.type : null;
    if (!entityType) {
      if (/recording/i.test(seriesType ?? '')) entityType = 'recording';
      else if (/release[ -]group/i.test(seriesType ?? '')) entityType = 'release-group';
      else throw new Error('This Series type is not supported. Choose a recording or release-group (album) list.');
    }
    const expectedType = entityType === 'recording' ? /recording/i : /release[ -]group/i;
    if (seriesType && !expectedType.test(seriesType)) return null;
    const rawRelations = Array.isArray(body.relations) ? body.relations : [];
    const members = new Map<string, MusicBrainzSeriesMember>();
    for (const raw of rawRelations) {
      if (!raw || typeof raw !== 'object') continue;
      const relation = raw as Record<string, unknown>;
      // The Series endpoint serializes this target as `release_group`, while
      // other MusicBrainz endpoints use `release-group`.
      const target = entityType === 'recording'
        ? relation.recording
        : relation.release_group ?? relation['release-group'];
      if (!target || typeof target !== 'object') continue;
      const member = target as Record<string, unknown>;
      if (typeof member.id !== 'string' || typeof member.title !== 'string') continue;
      const values = relation['attribute-values'];
      const rawRank = values && typeof values === 'object'
        ? (values as Record<string, unknown>).number
        : null;
      const rank = typeof rawRank === 'number' && Number.isInteger(rawRank) && rawRank > 0
        ? String(rawRank)
        : typeof rawRank === 'string' && /^\d+$/.test(rawRank) && Number(rawRank) > 0
          ? rawRank
          : null;
      const existing = members.get(member.id);
      // MusicBrainz may expose duplicate relations to the same entity. Keep
      // the explicit rank when any relation supplies it.
      if (!existing || (!existing.rank && rank)) members.set(member.id, { id: member.id, title: member.title, rank });
    }
    return {
      id,
      name: body.name,
      type: seriesType,
      members: [...members.values()],
    };
  });
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

/** A local tag can repeat its sole artist as `Artist & Artist`; query it once. */
export function dedupeRepeatedArtistCredit(artist: string): string {
  const parts = artist.split(/\s*&\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length === 2 && norm(parts[0]) === norm(parts[1]) ? parts[0] : artist;
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
