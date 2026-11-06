// Deterministic soundtrack discovery for listener requests.
//
// This module is deliberately model-free. MusicBrainz provides the primary
// structured soundtrack evidence; Last.fm is optional corroboration when the
// existing scrobbling API key is available. Neither provider can create a
// local track id. A candidate is returned only after its title and artist
// evidence match a row already present in the local library.

import { fetchWithTimeout } from '../util/fetch-timeout.js';
import { requestName, requestNameVariants } from './request-normalize.js';
import { LASTFM_API, resolveLastfmApiKey } from './lastfm-shared.js';
import type { RequestSong } from './request-match.js';

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const MUSICBRAINZ_USER_AGENT = 'subwave/1.0 ( https://github.com/perminder-klair/subwave )';
const MUSICBRAINZ_GAP_MS = 1100;
const MUSICBRAINZ_TIMEOUT_MS = 8000;
const LASTFM_TIMEOUT_MS = 5000;
// The MusicBrainz gate is shared by all listeners. The old 12-second wall
// clock started before a request reached that gate, so a short burst of movie
// requests timed out while merely waiting for the provider's rate limit. Keep
// the provider budget below the route's 60-second request deadline and let
// the gate wait be cancellable.
const LOOKUP_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_KEYS = 128;
const MAX_RELEASE_GROUPS = 3;
const MAX_TRACKS = 200;

export interface SoundtrackRequestContext {
  name: string;
  kind: 'movie' | 'film' | 'soundtrack' | 'unknown';
  explicit: boolean;
  title?: string | null;
}

export interface SoundtrackEvidenceTrack {
  title: string;
  artists: string[];
  order: number;
  source: 'musicbrainz' | 'lastfm' | 'both';
}

export interface SoundtrackProviderTracklist {
  source: 'musicbrainz' | 'lastfm';
  releaseName: string;
  tracks: SoundtrackEvidenceTrack[];
}

export interface SoundtrackProvider {
  musicbrainz(context: SoundtrackRequestContext, signal?: AbortSignal): Promise<SoundtrackProviderTracklist[]>;
  lastfm?(context: SoundtrackRequestContext, releases: string[], signal?: AbortSignal): Promise<SoundtrackProviderTracklist[]>;
}

export interface SoundtrackLocalCandidate {
  id: string;
  title?: string | null;
  artist?: string | null;
  artists?: Array<string | { name?: string }>;
  [key: string]: unknown;
}

export interface SoundtrackCandidate extends RequestSong {
  soundtrackConfidence: number;
  soundtrackSource: 'musicbrainz' | 'musicbrainz+lastfm' | 'lastfm';
  soundtrackOrder: number;
}

export type SoundtrackResolution =
  | { status: 'matched'; candidates: SoundtrackCandidate[]; source: 'musicbrainz' | 'musicbrainz+lastfm' | 'lastfm' }
  | { status: 'disabled'; reason: 'network-disabled' }
  | { status: 'no-match'; reason: 'no-soundtrack' | 'no-local-match' | 'ambiguous' }
  | { status: 'provider-error'; provider: 'musicbrainz' | 'lastfm'; reason: string }
  | { status: 'timeout'; provider?: 'musicbrainz' | 'lastfm' };

interface CachedResolution {
  value: SoundtrackResolution;
  expiresAt: number;
}

const cache = new Map<string, CachedResolution>();
const inflight = new Map<string, Promise<SoundtrackResolution>>();

let musicbrainzGate: Promise<void> = Promise.resolve();
let lastMusicbrainzStart = 0;

function musicbrainzThrottled<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = musicbrainzGate.then(async () => {
    throwIfAborted(signal);
    const wait = lastMusicbrainzStart + MUSICBRAINZ_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    throwIfAborted(signal);
    lastMusicbrainzStart = Date.now();
    return fn();
  });
  musicbrainzGate = run.then(() => undefined, () => undefined);
  return run;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

function mbPhrase(value: string): string {
  return `"${value.replace(/[\\"]/gu, '\\$&')}"`;
}

function titleKey(value: unknown): string {
  return requestName(value);
}

function titleFold(value: unknown): string {
  return titleKey(value)
    .split(' ')
    .filter(token => !['a', 'an', 'the'].includes(token))
    .join(' ');
}

function numericTokens(value: string): string[] {
  return value.split(' ').filter(token => /\d|^[ivxlcdm]+$/iu.test(token));
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = row[j]!;
      row[j] = left[i - 1] === right[j - 1]
        ? diagonal
        : Math.min(diagonal + 1, above + 1, row[j - 1]! + 1);
      diagonal = above;
    }
  }
  return row[right.length]!;
}

function titleSimilarity(left: string, right: string): number {
  const variantsLeft = requestNameVariants(left);
  const variantsRight = requestNameVariants(right);
  let best = 0;
  for (const a of variantsLeft) {
    for (const b of variantsRight) {
      const aNumbers = numericTokens(a);
      const bNumbers = numericTokens(b);
      if (aNumbers.length !== bNumbers.length || aNumbers.some((token, index) => token !== bNumbers[index])) continue;
      if (a === b) best = Math.max(best, 1);
      const af = titleFold(a);
      const bf = titleFold(b);
      if (af && af === bf) best = Math.max(best, 0.97);
      const distance = editDistance(af, bf);
      const scale = Math.max(af.length, bf.length);
      if (scale > 0) best = Math.max(best, 1 - distance / scale);
    }
  }
  return best;
}

function artistVariants(value: unknown): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  const values = [raw, ...raw.split(/\s+\/\s+|\b(?:feat(?:uring)?|ft)\.?\s+/iu)];
  return values.flatMap(part => requestNameVariants(part))
    .map(part => part.replace(/^the (?=\S)/u, '').trim())
    .filter(Boolean);
}

// MusicBrainz exposes each credited artist separately, while Navidrome may
// serialize the same credit as one display string. The display separator is
// not identity data: it varies by tagger, server version, and source format.
//
// Compare canonical name spans in a token stream instead. This accepts any
// punctuation or join marker between real credits without maintaining a list
// of delimiters. It also keeps the important safety rule: a local row can omit
// provider-only featured credits, but every non-connector identity token in
// the local row must be covered by a provider credit. For example, provider
// credit "Fire" cannot verify local "Earth, Wind & Fire" because "earth" and
// "wind" remain uncovered.
const SOUNDTRACK_CONNECTORS = new Set(['and', 'feat', 'featuring', 'ft', 'with']);

function soundtrackCreditTokens(value: unknown): string[] {
  const normalized = requestName(value).replace(/^the (?=\S)/u, '').trim();
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

function soundtrackCreditSet(values: readonly unknown[]): string[] {
  return [...new Set(values.map(value => soundtrackCreditTokens(value).join(' ')).filter(Boolean))].sort();
}

function coversProviderCredit(localTokens: string[], wantedTokens: string[][]): boolean {
  if (!localTokens.length || !wantedTokens.length) return false;
  const occupied = new Array<boolean>(localTokens.length).fill(false);
  let covered = false;

  // Match longer names first so a short artist name cannot consume the start
  // of a longer credited name and leave a false remainder.
  for (const wanted of [...wantedTokens].sort((a, b) => b.length - a.length || a.join(' ').localeCompare(b.join(' ')))) {
    if (!wanted.length) continue;
    for (let start = 0; start <= localTokens.length - wanted.length; start++) {
      if (wanted.some((token, offset) => occupied[start + offset] || localTokens[start + offset] !== token)) continue;
      for (let offset = 0; offset < wanted.length; offset++) occupied[start + offset] = true;
      covered = true;
      break;
    }
  }
  if (!covered) return false;
  return localTokens.every((token, index) => occupied[index] || SOUNDTRACK_CONNECTORS.has(token));
}

function artistsMatch(wanted: readonly string[], local: SoundtrackLocalCandidate): boolean {
  const wantedKeys = soundtrackCreditSet(wanted);
  const wantedTokens = wantedKeys.map(value => value.split(' '));
  const localDisplay = local.artist
    || (local.artists || []).map(artist => typeof artist === 'string' ? artist : artist?.name).filter(Boolean).join(' ');
  // A local tag can omit featured credits that the provider knows about. It
  // must not invent a credit absent from the provider, and an empty or wholly
  // unrelated local credit must never pass on title evidence alone.
  return coversProviderCredit(soundtrackCreditTokens(localDisplay), wantedTokens);
}

function sourceKey(track: Pick<SoundtrackEvidenceTrack, 'title' | 'artists'>): string {
  return `${titleFold(track.title)}|${track.artists.flatMap(artistVariants).sort().join('|')}`;
}

function mergeTracklists(
  primary: SoundtrackProviderTracklist[],
  secondary: SoundtrackProviderTracklist[],
  allowStandaloneSecondary = false,
): SoundtrackEvidenceTrack[] {
  const out = new Map<string, SoundtrackEvidenceTrack>();
  for (const tracklist of primary) {
    for (const track of tracklist.tracks.slice(0, MAX_TRACKS)) {
      const key = sourceKey(track);
      if (!key || !track.title || !track.artists.length) continue;
      out.set(key, { ...track, source: 'musicbrainz' });
    }
  }
  for (const tracklist of secondary) {
    for (const track of tracklist.tracks.slice(0, MAX_TRACKS)) {
      const key = sourceKey(track);
      if (!key || !track.title || !track.artists.length) continue;
      const existing = out.get(key);
      if (existing) {
        existing.source = 'both';
        continue;
      }
      // Last.fm is normally corroboration. It may be the recovery authority
      // only when the primary provider was unavailable and the local row also
      // proves that it belongs to the named release.
      if (allowStandaloneSecondary) out.set(key, { ...track, source: 'lastfm' });
    }
  }
  return [...out.values()];
}

function matchLocal(
  context: SoundtrackRequestContext,
  evidence: SoundtrackEvidenceTrack[],
  local: SoundtrackLocalCandidate[],
  allowStandaloneSecondary = false,
): SoundtrackCandidate[] {
  const rows: Array<SoundtrackCandidate & { confidence: number }> = [];
  for (const external of evidence) {
    if (context.title && titleSimilarity(context.title, external.title) < 0.88) continue;
    const artistList = external.artists;
    const matches = local
      .filter(row => row.id && row.title && titleSimilarity(external.title, row.title) >= 0.88)
      .filter(row => !allowStandaloneSecondary || external.source !== 'lastfm'
        || (row['album'] && titleSimilarity(context.name, String(row['album'])) >= 0.92))
      .filter(row => artistsMatch(artistList, row))
      .map(row => {
        const titleScore = titleSimilarity(external.title, row.title || '');
        const sourceScore = external.source === 'both' ? 0.08 : 0;
        return {
          ...row,
          title: row.title ?? undefined,
          artist: row.artist ?? undefined,
          soundtrackConfidence: Math.min(1, titleScore * 0.92 + sourceScore),
          soundtrackSource: external.source === 'both' ? 'musicbrainz+lastfm' as const
            : external.source === 'lastfm' ? 'lastfm' as const : 'musicbrainz' as const,
          soundtrackOrder: external.order,
          confidence: titleScore * 0.92 + sourceScore,
        };
      })
      .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
    const best = matches[0];
    if (!best) continue;
    const tied = matches[1] && Math.abs(best.confidence - matches[1].confidence) < 0.04;
    if (tied) continue;
    rows.push(best);
  }
  const byId = new Map<string, SoundtrackCandidate>();
  for (const row of rows) {
    const previous = byId.get(row.id);
    if (!previous || row.soundtrackConfidence > previous.soundtrackConfidence
      || (row.soundtrackConfidence === previous.soundtrackConfidence && row.soundtrackOrder < previous.soundtrackOrder)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => b.soundtrackConfidence - a.soundtrackConfidence
    || a.soundtrackOrder - b.soundtrackOrder
    || a.id.localeCompare(b.id));
}

function cacheKey(context: SoundtrackRequestContext): string {
  return JSON.stringify({
    name: requestName(context.name),
    kind: context.kind,
    explicit: context.explicit,
    title: requestName(context.title),
    lastfm: Boolean(resolveLastfmApiKey()),
  });
}

function remember(key: string, value: SoundtrackResolution): void {
  if (cache.size >= CACHE_MAX_KEYS && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expiresAt: Date.now() + (value.status === 'matched' ? CACHE_TTL_MS : MISS_TTL_MS) });
}

function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

interface MbGroup {
  id?: string;
  title?: string;
  score?: number;
  'secondary-types'?: string[];
  releases?: MbRelease[];
}

interface MbRelease {
  id?: string;
  title?: string;
  status?: string;
  date?: string;
  'track-count'?: number;
}

interface MbTrack {
  position?: number;
  title?: string;
  recording?: { title?: string; 'artist-credit'?: MbCredit[] };
  'artist-credit'?: MbCredit[];
}

interface MbCredit {
  name?: string;
  artist?: { name?: string };
}

interface MbReleasePayload {
  title?: string;
  media?: Array<{ tracks?: MbTrack[] }>;
}

function creditNames(credits: MbCredit[] | undefined): string[] {
  return (credits || []).flatMap(credit => [credit.name, credit.artist?.name]).filter((value): value is string => !!value?.trim());
}

function groupTitleScore(name: string, group: MbGroup): number {
  const title = String(group.title || '');
  const score = titleSimilarity(name, title);
  const soundtrack = (group['secondary-types'] || []).some(type => requestName(type) === 'soundtrack');
  return score + (soundtrack ? 0.1 : 0);
}

async function mbFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  return musicbrainzThrottled(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await jsonResponse<T>(await fetchWithTimeout(`${MUSICBRAINZ_API}${path}`, {
          timeoutMs: MUSICBRAINZ_TIMEOUT_MS,
          signal,
          headers: { 'User-Agent': MUSICBRAINZ_USER_AGENT, Accept: 'application/json' },
        }));
      } catch (error) {
        lastError = error;
        if (!/HTTP (?:429|502|503|504)\b/iu.test(error instanceof Error ? error.message : String(error)) || attempt === 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }, signal);
}

async function musicbrainzTracklists(context: SoundtrackRequestContext, signal?: AbortSignal): Promise<SoundtrackProviderTracklist[]> {
  // `releasegroup` is the indexed field for this endpoint. The similarly
  // named `release` field can make MusicBrainz return a 503 on release-group
  // searches and misses soundtrack groups that have several editions.
  const names = [...new Set([
    context.name,
    // MusicBrainz treats punctuation as significant in an exact phrase. A
    // listener commonly says "Ra One" while the release group is stored as
    // "Ra.One", so try the compact punctuation form before the existing
    // sequel/roman-numeral variants. This is a bounded spelling variant, not
    // a title-specific fallback.
    context.name.replace(/[\s._-]+/gu, '.'),
    context.name.replace(/(?<=[\p{L}])(?=\d)/gu, ' '),
    context.name.replace(/\b(?:ii|iii|iv)\b/iu, value => ({ ii: '2', iii: '3', iv: '4' }[value.toLocaleLowerCase()] || value)),
  ].map(value => value.trim()).filter(Boolean))].slice(0, 4);
  const groupsById = new Map<string, MbGroup>();
  for (const name of names) {
    const query = `releasegroup:${mbPhrase(name)} AND type:soundtrack`;
    const body = await mbFetch<{ 'release-groups'?: MbGroup[] }>(`/release-group/?query=${encodeURIComponent(query)}&fmt=json&limit=10`, signal);
    for (const group of body['release-groups'] || []) if (group.id) groupsById.set(group.id, group);
    if (groupsById.size) break;
  }
  const groups = [...groupsById.values()]
    .filter(group => group.id && (group.score || 0) >= 70)
    .filter(group => (group['secondary-types'] || []).some(type => requestName(type) === 'soundtrack'))
    .sort((a, b) => groupTitleScore(context.name, b) - groupTitleScore(context.name, a)
      || (b.score || 0) - (a.score || 0)
      || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_RELEASE_GROUPS);
  const out: SoundtrackProviderTracklist[] = [];
  for (const group of groups) {
    throwIfAborted(signal);
    const groupBody = await mbFetch<{ releases?: MbRelease[] }>(`/release-group/${group.id}?inc=releases&fmt=json`, signal);
    const release = (groupBody.releases || [])
      .filter(candidate => candidate.id && String(candidate.status || '').toLocaleLowerCase() === 'official')
      .sort((a, b) => (b['track-count'] || 0) - (a['track-count'] || 0)
        || String(a.date || '').localeCompare(String(b.date || ''))
        || String(a.id).localeCompare(String(b.id)))[0];
    if (!release?.id) continue;
    const detail = await mbFetch<MbReleasePayload>(`/release/${release.id}?inc=media+recordings+artist-credits&fmt=json`, signal);
    const tracks = (detail.media || []).flatMap(media => media.tracks || []).map((track, index) => {
      const recording = track.recording;
      return {
        title: String(recording?.title || track.title || '').trim(),
        artists: creditNames(recording?.['artist-credit'] || track['artist-credit']),
        order: Number(track.position || index + 1),
        source: 'musicbrainz' as const,
      };
    }).filter(track => track.title && track.artists.length);
    if (tracks.length) out.push({ source: 'musicbrainz', releaseName: String(detail.title || release.title || group.title || context.name), tracks });
  }
  return out;
}

interface LastfmTrack {
  name?: string;
  artist?: { name?: string };
}

async function lastfmTracklists(_context: SoundtrackRequestContext, releases: string[], signal?: AbortSignal): Promise<SoundtrackProviderTracklist[]> {
  const apiKey = resolveLastfmApiKey();
  if (!apiKey) return [];
  const out: SoundtrackProviderTracklist[] = [];
  for (const release of releases.slice(0, MAX_RELEASE_GROUPS)) {
    const params = new URLSearchParams({
      method: 'album.getinfo',
      artist: 'Various Artists',
      album: release,
      autocorrect: '1',
      api_key: apiKey,
      format: 'json',
    });
    const response = await fetchWithTimeout(`${LASTFM_API}?${params}`, {
      timeoutMs: LASTFM_TIMEOUT_MS,
      signal,
      headers: { 'User-Agent': 'sub-wave/request-soundtrack' },
    });
    const body = await jsonResponse<{ album?: { name?: string; tracks?: { track?: LastfmTrack | LastfmTrack[] } } }>(response);
    const raw = body.album?.tracks?.track || [];
    const rows = Array.isArray(raw) ? raw : [raw];
    const tracks = rows.map((track, index) => ({
      title: String(track.name || '').trim(),
      artists: [String(track.artist?.name || '').trim()].filter(Boolean),
      order: index + 1,
      source: 'lastfm' as const,
    })).filter(track => track.title && track.artists.length);
    if (tracks.length) out.push({ source: 'lastfm', releaseName: String(body.album?.name || release), tracks });
  }
  return out;
}

const productionProvider: SoundtrackProvider = {
  musicbrainz: musicbrainzTracklists,
  lastfm: lastfmTracklists,
};

async function lookupUncached(
  context: SoundtrackRequestContext,
  local: SoundtrackLocalCandidate[],
  provider: SoundtrackProvider,
  signal?: AbortSignal,
): Promise<SoundtrackResolution> {
  const deadline = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let primary: SoundtrackProviderTracklist[] = [];
  let primaryFailure: SoundtrackResolution | null = null;
  try {
    primary = await provider.musicbrainz(context, bounded);
  } catch (error) {
    if (signal?.aborted) throw error;
    primaryFailure = bounded.aborted
      ? { status: 'timeout', provider: 'musicbrainz' }
      : { status: 'provider-error', provider: 'musicbrainz', reason: error instanceof Error ? error.message : String(error) };
  }
  const canUseLastfm = provider.lastfm && (provider !== productionProvider || resolveLastfmApiKey());
  if (!primary.length && canUseLastfm) {
    // Recovery gets its own short budget. A MusicBrainz failure must not
    // consume the entire remaining route deadline before Last.fm is tried.
    const fallbackDeadline = AbortSignal.timeout(LASTFM_TIMEOUT_MS + 3000);
    const fallbackSignal = signal ? AbortSignal.any([signal, fallbackDeadline]) : fallbackDeadline;
    try {
      const secondary = await provider.lastfm!(context, [context.name], fallbackSignal);
      const fallbackEvidence = mergeTracklists([], secondary, true);
      const fallbackCandidates = matchLocal(context, fallbackEvidence, local, true);
      if (fallbackCandidates.length) return { status: 'matched', candidates: fallbackCandidates, source: 'lastfm' };
    } catch (error) {
      if (signal?.aborted) throw error;
      // Preserve the primary failure below. A Last.fm failure is not a reason
      // to invent a local match or hide the provider diagnostic.
    }
  }
  if (!primary.length) return primaryFailure || { status: 'no-match', reason: 'no-soundtrack' };
  let secondary: SoundtrackProviderTracklist[] = [];
  // Production Last.fm calls require the configured key. Injected providers
  // may still exercise corroboration in unit tests without mutating process
  // credentials or the operator's settings.
  if (provider.lastfm && (provider !== productionProvider || resolveLastfmApiKey())) {
    try {
      const secondaryDeadline = AbortSignal.timeout(LASTFM_TIMEOUT_MS + 1000);
      const secondarySignal = signal ? AbortSignal.any([signal, secondaryDeadline]) : secondaryDeadline;
      secondary = await provider.lastfm(context, primary.map(list => list.releaseName), secondarySignal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // Last.fm is optional corroboration. If its bounded call expires after
      // MusicBrainz already supplied evidence, keep the primary tracklist and
      // let local title/artist verification decide. An abort from the caller
      // still propagates above.
      // Last.fm is corroboration. A failure must not discard strong primary
      // evidence, but it is retained in diagnostics by the caller's lookup log.
      secondary = [];
    }
  }
  const evidence = mergeTracklists(primary, secondary);
  const candidates = matchLocal(context, evidence, local);
  return candidates.length
    ? { status: 'matched', candidates, source: evidence.some(track => track.source === 'both') ? 'musicbrainz+lastfm' : 'musicbrainz' }
    : { status: 'no-match', reason: 'no-local-match' };
}

export async function resolveSoundtrackCandidates(
  context: SoundtrackRequestContext,
  local: SoundtrackLocalCandidate[],
  options: { enabled?: boolean; signal?: AbortSignal; provider?: SoundtrackProvider } = {},
): Promise<SoundtrackResolution> {
  if (!options.enabled) return { status: 'disabled', reason: 'network-disabled' };
  throwIfAborted(options.signal);
  const key = cacheKey(context);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    if (hit.value.status !== 'matched') return hit.value;
    const localById = new Map(local.filter(row => row.id).map(row => [row.id, row]));
    const candidates = hit.value.candidates.flatMap(candidate => {
      const current = localById.get(candidate.id);
      if (!current || !current.title || !candidate.title || titleSimilarity(candidate.title, current.title) < 0.88) return [];
      return [{
        ...current,
        title: current.title,
        artist: current.artist ?? undefined,
        soundtrackConfidence: candidate.soundtrackConfidence,
        soundtrackSource: candidate.soundtrackSource,
        soundtrackOrder: candidate.soundtrackOrder,
      }];
    });
    return candidates.length ? { ...hit.value, candidates } : { status: 'no-match', reason: 'no-local-match' };
  }
  if (hit) cache.delete(key);
  let request = inflight.get(key);
  if (!request) {
    request = lookupUncached(context, local, options.provider || productionProvider).then(value => {
      remember(key, value);
      return value;
    }).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
  }
  return request;
}

export function clearSoundtrackResolutionCache(): void {
  cache.clear();
  inflight.clear();
}
