// Provider-independent Last.fm enrichment.
//
// The embedding tagger wants crowd tags (and, downstream, similar artists/tracks)
// to make "similar"/mood embeddings richer. Historically these came THROUGH the
// music provider — Navidrome's getArtistInfo2 surfaces Last.fm tags, but vanilla
// Navidrome and every non-Subsonic source (Jamendo, Jellyfin, local) don't. This
// module talks to the Last.fm API directly, keyed by ARTIST NAME, so enrichment
// works for every source.
//
// Read-only calls need only an `api_key` (no session/signature) — reuse the key
// already collected for scrobbling (settings.scrobble.lastfm.apiKey /
// LASTFM_API_KEY). No key → every method returns empty (a clean no-op), so the
// tagger just falls back to metadata-only embeddings.

import * as settings from '../../settings.js';

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

// Shared with the scrobble client's resolution (broadcast/scrobble.ts): env wins,
// then the persisted settings key.
export function lastfmApiKey(): string {
  return process.env.LASTFM_API_KEY || (settings.get() as any)?.scrobble?.lastfm?.apiKey || '';
}

export function isAvailable(): boolean {
  return !!lastfmApiKey();
}

// One GET against the Last.fm 2.0 API. Returns the parsed JSON, or null on any
// failure (no key, network, API error) so callers degrade to empty cleanly.
async function lfm(method: string, params: Record<string, string | number>): Promise<any | null> {
  const apiKey = lastfmApiKey();
  if (!apiKey) return null;
  const url = new URL(LASTFM_API);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('autocorrect', '1');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.error) return null; // Last.fm signals errors in the body with a 200
    return data;
  } catch {
    return null;
  }
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Crowd tags for an artist, normalised to lowercase trimmed strings, most-used
// first. Empty when the artist has no Last.fm coverage or no key is set.
export async function getArtistTags(artist: string, { count = 10 } = {}): Promise<string[]> {
  if (!artist) return [];
  const data = await lfm('artist.gettoptags', { artist });
  const tags = asArray<any>(data?.toptags?.tag);
  return tags
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.toLowerCase().trim())
    .slice(0, count);
}

// Similar artist names — for the picker's similar-artist surface on sources whose
// own artist graph is thin/absent.
export async function getSimilarArtists(artist: string, { limit = 10 } = {}): Promise<string[]> {
  if (!artist) return [];
  const data = await lfm('artist.getsimilar', { artist, limit });
  const arr = asArray<any>(data?.similarartists?.artist);
  return arr
    .map((a) => a?.name)
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

// Similar tracks as {artist, title} — the seed for a generative "find me one of
// these in the active source" similar, independent of the provider's own graph.
export async function getSimilarTracks(
  artist: string,
  title: string,
  { limit = 20 } = {},
): Promise<Array<{ artist: string; title: string }>> {
  if (!artist || !title) return [];
  const data = await lfm('track.getsimilar', { artist, track: title, limit });
  const arr = asArray<any>(data?.similartracks?.track);
  return arr
    .map((t) => ({ artist: t?.artist?.name || '', title: t?.name || '' }))
    .filter((t) => t.artist && t.title);
}
