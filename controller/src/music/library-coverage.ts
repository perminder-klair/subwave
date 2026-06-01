// Library coverage — total Navidrome song count vs tagged tracks, plus
// acoustic-analysis coverage (tracks with bpm/key/intro) against that same
// total.
// `total` requires walking iterateAllSongs() once (one Subsonic call per
// 500-album batch) which is too slow to do per request. We cache the count
// and refresh in the background; the cache is considered stale after 6 h or
// after a manual refresh. Concurrent /coverage requests share the in-flight
// scan via a single promise.

import * as subsonic from './subsonic.js';
import * as library from './library.js';
import * as db from './library-db.js';

const STALE_MS = 6 * 60 * 60 * 1000; // 6 h

interface CoverageCache {
  total: number;
  scannedAt: string | null;
  scanning: boolean;
}

const cache: CoverageCache = { total: 0, scannedAt: null, scanning: false };
let inflight: Promise<void> | null = null;

async function doScan() {
  cache.scanning = true;
  try {
    let count = 0;
    for await (const _song of subsonic.iterateAllSongs()) count++;
    cache.total = count;
    cache.scannedAt = new Date().toISOString();
  } finally {
    cache.scanning = false;
    inflight = null;
  }
}

// Kick off a scan if one isn't running. Non-blocking — callers read the
// current snapshot from get() and poll until scanning flips false.
export function refresh() {
  if (!inflight) inflight = doScan().catch(err => {
    console.error('[library-coverage] scan failed:', err.message);
  });
  return inflight;
}

function isStale() {
  if (!cache.scannedAt) return true;
  return Date.now() - new Date(cache.scannedAt).getTime() > STALE_MS;
}

// Snapshot for the API. Triggers a refresh if the cache is stale or empty.
// Returns total=null/percent=null until the first scan completes — the UI
// uses that as the "scanning…" cue rather than guessing 100%.
export async function get() {
  await library.load();
  if (isStale() && !cache.scanning) refresh();
  const tagged = library.allTaggedIds().length;
  const analysed = db.analysedCount();
  const total = cache.scannedAt ? cache.total : null;
  const percent =
    total != null && total > 0 ? Math.round((tagged / total) * 100) : null;
  const analysedPercent =
    total != null && total > 0 ? Math.round((analysed / total) * 100) : null;
  return {
    tagged,
    analysed,
    total,
    percent,
    analysedPercent,
    scannedAt: cache.scannedAt,
    scanning: cache.scanning,
  };
}
