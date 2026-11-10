// Completion policy for library-maintenance children. The ID journal must be
// settled before any consumer rebuilds from the migrated library. Successful
// catalogue walks then refresh auto.m3u immediately so Liquidsoap cannot keep
// coasting on pre-migration IDs until the hourly scheduler tick.

export type MaintenanceMode = 'tag' | 'analyze' | 'reconcile';
export type MaintenanceOutcome = 'ok' | 'failed' | 'stopped';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function refreshTaggerFallback(opts: {
  rotationSettled: boolean;
  invalidatePools: () => Promise<void> | void;
  refreshAutoPlaylist: () => Promise<unknown>;
  logError: (message: string) => void;
}): Promise<boolean> {
  if (!opts.rotationSettled) return false;
  try {
    await opts.invalidatePools();
    await opts.refreshAutoPlaylist();
    return true;
  } catch (err: unknown) {
    opts.logError(`post-maintenance auto-playlist refresh failed: ${errorMessage(err)}`);
    return false;
  }
}

export async function runTaggerFollowups(opts: {
  mode: MaintenanceMode;
  outcome: MaintenanceOutcome;
  rotationSettled: boolean;
  fallbackRefreshed?: boolean;
  invalidatePools: () => Promise<void> | void;
  syncPlaylists: () => Promise<void>;
  refreshAutoPlaylist: () => Promise<unknown>;
  logError: (message: string) => void;
}): Promise<boolean> {
  if (!opts.rotationSettled || opts.outcome !== 'ok') return false;

  // The normal admin analyzer does not walk an already-populated catalogue, so
  // it cannot discover or adopt rotated IDs. Tag and reconcile both do. Rebuild
  // the on-air fallback before recipe maintenance: a large recipe set must not
  // prolong starvation after the catalogue itself is already repaired.
  let fallbackRefreshed = opts.fallbackRefreshed === true;
  if (opts.mode !== 'analyze' && !fallbackRefreshed) {
    fallbackRefreshed = await refreshTaggerFallback(opts);
  }

  try {
    await opts.syncPlaylists();
  } catch (err: unknown) {
    opts.logError(`post-maintenance playlist sync failed: ${errorMessage(err)}`);
  }
  return fallbackRefreshed;
}
