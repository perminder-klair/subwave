import * as settings from '../settings.js';
import { identifyLatestReleaseFromText } from '../llm/dj.js';
import { isWebSearchProviderError, searchReady, searchWeb } from '../skills/web-search.js';
import {
  requestArtistMatches,
  requestName,
  type LatestReleaseEvidence,
  type LatestReleaseKind,
  type LatestReleaseLookup,
} from './request-match.js';
import { lookupLatestReleaseGroup } from './musicbrainz.js';

const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_KEYS = 128;
const LOOKUP_TIMEOUT_MS = 12_000;

type Cached = { value: LatestReleaseLookup; expiresAt: number };
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<LatestReleaseLookup>>();

function cacheKey(artist: string, kind: LatestReleaseKind): string {
  const search = settings.get().search;
  return JSON.stringify({
    artist: requestName(artist),
    kind,
    provider: search?.provider || 'duckduckgo',
    baseUrl: String(search?.baseUrl || '').trim().replace(/\/+$/u, ''),
  });
}

function remember(key: string, value: LatestReleaseLookup): void {
  if (cache.size >= CACHE_MAX_KEYS && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, {
    value,
    expiresAt: Date.now() + (value.status === 'verified' ? SUCCESS_TTL_MS : MISS_TTL_MS),
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('latest release lookup aborted');
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function dateIsNotFuture(value: string): boolean {
  const match = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2] || 12);
  const day = Number(match[3] || 31);
  const candidate = Date.UTC(year, month - 1, day);
  return Number.isFinite(candidate) && candidate <= Date.now();
}

function normalizedEvidence(value: string): string {
  return requestName(value).replace(/\s+/gu, ' ').trim();
}

function urlHost(value: string | undefined): string | null {
  if (!value) return null;
  try { return new URL(value).hostname.toLocaleLowerCase(); } catch { return null; }
}

async function webLatestRelease(
  artist: string,
  kind: LatestReleaseKind,
  signal: AbortSignal,
): Promise<LatestReleaseLookup> {
  if (!searchReady()) return { status: 'unavailable', reason: 'no-evidence' };
  const provider = settings.get().search?.provider || 'duckduckgo';
  const query = `"${artist}" latest official ${kind === 'album' ? 'studio album' : 'single'} release date`;
  try {
    const web = await searchWeb(query, { signal });
    const results = (web.results || []).filter(result => result.url);
    const domains = new Set(results.map(result => urlHost(result.url)).filter((host): host is string => !!host));
    if (domains.size < 2) return { status: 'unavailable', reason: 'ambiguous', provider };

    const evidence = [web.answer, ...results.map(result => `${result.title}: ${result.content}`)]
      .filter(Boolean).join('\n').slice(0, 10_000);
    const identified = await identifyLatestReleaseFromText(query, evidence, kind, signal);
    if (!identified || !dateIsNotFuture(identified.releaseDate)) {
      return { status: 'unavailable', reason: 'ambiguous', provider };
    }
    if (!requestArtistMatches(artist, { id: 'external', artist: identified.artist })) {
      return { status: 'unavailable', reason: 'ambiguous', provider };
    }
    const artistKey = normalizedEvidence(identified.artist);
    const titleKey = normalizedEvidence(identified.title);
    const year = identified.releaseDate.slice(0, 4);
    const supporting = results.filter(result => {
      const row = normalizedEvidence(`${result.title} ${result.content}`);
      return row.includes(artistKey) && row.includes(titleKey) && row.includes(year);
    });
    const supportingDomains = new Set<string>();
    for (const result of supporting) {
      const host = urlHost(result.url);
      if (host) supportingDomains.add(host);
    }
    if (supportingDomains.size < 2) return { status: 'unavailable', reason: 'ambiguous', provider };
    const release: LatestReleaseEvidence = {
      kind,
      title: identified.title,
      artist: identified.artist,
      releaseDate: identified.releaseDate,
      source: provider,
      sourceUrls: supporting.map(result => result.url!).slice(0, 3),
    };
    return { status: 'verified', release };
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      status: 'unavailable',
      reason: isWebSearchProviderError(error) ? 'provider-error' : 'ambiguous',
      ...(isWebSearchProviderError(error) ? { provider: error.provider } : { provider }),
    };
  }
}

async function lookupUncached(
  artist: string,
  kind: LatestReleaseKind,
  signal?: AbortSignal,
): Promise<LatestReleaseLookup> {
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const musicbrainz = await lookupLatestReleaseGroup(artist, kind, bounded);
    if (musicbrainz) {
      return { status: 'verified', release: { ...musicbrainz, kind } };
    }
    return await webLatestRelease(artist, kind, bounded);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 'unavailable', reason: 'provider-error' };
  }
}

export async function lookupLatestRelease(
  artist: string,
  kind: LatestReleaseKind,
  signal?: AbortSignal,
): Promise<LatestReleaseLookup> {
  throwIfAborted(signal);
  const key = cacheKey(artist, kind);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (hit) cache.delete(key);
  let request = inflight.get(key);
  if (!request) {
    // Keep the coalesced provider lookup independent of one caller's abort.
    // The route can cancel its own wait without cancelling another Alexa or
    // browser request sharing the same artist lookup.
    request = lookupUncached(artist, kind).then(value => {
      remember(key, value);
      return value;
    }).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
  }
  return awaitWithAbort(request, signal);
}
