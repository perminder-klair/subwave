// Pure pool builder for the auto.m3u fallback (broadcast/scheduler.ts).
//
// Accumulates candidate tracks from several weighted Navidrome/library sources
// into a single balanced pool, applying three guards on every candidate:
//   1. Recency  — drop anything played in the recent window (by id AND by
//      lowercased `title|artist` key, so N duplicate copies of one song — N
//      distinct Subsonic ids — can't slip a just-played track back on air, #874).
//   2. Dedup    — never add the same track twice (again by id AND key, so
//      duplicate library copies don't each claim a slot).
//   3. Artist cap — cap any one artist's share so a deep-catalogue artist can't
//      dominate the fallback and cluster on air. Per-source overridable
//      (TakeOpts.maxPerArtist) for a source that IS an exact operator-pinned set.
//
// Extracted from the `take()` closure so the guards are unit-testable in
// isolation (scripts/auto-pool.test.ts) without booting Subsonic/Liquidsoap.
// No I/O — the caller fetches the source lists and feeds them in via take().

import { artistKey, trackKey } from '../music/recency.js';

export interface PoolBuilderOpts {
  recentIds: Set<string>;
  recentKeys: Set<string>;   // lowercased `title|artist` of recent plays
  targetPool: number;        // stop accepting once the pool reaches this size
  maxPerArtist: number;      // cap any one artist's share of the pool
}

export interface TakeOpts {
  // Never let this source contribute ZERO purely because everything in it is
  // inside the recency window: on an empty first pass, retry ignoring recency.
  // For the DEDICATED SHOW sources only (show-genre, show-playlist), where an
  // empty contribution doesn't just remove the source — the strict end-filters
  // in scheduler.ts never-starve on an empty in-filter set, so a show pinned to
  // a narrow playlist whose tracks are all inside the (library-scaled, up to
  // 36 h) window would coast entirely OFF-playlist. Dedup and the artist cap
  // still apply on the retry; only the recency guard is dropped.
  neverStarve?: boolean;
  // Lift the artist cap for THIS source only. Set by the dedicated
  // show-playlist source on a strict-playlist show: the operator pinned an
  // exact set, so a single-artist / single-album playlist is the point, not a
  // deep-catalogue artist muscling in — capping it at AUTO_MAX_PER_ARTIST left
  // the strict end-filter with 2 in-playlist tracks to keep. Scoped per take()
  // rather than lifted on the builder, because the OTHER sources still run on
  // such a show (a strict-playlist show may also pin a genre) and an uncapped
  // off-playlist source just fills TARGET_POOL with tracks the end-filter is
  // about to drop, starving the in-playlist share it was meant to protect.
  maxPerArtist?: number;
}

export interface PoolBuilder {
  pool: any[];                          // accumulated candidates (with `_source`)
  fromSource: Record<string, number>;   // per-source accepted counts (for logging)
  // Pull up to `cap` fresh candidates from `items` under label `label`, applying
  // the recency / dedup / artist-cap guards. Mutates `pool` and `fromSource`.
  take: (label: string, items: any[], cap: number, opts?: TakeOpts) => void;
}

export function createPoolBuilder(opts: PoolBuilderOpts): PoolBuilder {
  const { recentIds, recentKeys, targetPool, maxPerArtist } = opts;
  const pool: any[] = [];
  const fromSource: Record<string, number> = {};
  const artistInPool = new Map<string, number>();
  const poolIds = new Set<string>();
  const poolKeys = new Set<string>();

  const pull = (label: string, items: any[], cap: number, ignoreRecency: boolean, artistCap: number): number => {
    let n = 0;
    for (const t of items) {
      if (n >= cap || pool.length >= targetPool) break;
      if (!t?.id) continue;
      // Key only when the song has a title (mirrors queue.recentlyPlayed's keyOf
      // guard) so a title-less row can't collapse an artist's whole catalogue.
      const tk = t.title ? trackKey(t) : '';
      // Recency: block by id AND title|artist key (defeats duplicate copies).
      if (!ignoreRecency && (recentIds.has(t.id) || (tk && recentKeys.has(tk)))) continue;
      // Pool dedup: by id AND key, so copies #2..N don't re-fill the pool.
      if (poolIds.has(t.id) || (tk && poolKeys.has(tk))) continue;
      const ak = artistKey(t);
      if (ak && (artistInPool.get(ak) || 0) >= artistCap) continue;
      pool.push({ ...t, _source: label });
      poolIds.add(t.id);
      if (tk) poolKeys.add(tk);
      fromSource[label] = (fromSource[label] || 0) + 1;
      if (ak) artistInPool.set(ak, (artistInPool.get(ak) || 0) + 1);
      n++;
    }
    return n;
  };

  const take = (label: string, items: any[], cap: number, takeOpts: TakeOpts = {}) => {
    const artistCap = takeOpts.maxPerArtist ?? maxPerArtist;
    const n = pull(label, items, cap, false, artistCap);
    if (n === 0 && takeOpts.neverStarve) pull(label, items, cap, true, artistCap);
  };

  return { pool, fromSource, take };
}
