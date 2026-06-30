// Direct Last.fm tag client (read-only).
//
// Library tag enrichment wants Last.fm's crowd tags for an artist. The older
// path went *through* Navidrome (subsonic.getArtistLastfmTags → getArtistInfo2),
// but vanilla Navidrome's agent only surfaces bio + images there, never the
// tag[] array — so tags always came back empty. This module skips Navidrome and
// hits the Last.fm REST API directly, reusing the api_key the operator already
// configured for scrobbling (LASTFM_API_KEY / settings.scrobble.lastfm.apiKey).
//
// Read methods (artist.getTopTags) are unauthenticated beyond the api_key — no
// md5 signing, no session key (unlike the write calls in broadcast/scrobble.ts).
// Every call is fire-and-forget with a 5s timeout and returns [] on any failure
// so the caller can fall back; no retry (project convention — Last.fm's read
// API is generous and the tagger loop is already sequential + per-artist cached).

import * as settings from '../settings.js';
import { getSource } from './source/index.js';

const TIMEOUT_MS = 5000;
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

// artist.getTopTags returns a normalised popularity `count` (0–100, top tag at
// 100). A count of 0 means essentially nobody applied the tag after
// normalisation — pure noise — so drop those. Anything with a positive (or
// missing/non-numeric) count is kept; the slice to `count` handles ordering,
// since Last.fm returns tags sorted by popularity descending.
const MIN_TAG_COUNT = 1;

// Resolve the Last.fm api_key. Env wins, then settings.scrobble.lastfm.apiKey.
// Note: unlike scrobbling, tag fetching does NOT require scrobble.enabled — the
// key alone is enough to read public tags.
function resolveKey(): string {
  const s: any = settings.get()?.scrobble?.lastfm || {};
  return process.env.LASTFM_API_KEY || s.apiKey || '';
}

export function hasLastfmKey(): boolean {
  return !!resolveKey();
}

// Tri-state gate for whether to fetch Last.fm tags during enrichment, shared by
// the bulk tagger (tag-library.phaseEnrich) and the single-track retag route so
// they can't drift: explicit `true` always enriches; explicit `false` never
// does; the default (null/undefined/unset) enriches only when a key is present.
// A strict `=== true` here is what made retag skip enrichment for a
// key-present-but-toggle-unset operator while the bulk path still ran it (#532).
export function lastfmEnrichEnabled(cfgValue: unknown, hasKey: boolean): boolean {
  return cfgValue === true || (cfgValue !== false && hasKey);
}

// Last.fm crowd tags for an artist, normalised to lowercase trimmed strings and
// sliced to `count` (default 10, matching the legacy Navidrome path). Returns []
// when no key is configured, the artist has no Last.fm coverage, or any request
// failure — the caller treats [] as "no tags" and may fall back.
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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[lastfm] artist.getTopTags → ${r.status} for "${artist}"`);
      return [];
    }
    const data = (await r.json()) as any;
    // 200 doesn't guarantee success — Last.fm embeds a JSON `error` field
    // (e.g. error 6 "no such artist" for obscure releases). Treat as no tags.
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
  } finally {
    clearTimeout(timer);
  }
}

// Similar artists for a given artist from Last.fm. Returns up to `count`
// (default 10) artist name strings. Returns [] on missing key, no coverage, or
// any request failure — same fire-and-forget contract as getArtistTopTags.
export async function getSimilarArtists(
  artist: string,
  opts: { count?: number } = {},
): Promise<string[]> {
  const count = opts.count ?? 10;
  const apiKey = resolveKey();
  if (!apiKey || !artist || !artist.trim()) return [];

  const params = new URLSearchParams({
    method: 'artist.getSimilar',
    artist,
    limit: String(count),
    api_key: apiKey,
    format: 'json',
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[lastfm] artist.getSimilar → ${r.status} for "${artist}"`);
      return [];
    }
    const data = (await r.json()) as any;
    if (data?.error) return [];
    const raw = data?.similarartists?.artist ?? [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .map((a: any) => (typeof a === 'string' ? a : a?.name))
      .filter((s: any): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.trim())
      .slice(0, count);
  } catch (err: any) {
    console.warn(`[lastfm] artist.getSimilar failed for "${artist}": ${err?.message || err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Top tracks for an artist from Last.fm. Returns up to `count` (default 10)
// objects with { title, artist }. Returns [] on missing key, no coverage, or
// any request failure.
export async function getTopTracks(
  artist: string,
  opts: { count?: number } = {},
): Promise<{ title: string; artist: string }[]> {
  const count = opts.count ?? 10;
  const apiKey = resolveKey();
  if (!apiKey || !artist || !artist.trim()) return [];

  const params = new URLSearchParams({
    method: 'artist.getTopTracks',
    artist,
    limit: String(count),
    api_key: apiKey,
    format: 'json',
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[lastfm] artist.getTopTracks → ${r.status} for "${artist}"`);
      return [];
    }
    const data = (await r.json()) as any;
    if (data?.error) return [];
    const raw = data?.toptracks?.track ?? [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
      .map((t: any) => ({ title: String(t?.name || '').trim(), artist }))
      .filter((t: { title: string; artist: string }) => t.title.length > 0)
      .slice(0, count);
  } catch (err: any) {
    console.warn(`[lastfm] artist.getTopTracks failed for "${artist}": ${err?.message || err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Bio and genre tags for an artist from Last.fm. Returns null on missing key,
// no coverage, or any request failure. Bio HTML is stripped to plain text.
export async function getArtistInfo(
  artist: string,
): Promise<{ bio?: string; tags?: string[] } | null> {
  const apiKey = resolveKey();
  if (!apiKey || !artist || !artist.trim()) return null;

  const params = new URLSearchParams({
    method: 'artist.getInfo',
    artist,
    autocorrect: '1',
    api_key: apiKey,
    format: 'json',
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.warn(`[lastfm] artist.getInfo → ${r.status} for "${artist}"`);
      return null;
    }
    const data = (await r.json()) as any;
    if (data?.error) return null;
    const a = data?.artist;
    if (!a) return null;
    const bio = String(a?.bio?.summary || '')
      .replace(/<[^>]*>/g, '')
      .trim() || undefined;
    const rawTags = a?.tags?.tag ?? [];
    const tagsArr = Array.isArray(rawTags) ? rawTags : [rawTags];
    const tags = tagsArr
      .map((t: any) => (typeof t === 'string' ? t : t?.name))
      .filter((s: any): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s: string) => s.toLowerCase().trim());
    return { bio, tags: tags.length > 0 ? tags : undefined };
  } catch (err: any) {
    console.warn(`[lastfm] artist.getInfo failed for "${artist}": ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Best-available crowd tags for an artist. Prefers the direct Last.fm API when
// an api_key is configured (works on vanilla Navidrome); otherwise routes
// through Navidrome's getArtistInfo2, which only surfaces tag[] on a custom
// Navidrome agent (empty on vanilla). Returns [] on any miss/failure.
//
// This is the single chokepoint both the bulk tagger (tag-library.phaseEnrich)
// and the single-track retag route call, so they can't drift on which source
// they use — the drift that caused issue #532, where retag only ever hit the
// Navidrome path and so never surfaced tags on vanilla Navidrome with a key.
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
    const source = getSource();
    const matches = await source.searchArtists(artist, { artistCount: 1 });
    const artistId = matches?.[0]?.id;
    if (!artistId) return [];
    const tags = await source.getArtistLastfmTags(artistId, { count });
    return Array.isArray(tags) ? tags : [];
  } catch {
    return [];
  }
}
