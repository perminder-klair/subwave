// Direct Last.fm tag client (read-only), reusing the api_key configured for
// scrobbling. Vanilla Navidrome's getArtistInfo2 never surfaces the tag[] array,
// so tags via that route always came back empty.
//
// Read methods need only the api_key — no md5 signing or session key (unlike the
// writes in broadcast/scrobble.ts). 5s timeout, [] on any failure, no retry.

import * as subsonic from './subsonic.js';
import { LASTFM_API, resolveLastfmApiKey } from './lastfm-shared.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

const TIMEOUT_MS = 5000;

// artist.getTopTags returns a normalised popularity count (0–100). A 0 means
// nobody applied the tag after normalisation, so drop those; a missing or
// non-numeric count is kept. Last.fm returns them popularity-descending.
const MIN_TAG_COUNT = 1;

// Env wins, then settings.scrobble.lastfm.apiKey. Unlike scrobbling, tag
// fetching does NOT require scrobble.enabled.
function resolveKey(): string {
  return resolveLastfmApiKey();
}

export function hasLastfmKey(): boolean {
  return !!resolveKey();
}

// Tri-state gate shared by the bulk tagger and the single-track retag route:
// explicit `true` always enriches, `false` never does, and the default
// (null/unset) enriches only when a key is present (#532).
export function lastfmEnrichEnabled(cfgValue: unknown, hasKey: boolean): boolean {
  return cfgValue === true || (cfgValue !== false && hasKey);
}

// Crowd tags for an artist, lowercased/trimmed and sliced to `count`
// (default 10). [] on no key, no coverage, or any failure.
export async function getArtistTopTags(
  artist: string,
  opts: { count?: number } = {},
): Promise<string[]> {
  const count = opts.count ?? 10;
  const apiKey = resolveKey();
  if (!apiKey || !artist || !artist.trim()) return [];

  const params = new URLSearchParams({
    method: 'artist.getTopTags',
    artist,
    autocorrect: '1',
    api_key: apiKey,
    format: 'json',
  });

  try {
    const r = await fetchWithTimeout(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      timeoutMs: TIMEOUT_MS,
      bodyDeadline: true,
    });
    if (!r.ok) {
      console.warn(`[lastfm] artist.getTopTags → ${r.status} for "${artist}"`);
      return [];
    }
    const data = (await r.json()) as any;
    // 200 doesn't guarantee success — Last.fm embeds a JSON `error` field.
    if (data?.error) return [];
    const raw = data?.toptags?.tag ?? [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .filter((t: any) => {
        const c = Number(t?.count);
        return !Number.isFinite(c) || c >= MIN_TAG_COUNT;
      })
      .map((t: any) => (typeof t === 'string' ? t : t?.name))
      .filter((s: any): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.toLowerCase().trim())
      .slice(0, count);
  } catch (err: any) {
    console.warn(`[lastfm] artist.getTopTags failed for "${artist}": ${err?.message || err}`);
    return [];
  }
}

// Best-available crowd tags: the direct Last.fm API when a key is configured,
// else Navidrome's getArtistInfo2 (empty on vanilla). [] on any miss/failure.
// The single chokepoint for the bulk tagger and the retag route, so the two
// cannot drift on which source they use (#532).
export async function getArtistTags(
  artist: string,
  opts: { count?: number } = {},
): Promise<string[]> {
  const count = opts.count ?? 10;
  if (!artist || !artist.trim()) return [];
  if (hasLastfmKey()) {
    return getArtistTopTags(artist, { count });
  }
  try {
    const matches = await subsonic.searchArtists(artist, { artistCount: 1 });
    const artistId = matches?.[0]?.id;
    if (!artistId) return [];
    const tags = await subsonic.getArtistLastfmTags(artistId, { count });
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}
