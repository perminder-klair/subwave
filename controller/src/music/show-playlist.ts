// Show -> Navidrome playlist anchor resolver. A show's pinned playlists
// (show.playlistIds) union, identity-deduped, is its candidate pool, shared by the
// pool picker, the DJ agent's tools and the LLM-free fallback. getPlaylist already
// drops station-archive entries, so this is only union + dedupe.

import * as subsonic from './source.js';
import { trackKey } from './recency.js';

export type PlaylistPool = {
  ids: Set<string>; // SURVIVING ids only, so a rip collapsed by the identity
                    // dedupe is absent from the strict lock set (warned below).
  tracks: any[];     // deduped Subsonic song objects
  names: string[];   // resolved playlist names, for logging / debug
};

// Keeps the first occurrence of each id or normalised title|artist identity;
// entries without an id are dropped. Pure, the unit-test seam.
export function mergePlaylistTracks(lists: any[][]): any[] {
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const out: any[] = [];
  for (const list of lists) {
    for (const t of list || []) {
      const id = t?.id;
      if (!id || seenIds.has(id)) continue;
      const key = t?.title ? trackKey(t) : '';
      if (key && seenKeys.has(key)) continue;
      seenIds.add(id);
      if (key) seenKeys.add(key);
      out.push(t);
    }
  }
  return out;
}

// Same 30-min horizon the pool picker uses for its other Subsonic sources.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { val: any[]; at: number }>();

async function memoFetch(key: string, fn: () => Promise<any[]>): Promise<any[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  const val = await fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

// null when the show pins none. A missing/deleted/empty id contributes nothing
// rather than throwing, so a stale anchor degrades instead of stranding the stream.
export async function resolveShowPlaylistPool(show: any): Promise<PlaylistPool | null> {
  const ids = Array.isArray(show?.playlistIds) ? show.playlistIds.filter(Boolean) : [];
  if (!ids.length) return null;

  // ids -> names for the log line; a failure drops the names, never the tracks.
  let index: any[] = [];
  try {
    index = await memoFetch('playlists-index', () => subsonic.getPlaylists());
  } catch {}

  const lists: any[][] = [];
  const names: string[] = [];
  for (const id of ids) {
    try {
      const songs = await memoFetch(`playlist:${id}`, () => subsonic.getPlaylist(id));
      lists.push(songs || []);
      const meta = index.find((p: any) => p.id === id);
      if (meta?.name) names.push(meta.name);
    } catch (err) {
      // Degrade but say so: a silent stale id turns a strict playlist show into
      // an unanchored one.
      console.warn(`[show-playlist] anchor playlist ${id} failed to resolve: ${(err as Error)?.message}`);
    }
  }

  const tracks = mergePlaylistTracks(lists);
  if (!tracks.length) return null;
  // The identity dedupe shrinks the strict lock set below what the operator sees
  // in Navidrome, so say so. An id repeated across two pinned playlists is a
  // union, not a collapse.
  const distinctIds = new Set<string>();
  for (const list of lists) {
    for (const t of list || []) if (t?.id) distinctIds.add(t.id);
  }
  const collapsed = distinctIds.size - tracks.length;
  if (collapsed > 0) {
    const where = names.length ? names.join(', ') : `${ids.length} playlist(s)`;
    console.warn(`[show-playlist] ${collapsed} duplicate rip(s) in ${where} collapsed by title/artist — one id per song reaches the pick paths, so the show has ${tracks.length} playable entries, not ${distinctIds.size}.`);
  }
  return { ids: new Set<string>(tracks.map((t: any) => t.id)), tracks, names };
}

// Per-playlist member-id sets for the blocklist's `playlist` rules, which hold
// them in module state so matchOf stays synchronous. Shares the `playlist:${id}`
// memo, so an id used as both anchor and rule is fetched once; a failed id is
// absent from the map rather than fatal.
export async function resolvePlaylistMemberSets(ids: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const id of [...new Set(ids.filter(Boolean))]) {
    try {
      const songs = await memoFetch(`playlist:${id}`, () => subsonic.getPlaylist(id));
      out.set(id, new Set((songs || []).map((t: any) => t?.id).filter(Boolean)));
    } catch (err) {
      console.warn(`[show-playlist] rule playlist ${id} failed to resolve: ${(err as Error)?.message}`);
    }
  }
  return out;
}

// Track ids to suppress before the LLM sees the pool; null when none are excluded.
export async function resolveExcludedPlaylistIds(show: any): Promise<Set<string> | null> {
  const ids = Array.isArray(show?.excludedPlaylistIds) ? show.excludedPlaylistIds.filter(Boolean) : [];
  if (!ids.length) return null;

  const blocked = new Set<string>();
  for (const id of ids) {
    try {
      const songs = await memoFetch(`playlist:${id}`, () => subsonic.getPlaylist(id));
      for (const t of songs || []) {
        if (t?.id) blocked.add(t.id);
      }
    } catch (err) {
      console.warn(`[show-playlist] excluded playlist ${id} failed to resolve: ${(err as Error)?.message}`);
    }
  }
  return blocked.size ? blocked : null;
}
