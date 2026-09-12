// The Spotify reads that get asked for over and over, memoised in one place.
//
// Everything here is a CATALOGUE read: the operator's playlists, their saved
// albums, their saved tracks. None of it changes minute to minute, all of it is
// asked for by several unrelated callers, and every ask costs a request against
// a rolling 30-second quota we cannot buy our way out of (see client.ts).
// Before this module the same `/me/playlists` walk happened twice — once for the
// admin's playlist pickers, once inside every pool build — and `/me/albums` and
// `/me/tracks` were not memoised at all, so the hourly auto-playlist refresh,
// the pool picker, two agent picker tools and the listener-request matcher each
// paid for them separately.
//
// THE CLIENT IS PASSED IN rather than imported. source.ts owns the client
// singleton and imports this module; pool.ts imports it too. Taking the client
// as an argument is what keeps that a tree instead of a cycle, and it costs the
// callers nothing — both already hold a client at the call site.
//
// TWO PROPERTIES COME FROM util/ttl-cache.ts, both load-bearing:
//   • TTL — cost bounded by the clock rather than by how many admin tabs are open.
//   • SINGLE FLIGHT — two panels mounting at once share ONE request instead of
//     racing each other into two.
//
// AND A THIRD THIS FILE ADDS: failures are remembered. `cachedAsync`
// deliberately does NOT cache a rejection — the in-flight promise is dropped and
// the next call retries — which is right for a telnet status and wrong for a
// metered API that a polling admin tab will ask again in three seconds. Rather
// than change that contract (its other callers depend on it), the producers here
// RESOLVE to an envelope, so a failure is an ordinary cached value. The original
// error object is kept and re-thrown, not a copy of its message: callers that
// branch on `err.status === 429` must keep working, and every caller's existing
// error handling must stay exactly as it was.
//
// A remembered failure expires sooner than a remembered success — a transient
// 503 should not cost five minutes of a feature — which is the one thing a
// single-TTL cache cannot express, hence the explicit re-check in `memoRead`.

import { cachedAsync } from '../../../util/ttl-cache.js';
import type { SpotifyClient } from './client.js';
import { SPOTIFY_PAGE_MAX, SPOTIFY_SEARCH_MAX } from './client.js';

// The pool's own cadence. A playlist edit shows up within this, and until then
// every caller shares one answer.
export const READ_TTL_MS = 5 * 60 * 1000;
// How long a failure is remembered. Long enough to stop a 3-second poll from
// re-asking, short enough that a blip is not a five-minute outage.
export const READ_FAIL_TTL_MS = 60 * 1000;
// Saved tracks are a sample for the pickers, not a full walk — two requests.
export const STARRED_MAX = 100;

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface MemoRead<T> {
  /** The value, fresh or cached. Throws exactly what the producer threw. */
  (): Promise<T>;
  /** Drop the entry so the next call takes a fresh reading. */
  invalidate(): void;
  /** The cached SUCCESS as-is, or null. Never triggers a request. */
  peek(): { value: T; at: number } | null;
}

export interface MemoOpts {
  ttlMs?: number;
  failTtlMs?: number;
  now?: () => number;
}

export function memoRead<T>(fn: () => Promise<T>, opts: MemoOpts = {}): MemoRead<T> {
  const { ttlMs = READ_TTL_MS, failTtlMs = READ_FAIL_TTL_MS, now = Date.now } = opts;
  const cache = cachedAsync<Attempt<T>>(
    async () => {
      try { return { ok: true, value: await fn() }; }
      catch (error) { return { ok: false, error }; }
    },
    { ttlMs, now },
  );
  const read = (async () => {
    // A remembered failure gets the shorter life. cachedAsync has one TTL, so
    // the expiry a failure needs is applied here rather than by teaching the
    // cache a second one — it is this module's policy, not the cache's.
    const held = cache.peek();
    if (held && !held.value.ok && now() - held.at >= failTtlMs) cache.invalidate();
    const r = await cache.get();
    if (!r.ok) throw r.error;
    return r.value;
  }) as MemoRead<T>;
  read.invalidate = () => cache.invalidate();
  read.peek = () => {
    const held = cache.peek();
    return held && held.value.ok ? { value: held.value.value, at: held.at } : null;
  };
  return read;
}

// A memo over a call that takes an ARGUMENT — one `memoRead` per key, bounded.
//
// `memoRead` above memoises a single answer; this memoises a family of them.
// The two reads it exists for are the ones nothing was caching: `GET /albums/{id}`,
// which the picker's recently-added tool and the pool picker fan out over (~118
// requests an hour, and never once memoised anywhere), and `/search`, which
// costs THREE HTTP requests per logical search since February 2026 capped a
// page at ten results.
//
// Bounded because the key space is the operator's whole catalogue: without a
// cap this is a memory leak wearing a cache's clothes. Eviction is
// insertion-order (a Map iterates in insertion order, so the first key is the
// oldest) rather than true LRU — the working set here is "what the DJ has been
// picking lately", which ages out the same way either way, and an LRU's
// per-read bookkeeping is not worth it for a few hundred entries.
export function keyedMemo<T>(
  fn: (key: string) => Promise<T>,
  opts: MemoOpts & { max?: number } = {},
): { (key: string): Promise<T>; invalidate(): void; size(): number } {
  const { max = 300, ...memoOpts } = opts;
  const entries = new Map<string, MemoRead<T>>();
  const call = (key: string): Promise<T> => {
    let memo = entries.get(key);
    if (!memo) {
      memo = memoRead(() => fn(key), memoOpts);
      entries.set(key, memo);
      while (entries.size > max) {
        const oldest = entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    }
    return memo();
  };
  call.invalidate = () => entries.clear();
  call.size = () => entries.size;
  return call;
}

// A memo over a call that needs the client. The client is a process singleton,
// so the latest one handed in is the one the producer uses; keeping it in a
// variable rather than closing over the first caller's means a `resetToken()`
// or a reconnect can never leave the memo talking to a stale object.
function clientMemo<T>(fn: (c: SpotifyClient) => Promise<T>): MemoRead<T> & ((c?: SpotifyClient) => Promise<T>) {
  let held: SpotifyClient | null = null;
  const memo = memoRead(() => fn(held!));
  const call = ((c?: SpotifyClient) => {
    if (c) held = c;
    return memo();
  }) as MemoRead<T> & ((c?: SpotifyClient) => Promise<T>);
  call.invalidate = memo.invalidate;
  call.peek = memo.peek;
  return call;
}

// ── the reads ───────────────────────────────────────────────────────────────

// Every playlist the account owns or follows, RAW. Raw rather than mapped
// because its two consumers want different things from the same objects: the
// admin pickers want `mapPlaylist`'s shape, the pool wants `items.total` and
// `snapshot_id`. Mapping here would make the pool re-fetch what it already had.
export const listMyPlaylists = clientMemo(async (c) => {
  const out: any[] = [];
  for await (const p of c.paginate<any>((o) => c.getMyPlaylists({ offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
    out.push(p);
  }
  return out;
});

// The account's saved albums, newest first — Spotify's "recently added".
// `size` is deliberately NOT part of the cache key: callers ask for 8, 12, 20
// and 50, and keying on it would turn one shared answer into four. One page is
// fetched and each caller slices.
export const listSavedAlbums = clientMemo(async (c) => {
  const r: any = await c.getSavedAlbums({ limit: SPOTIFY_PAGE_MAX });
  return (r?.items ?? []) as any[];
});

// A sample of the account's saved tracks — the station's "starred".
export const listSavedTracks = clientMemo(async (c) => {
  const out: any[] = [];
  for await (const item of c.paginate<any>((o) => c.getSavedTracks({ offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX, max: STARRED_MAX })) {
    out.push(item);
  }
  return out;
});

// An album and its tracks, RAW.
//
// Raw on purpose, like the playlist listing: the callers map these into Songs
// and then MUTATE them (the queue stamps transient fields onto a song object
// before getAnnotatedUri reads them, and withPoolGenres writes genres in), so
// handing every caller the same objects would alias one pick's bookkeeping into
// another's. Mapping per call costs microseconds; the request it saves costs a
// slice of a metered quota.
//
// Albums over fifty tracks page, which is why this is a walk rather than a
// single read.
let albumClient: SpotifyClient | null = null;
export const albumById = keyedMemo(async (id: string) => {
  const c = albumClient!;
  const album: any = await c.getAlbum(id);
  if (!album) return null;
  const items: any[] = [...(album.tracks?.items ?? [])];
  if (album.tracks?.next) {
    for await (const t of c.paginate<any>((o) => c.getAlbumTracks(album.id, { offset: o, limit: SPOTIFY_PAGE_MAX }), { pageSize: SPOTIFY_PAGE_MAX })) {
      if (!items.some((x) => x.id === t.id)) items.push(t);
    }
  }
  return { album, items };
}, { ttlMs: 30 * 60 * 1000 });
export function getAlbumRaw(c: SpotifyClient, id: string) {
  albumClient = c;
  return albumById(id);
}

// A search, RAW, keyed by exactly what was asked for.
//
// Since February 2026 `/search` answers ten results a page, so one logical
// search of 25 is THREE requests. The picker's tools retry a search with a
// different offset, then re-search under a resolved artist name, and the
// listener-request matcher issues up to four searches for one request — so the
// same query recurs constantly, both within one pick and across consecutive
// ones. Short TTL: a search is a view of a live catalogue, and the point here
// is to collapse a burst, not to remember yesterday's answer.
let searchClient: SpotifyClient | null = null;
export const SEARCH_MEMO_TTL_MS = 5 * 60 * 1000;
const searchMemo = keyedMemo(async (key: string) => {
  const [type, want, offset, ...rest] = key.split(' ');
  const q = rest.join(' ');
  const c = searchClient!;
  const out: any[] = [];
  const target = Math.max(1, Number(want));
  const from = Number(offset);
  for (let page = 0; page < SEARCH_MAX_PAGES && out.length < target; page++) {
    const r: any = await c.search(q, [type as 'track' | 'artist'], { limit: SPOTIFY_SEARCH_MAX, offset: from + page * SPOTIFY_SEARCH_MAX });
    const items: any[] = (type === 'track' ? r?.tracks?.items : r?.artists?.items) ?? [];
    out.push(...items);
    if (items.length < SPOTIFY_SEARCH_MAX) break; // short page — that was the last one
  }
  return out.slice(0, target);
}, { ttlMs: SEARCH_MEMO_TTL_MS });
export function searchRaw(c: SpotifyClient, q: string, type: 'track' | 'artist', want: number, offset: number) {
  searchClient = c;
  return searchMemo([type, String(want), String(offset), q].join(' '));
}

// Bounded: a search that has to walk more than this is a search that is not
// finding anything, and every page is a metered request.
const SEARCH_MAX_PAGES = 3;

// Drop every memo. Called wherever the ACCOUNT changes underneath us — a
// connect, a token paste, a disconnect — and from the pool's invalidate(),
// which is what "Rebuild pool now" reaches. Before this existed the playlist
// memo had no invalidation hook at all, so the show editor kept showing the
// pre-edit playlist list for up to five minutes after a rebuild.
export function invalidateSpotifyReads(): void {
  listMyPlaylists.invalidate();
  listSavedAlbums.invalidate();
  listSavedTracks.invalidate();
  albumById.invalidate();
  searchMemo.invalidate();
}

// What the memos are holding, for the operator surface — a cache nobody can see
// is a cache nobody trusts.
export function spotifyReadStats(): { albums: number; searches: number } {
  return { albums: albumById.size(), searches: searchMemo.size() };
}
