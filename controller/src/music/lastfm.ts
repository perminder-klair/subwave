// Navidrome getArtistInfo2 omits tags, so read Last.fm directly. Reads need only the API key;
// failures return [] without retry. Track-level tags (opt-in) answer in a TagLookup instead,
// because their backfill has to tell a genuine answer from a failure.

import * as subsonic from './subsonic.js';
import { LASTFM_API, resolveLastfmApiKey } from './lastfm-shared.js';
import { classifyTopTagsResponse, dropNameEchoes, mergeCrowdTags } from './lastfm-tag-policy.js';
import type { LastfmPacer } from './lastfm-pacer.js';
import { nameKey } from './recency.js';
import { fetchWithTimeout } from '../util/fetch-timeout.js';

const TIMEOUT_MS = 5000;

// The *.getTopTags methods return a normalised popularity count (0–100). A 0
// means nobody applied the tag after normalisation, so drop those; a missing or
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

// Track-level tags sit on top of that gate and are strictly opt-in. They need a
// key whatever the setting says: keyless installs stay on getArtistInfo2. A key
// of only spaces is none: Last.fm answers it with error 6, which reads as a miss,
// so a pass would stamp the whole library without having asked about any of it.
export function lastfmTrackTagsEnabled(
  enrichCfg: { lastfmTags?: unknown; lastfmTrackTags?: unknown },
  hasKey: boolean,
): boolean {
  return enrichCfg.lastfmTrackTags === true
    && hasKey
    && resolveKey().trim() !== ''
    && lastfmEnrichEnabled(enrichCfg.lastfmTags, hasKey);
}

// `answered` is true for a hit AND for a genuine "not found"; it is what a
// stamp rests on. Everything else, a failed request, a bad key, rate limiting,
// a reply of unknown shape, is false (see lastfm-tag-policy.ts).
export interface TagLookup {
  tags: string[];
  answered: boolean;
  rateLimited: boolean;
}

const NOT_ANSWERED: TagLookup = { tags: [], answered: false, rateLimited: false };

function parseTopTags(data: any): string[] {
  const raw = data?.toptags?.tag ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter((t: any) => {
      const c = Number(t?.count);
      return !Number.isFinite(c) || c >= MIN_TAG_COUNT;
    })
    .map((t: any) => (typeof t === 'string' ? t : t?.name))
    .filter((s: any): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s: string) => s.toLowerCase().trim());
}

// One *.getTopTags request, classified. The caller has checked the key.
async function askTopTags(
  method: 'artist.getTopTags' | 'track.getTopTags',
  query: Record<string, string>,
  label: string,
  pacer?: LastfmPacer,
): Promise<TagLookup> {
  if (pacer && !(await pacer.turn())) return NOT_ANSWERED;

  const params = new URLSearchParams({
    method,
    ...query,
    autocorrect: '1',
    api_key: resolveKey(),
    format: 'json',
  });

  let lookup = NOT_ANSWERED;
  try {
    const r = await fetchWithTimeout(`${LASTFM_API}?${params.toString()}`, {
      method: 'GET',
      headers: { 'User-Agent': 'sub-wave/tags' },
      timeoutMs: TIMEOUT_MS,
      bodyDeadline: true,
    });
    // A failed status can still carry Last.fm's JSON `error`; a 200 that isn't
    // JSON is a failure in its own right, so it throws to the catch below.
    const data = r.ok ? await r.json() : await r.json().catch(() => null);
    const verdict = classifyTopTagsResponse(r.status, data);
    // An unknown track is a normal miss, and a library has thousands of them.
    if (!r.ok && (verdict !== 'miss' || method === 'artist.getTopTags')) {
      console.warn(`[lastfm] ${method} → ${r.status} for "${label}"`);
    }
    if (verdict === 'answer') lookup = { tags: parseTopTags(data), answered: true, rateLimited: false };
    else if (verdict === 'miss') lookup = { tags: [], answered: true, rateLimited: false };
    else if (verdict === 'rate-limited') lookup = { tags: [], answered: false, rateLimited: true };
  } catch (err: any) {
    console.warn(`[lastfm] ${method} failed for "${label}": ${err?.message || err}`);
  }

  if (pacer) {
    if (lookup.answered) pacer.answered();
    else pacer.failed(lookup.rateLimited);
    if (lookup.rateLimited) console.warn('[lastfm] rate limited — backing off');
  }
  return lookup;
}

async function lookupArtistTopTags(artist: string, count: number, pacer?: LastfmPacer): Promise<TagLookup> {
  if (!resolveKey() || !artist || !artist.trim()) return NOT_ANSWERED;
  const lookup = await askTopTags('artist.getTopTags', { artist }, artist, pacer);
  return { ...lookup, tags: lookup.tags.slice(0, count) };
}

// Crowd tags for an artist, lowercased/trimmed and sliced to `count`
// (default 10). [] on no key, no coverage, or any failure.
export async function getArtistTopTags(
  artist: string,
  opts: { count?: number } = {},
): Promise<string[]> {
  return (await lookupArtistTopTags(artist, opts.count ?? 10)).tags;
}

// Crowd tags for one song, on the same terms, less any tag that only repeats the
// artist or the title (lastfm-tag-policy.ts). The filter runs before the slice,
// so an echo doesn't cost the track one of its real tags.
export async function getTrackTopTags(
  artist: string,
  title: string,
  opts: { count?: number; pacer?: LastfmPacer } = {},
): Promise<TagLookup> {
  if (!resolveKey() || !artist || !artist.trim() || !title || !title.trim()) return NOT_ANSWERED;
  const lookup = await askTopTags('track.getTopTags', { artist, track: title }, `${artist} - ${title}`, opts.pacer);
  return { ...lookup, tags: dropNameEchoes(lookup.tags, { artist, title }).slice(0, opts.count ?? 10) };
}

// Best-available crowd tags: the direct Last.fm API when a key is configured,
// else Navidrome's getArtistInfo2 (empty on vanilla). [] on any miss/failure.
// The single chokepoint for the bulk tagger and the retag route, so the two
// cannot drift on which source they use (#532). getMergedTags is its opt-in
// track-level twin.
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

// Where getMergedTags reads from. A bulk pass hands it pacedTagSource(); the
// retag route takes the default, one unpaced request of each.
export interface TagSource {
  track(artist: string, title: string, count: number): Promise<TagLookup>;
  artist(artist: string, count: number): Promise<TagLookup>;
}

const directTagSource: TagSource = {
  track: (artist, title, count) => getTrackTopTags(artist, title, { count }),
  artist: (artist, count) => lookupArtistTopTags(artist, count),
};

// A pass's view of Last.fm: every request through the pacer, one call per
// normalised artist and per normalised artist + title. The memo holds the
// in-flight promise so a pool shares it, as phaseEnrich's artist memo does, but
// lets go of a failure: left in place, one blip on an artist would cost all that
// artist's rows their stamp for the rest of the pass.
export function pacedTagSource(pacer: LastfmPacer): TagSource {
  const memo = new Map<string, Promise<TagLookup>>();
  const once = (key: string, ask: () => Promise<TagLookup>): Promise<TagLookup> => {
    let held = memo.get(key);
    if (!held) {
      held = ask();
      memo.set(key, held);
      void held.then((lookup) => {
        if (!lookup.answered) memo.delete(key);
      });
    }
    return held;
  };
  return {
    track: (artist, title, count) =>
      once(`t\0${nameKey(artist)}\0${nameKey(title)}`, () => getTrackTopTags(artist, title, { count, pacer })),
    artist: (artist, count) =>
      once(`a\0${nameKey(artist)}`, () => lookupArtistTopTags(artist, count, pacer)),
  };
}

export interface MergedTags {
  tags: string[];
  // Both halves came back genuine, so the list may be stamped as final.
  answered: boolean;
  // How many tags of its own the song came back with, before the merge's limit.
  trackTagCount: number;
}

// The track-level chokepoint: the bulk tagger and the retag route both end up
// here, so with the setting on they cannot disagree on a song's list. Only ever
// reached with a key, so it never needs getArtistTags' Navidrome fallback.
export async function getMergedTags(
  artist: string,
  title: string,
  opts: { count?: number; source?: TagSource } = {},
): Promise<MergedTags> {
  const count = opts.count ?? 10;
  const source = opts.source ?? directTagSource;
  const track = await source.track(artist, title, count);
  const fill = await source.artist(artist, count);
  return {
    tags: mergeCrowdTags(track.tags, fill.tags),
    answered: track.answered && fill.answered,
    trackTagCount: track.tags.length,
  };
}
