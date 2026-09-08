// Pure pool builder for the auto.m3u fallback (broadcast/scheduler.ts). No I/O:
// the caller fetches the source lists and feeds them in via take().
//
// Three guards on every candidate:
//   1. Recency — drop anything recently played, by id AND by lowercased
//      `title|artist` key, so N duplicate copies can't slip one back on (#874).
//   2. Dedup — never add the same track twice, by id AND key.
//   3. Artist cap — cap one artist's share; per-source overridable for a source
//      that IS an exact operator-pinned set.

import { artistKey, trackKey } from '../music/recency.js';

export interface PoolBuilderOpts {
  recentIds: Set<string>;
  recentKeys: Set<string>;   // lowercased `title|artist` of recent plays
  targetPool: number;        // stop accepting once the pool reaches this size
  maxPerArtist: number;      // cap any one artist's share of the pool
}

export interface TakeOpts {
  // On an empty first pass, retry ignoring recency. Dedicated show sources
  // only: scheduler's strict end-filters never-starve on an empty in-filter
  // set, so a narrow pinned playlist inside the recency window would coast
  // entirely off-playlist. Dedup and the artist cap still apply on the retry.
  neverStarve?: boolean;
  // Lift the artist cap for THIS source only — a strict-playlist show pinned an
  // exact set, so a single-artist playlist is the point. Scoped per take()
  // because the other sources still run on such a show, and an uncapped
  // off-playlist source would fill the pool with tracks the end-filter drops.
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
      // Key only when the song has a title (mirrors queue.recentlyPlayed) so a
      // title-less row can't collapse an artist's whole catalogue.
      const tk = t.title ? trackKey(t) : '';
      if (!ignoreRecency && (recentIds.has(t.id) || (tk && recentKeys.has(tk)))) continue;
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
