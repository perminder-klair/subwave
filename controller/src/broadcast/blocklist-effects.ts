// What the station does after the never-play list changes, decided once for every
// writer: an entry or a rule added or edited (routes/library/blocklist.ts), and a
// list restored from a backup (routes/backup.ts). The upcoming queue drops the
// tracks the list now blocks, and the coast playlist (auto.m3u) is rebuilt, or a
// blocked track still airs from either until its next refresh.

import { queue } from './queue.js';
import { refreshAutoPlaylist } from './scheduler.js';

// The rebuild, behind an object so a test can watch it without a music server.
export const blocklistEffects = {
  refreshAutoPlaylist: (): Promise<unknown> => refreshAutoPlaylist(),
};

/** Purge the queue now and rebuild the coast playlist in the background. Returns how many queued tracks dropped. */
export function applyBlocklistChange(): number {
  const purged = queue.purgeBlocked();
  blocklistEffects.refreshAutoPlaylist().catch((err: Error) =>
    queue.log('error', `blocklist auto-playlist refresh failed: ${err.message}`));
  return purged;
}
