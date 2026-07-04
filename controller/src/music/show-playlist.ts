// Show → Navidrome playlist anchor resolver.
//
// A show can pin one or more Navidrome playlists (settings show.playlistIds);
// the union of their tracks becomes the show's candidate pool. This module
// turns that id list into a deduped track pool, shared by all three consumers:
// the pool picker (music/picker.ts), the session DJ agent's tools
// (broadcast/dj-agent.ts), and the LLM-free fallback (broadcast/scheduler.ts).
//
// source.getPlaylist already rejects station-archive entries, so there's no
// extra archive filtering here — the merge is purely union + dedupe by id.

import * as source from './source.js';

export type PlaylistPool = {
  ids: Set<string>; // every track id in the union — the strict lock set
  tracks: any[];     // deduped Subsonic song objects
  names: string[];   // resolved playlist names, for logging / debug
};

// Pure: flatten a list of playlist track-lists into one deduped array, keeping
// the first occurrence of each id and dropping entries without an id. The
// unit-test seam (scripts/show-playlist.test.ts) — no Subsonic, no I/O.
export function mergePlaylistTracks(lists: any[][]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const list of lists) {
    for (const t of list || []) {
      const id = t?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
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
    index = await memoFetch('playlists-index', () => source.getPlaylists());
  } catch {}

  const lists: any[][] = [];
  const names: string[] = [];
  for (const id of ids) {
    try {
      const songs = await memoFetch(`playlist:${id}`, () => source.getPlaylist(id));
      lists.push(songs || []);
      const meta = index.find((p: any) => p.id === id);
      if (meta?.name) names.push(meta.name);
    } catch {}
  }

  const tracks = mergePlaylistTracks(lists);
  if (!tracks.length) return null;
  return { ids: new Set<string>(tracks.map((t: any) => t.id)), tracks, names };
}
