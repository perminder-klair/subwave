// Show → Navidrome playlist anchor resolver.
//
// A show can pin one or more Navidrome playlists (settings show.playlistIds);
// the union of their tracks becomes the show's candidate pool. This module
// turns that id list into an identity-deduped track pool, shared by all three consumers:
// the pool picker (music/picker.ts), the session DJ agent's tools
// (broadcast/dj-agent.ts), and the LLM-free fallback (broadcast/scheduler.ts).
//
// subsonic.getPlaylist already rejects station-archive entries, so there's no
// extra archive filtering here — the merge is purely union + dedupe by id and
// normalised title|artist identity.

import * as subsonic from './subsonic.js';
import { trackKey } from './recency.js';

export type PlaylistPool = {
  ids: Set<string>; // every SURVIVING track id — the strict lock set. Not every
                    // id in the union: an alternate rip collapsed by the
                    // identity dedupe below is absent, so a strict show cannot
                    // pick it. resolveShowPlaylistPool warns when that happens.
  tracks: any[];     // deduped Subsonic song objects
  names: string[];   // resolved playlist names, for logging / debug
};

// Pure: flatten a list of playlist track-lists into one deduped array, keeping
// the first occurrence of each id or normalised title|artist identity and
// dropping entries without an id. The unit-test seam
// (scripts/show-playlist.test.ts) — no Subsonic, no I/O.
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

// TTL cache so a pick / refresh doesn't re-walk every playlist. Same 30-min
// horizon the pool picker uses for its other Subsonic sources; a playlist edited
// in Navidrome shows up within a refresh cycle.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { val: any[]; at: number }>();

async function memoFetch(key: string, fn: () => Promise<any[]>): Promise<any[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  const val = await fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

// Resolve a show's anchored playlists into a deduped track pool. Returns null
// when the show pins no playlists (the common case → callers behave as today).
// A missing / deleted / empty playlist id contributes nothing rather than
// throwing, so a stale anchor degrades to the show's other steering (or the
// full library) instead of stranding the stream.
export async function resolveShowPlaylistPool(show: any): Promise<PlaylistPool | null> {
  const ids = Array.isArray(show?.playlistIds) ? show.playlistIds.filter(Boolean) : [];
  if (!ids.length) return null;

  // One index fetch (memoised) to map ids → names for the log line; failures
  // here just drop the names, never the tracks.
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
      // Still degrade (never strand the stream on one bad anchor), but say so:
      // a stale id (playlist deleted/recreated in Navidrome) failing silently
      // here is what turned a "playlist only (strict)" show into an unanchored
      // one with no trace. The pick paths log the operator-facing warning when
      // the whole pool comes back null.
      console.warn(`[show-playlist] anchor playlist ${id} failed to resolve: ${(err as Error)?.message}`);
    }
  }

  const tracks = mergePlaylistTracks(lists);
  if (!tracks.length) return null;
  // The identity dedupe drops playlist entries the operator can still SEE in
  // Navidrome, and it shrinks the strict lock set with them. Say so: a strict
  // show quietly short of the songs its own playlist lists is undiagnosable
  // from the operator's side — the same reason the pick paths shout when a
  // pinned anchor resolves to nothing. Only the identity collapses are counted;
  // a plain id repeated across two pinned playlists is an ordinary union.
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

// Resolve a show's excluded playlists (blocklist) into a set of track ids to
// suppress. Any track whose id is in this set is dropped from the candidate
// pool before the LLM sees it. Returns null when the show has no excluded
// playlists (the common case → callers treat it as a no-op). Shares the same
// `playlist:${id}` memo key as resolveShowPlaylistPool — it's the identical
// getPlaylist fetch, so a playlist used as both anchor and blocklist is fetched
// once, not twice.
// Resolve a list of playlist ids into per-playlist member-id sets — the
// blocklist's `playlist` rules read these (music/blocklist.ts keeps them in
// module state so matchOf stays synchronous). Shares the `playlist:${id}` memo
// with the anchor/excluded resolvers above, so a playlist used as anchor and
// rule is fetched once. A failed id is simply absent from the map (stale ids
// inert), warned once per fetch attempt.
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
