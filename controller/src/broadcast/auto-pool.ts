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
//      dominate the fallback and cluster on air.
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

export interface PoolBuilder {
  pool: any[];                          // accumulated candidates (with `_source`)
  fromSource: Record<string, number>;   // per-source accepted counts (for logging)
  // Pull up to `cap` fresh candidates from `items` under label `label`, applying
  // the recency / dedup / artist-cap guards. Mutates `pool` and `fromSource`.
  take: (label: string, items: any[], cap: number) => void;
}

export function createPoolBuilder(opts: PoolBuilderOpts): PoolBuilder {
  const { recentIds, recentKeys, targetPool, maxPerArtist } = opts;
  const pool: any[] = [];
  const fromSource: Record<string, number> = {};
  const artistInPool = new Map<string, number>();
  const poolIds = new Set<string>();
  const poolKeys = new Set<string>();

  const take = (label: string, items: any[], cap: number) => {
    let n = 0;
    for (const t of items) {
      if (n >= cap || pool.length >= targetPool) break;
      if (!t?.id) continue;
      // Key only when the song has a title (mirrors queue.recentlyPlayed's keyOf
      // guard) so a title-less row can't collapse an artist's whole catalogue.
      const tk = t.title ? trackKey(t) : '';
      // Recency: block by id AND title|artist key (defeats duplicate copies).
      if (recentIds.has(t.id) || (tk && recentKeys.has(tk))) continue;
      // Pool dedup: by id AND key, so copies #2..N don't re-fill the pool.
      if (poolIds.has(t.id) || (tk && poolKeys.has(tk))) continue;
      const ak = artistKey(t);
      if (ak && (artistInPool.get(ak) || 0) >= maxPerArtist) continue;
      pool.push({ ...t, _source: label });
      poolIds.add(t.id);
      if (tk) poolKeys.add(tk);
      fromSource[label] = (fromSource[label] || 0) + 1;
      if (ak) artistInPool.set(ak, (artistInPool.get(ak) || 0) + 1);
      n++;
    }
  };

  return { pool, fromSource, take };
}
