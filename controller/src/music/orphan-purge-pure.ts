// Automatic orphan-stem purge: the decisions, with no filesystem.
//
// The stem cache root holds one directory per track id. Two things make a
// directory an orphan: the track left the library (a Navidrome deletion), or
// an id rotation left a copy behind. Nothing reclaims them today: sweep()
// evicts only over the byte budget and never looks at the library, so on a
// cache comfortably inside budget orphans age forever (measured on production:
// 157 dirs / 1.9 GB, 8–25 days old).
//
// The purge never deletes an orphan directly. It MOVES it into a dot-directory
// at the cache root (QUARANTINE_DIR — hidden from scanDirs and every walk that
// skips dot names), and only a quarantine that has aged past QUARANTINE_GRACE_MS
// is deleted. The quarantine is also the recovery path: an id that walks back
// into the library gets its directory moved back, so a purge that fired on a
// bad assumption (a half-finished Navidrome scan, say) costs a re-link, not
// Demucs minutes.
//
// Deletions are additionally gated on `confirm`: an unconfirmed pass plans,
// counts and reports — the dry run an operator reads before the first real
// pass. The same flag releases quarantines, deletes aged quarantines and, in a
// dry run, reports what would happen without naming any of it as done.

export const QUARANTINE_DIR = '.orphan-quarantine';

/** Directories newer than this are treated as in-flight analyzer writes. */
export const IN_FLIGHT_MS = 3600_000;

/**
 * The automatic pass's ceiling: it refuses to quarantine more than this share
 * of the cache root in one go (and at least AUTO_MAX_MIN_DIRS dirs), leaving a
 * move that large to an operator's confirm. A library table only partly
 * filled (a reset, a scan still running) reads like mass deletion, and a
 * nightly pass must not act on that reading by itself.
 */
export const AUTO_MAX_SHARE = 0.2;
export const AUTO_MAX_MIN_DIRS = 100;

/** Pure: does an automatic pass's plan exceed its ceiling? */
export function exceedsAutoCeiling(quarantine: number, kept: number): boolean {
  const total = quarantine + kept;
  return quarantine >= AUTO_MAX_MIN_DIRS && total > 0 && quarantine / total > AUTO_MAX_SHARE;
}
export const QUARANTINE_GRACE_MS = 7 * 24 * 3600_000;

export interface CacheEntry {
  /** Directory name at the cache root (a sanitised track id). */
  name: string;
  /** Whether the id still has a row in the library. */
  known: boolean;
}

export interface OrphanPlan {
  dryRun: boolean;
  /** Orphans to move into quarantine (in a dry run: would move). */
  quarantine: Array<{ name: string }>;
  /** Library-known dirs left alone. */
  kept: string[];
  /** Always empty for a first pass: nothing is released from a cache walk. */
  released: string[];
  /** Roll-up count so callers log without re-counting. */
  quarantined: number;
  keptCount: number;
  /** Bytes the plan would free (deletions only); the IO layer fills it. */
  freedBytes: number;
}

export interface QuarantineEntry {
  /** Directory name inside the quarantine. */
  name: string;
  /** Whether the id is in the library again. */
  known: boolean;
  /** Time since the directory entered the quarantine. */
  ageMs: number;
  /**
   * Whether the live cache slot for this id is free. It is free almost always
   * (a quarantine is a move, so exactly one copy exists) — but if the track
   * was re-analysed while quarantined, the fresh copy owns the live slot and
   * the quarantine must be deleted, never moved over it.
   */
  liveSlotFree: boolean;
}

export interface QuarantinePlan {
  dryRun: boolean;
  /** Quarantine entries kept untouched (younger than grace, or superseded-with-slot logic); names for the report. */
  kept: string[];
  /** Quarantined ids whose track is back in the library and whose live slot is free: move back. */
  released: string[];
  /** Aged quarantines to delete (in a dry run: would delete). */
  deleted: Array<{ name: string }>;
  /** Quarantines still inside the grace period. */
  aging: Array<{ name: string; remainingMs: number }>;
  /** Ids that came back in the library while the live slot is taken: the quarantine is stale either way. */
  superseded: string[];
  deletedCount: number;
  freedBytes: number;
}

export function planOrphanPurge(
  entries: readonly CacheEntry[],
  { now: _now, confirm }: { now: number; confirm: boolean },
): OrphanPlan {
  const quarantine: Array<{ name: string }> = [];
  const kept: string[] = [];
  for (const e of entries) {
    if (e.known) kept.push(e.name);
    else quarantine.push({ name: e.name });
  }
  return {
    dryRun: !confirm,
    quarantine,
    kept,
    released: [],
    quarantined: quarantine.length,
    keptCount: kept.length,
    freedBytes: 0,
  };
}

export function planQuarantinePurge(
  entries: readonly QuarantineEntry[],
  { now: _now, confirm, graceMs = QUARANTINE_GRACE_MS }: { now: number; confirm: boolean; graceMs?: number },
): QuarantinePlan {
  const released: string[] = [];
  const deleted: Array<{ name: string }> = [];
  const aging: Array<{ name: string; remainingMs: number }> = [];
  const superseded: string[] = [];
  for (const e of entries) {
    if (e.known) {
      // The track is back. Give the quarantine copy back when the live slot
      // is free; when a fresh analysis already filled it, the quarantine is
      // the stale copy and ages out like any other.
      if (e.liveSlotFree) {
        released.push(e.name);
        continue;
      }
      superseded.push(e.name);
    }
    if (e.ageMs >= graceMs) deleted.push({ name: e.name });
    else aging.push({ name: e.name, remainingMs: graceMs - e.ageMs });
  }
  const kept = [...aging.map(a => a.name), ...superseded.filter(n => deleted.every(d => d.name !== n))];
  return {
    dryRun: !confirm,
    kept,
    released,
    deleted,
    aging,
    superseded,
    deletedCount: deleted.length,
    freedBytes: 0, // filled by the IO layer, which is the only one that can measure
  };
}
