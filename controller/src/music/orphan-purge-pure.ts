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
// bad assumption (a half-finished Navidrome scan, say) loses no stems and the
// track's blends work again at once. It does not save the Demucs run. An id is
// only an orphan once its row is gone, so it comes back as a new row with no
// analysis: the first pass analyses it, stems ride along with that analysis
// for an existing dir (analyze.ts allocateStems) and rewrite it, and with the
// stem cache off the vocal facet still separates unless the lyrics decide it.
//
// A returning id is not proof of returning audio. Navidrome derives the id from
// the path, so a different recording put back at the same path comes back
// under the same id, and the new row has no stored size for the replaced-file
// check to compare (#2224). If that row is analysed while the cache is at its
// budget, it gets no stems of its own, its slot stays free, and a release would
// hand it the old recording's stems: a blend renders its seam from those files,
// so the old audio airs, and the stems_at stamp keeps the backfill away for
// good. So a release also needs sameAudio below, and fails closed.
//
// Deletions are additionally gated on `confirm`: an unconfirmed pass plans,
// counts and reports — the dry run an operator reads before the first real
// pass. The same flag releases quarantines, deletes aged quarantines and, in a
// dry run, reports what would happen without naming any of it as done.

export const QUARANTINE_DIR = '.orphan-quarantine';

/** Sidecar stamped into a quarantine entry at move time. */
export const ORPHANED_AT = '.orphaned-at';

/** Sidecar written into a stem dir at quarantine time. Dot-prefixed so every
 *  existing walk that filters dot-entries keeps ignoring it. */
export const NAME_SIDECAR = '.track-meta.json';

// What the analyzer writes into a track's dir (write_stems, write_tail_meta,
// write_head_meta): <window>-<stem>.flac, tail-meta.json and head-meta.json
// (the windows' provenance stamps, #2238), each through a .tmp a crash can
// leave behind. The stem is the model's own source name, not a fixed four: a
// non-default DEMUCS_MODEL writes guitar and piano too.
const STEM_FILE = /^(?:(?:head|tail)-[a-z0-9_]+\.flac|(?:head|tail)-meta\.json)(?:\.tmp)?$/;

/**
 * Pure: do these directory entries read as a track's stem dir? "Not a known id"
 * alone is not an orphan, because a share holds things SUB/WAVE never wrote
 * (`lost+found`, `@eaDir`, `#recycle`, an operator's folder) and a purge only
 * deletes what it can name as its own. So: at least one stem file, nothing but
 * stem files and the purge's sidecars, and no subdirectory. An empty dir does
 * not qualify, because `lost+found` usually is one.
 */
export function isStemDirListing(entries: ReadonlyArray<{ name: string; isDirectory: boolean }>): boolean {
  let stemFiles = 0;
  for (const e of entries) {
    if (e.isDirectory) return false;
    if (STEM_FILE.test(e.name)) stemFiles += 1;
    else if (e.name !== ORPHANED_AT && e.name !== NAME_SIDECAR) return false;
  }
  return stemFiles > 0;
}

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

/** The stems' own record of the audio they were cut from (write_tail_meta). */
export const TAIL_META = 'tail-meta.json';

/**
 * How far apart two readings of one file's duration can be. The stems carry
 * the DECODED duration (tail-meta.json's `duration_sec`), the library row the
 * Subsonic one, an integer that the analyzer measured disagreeing by up to ~1 s
 * (analyze_worker.py write_tail_meta).
 */
export const SAME_AUDIO_TOLERANCE_SEC = 2;

const positiveSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Pure: are a quarantined stem set and the row that came back for its id the
 * same audio? Judged on duration, the one fact both sides hold: the stems'
 * tail-meta.json against the row's duration_sec, within the tolerance above.
 * Fails closed. A side with no duration proves nothing: a head-only set has no
 * tail-meta.json (a capped download never proves a tail), and a server can
 * omit the duration. Withholding a release costs a separation; a wrong one
 * airs another recording's stems.
 */
export function sameAudio(stemsDurationSec: unknown, rowDurationSec: unknown): boolean {
  if (!positiveSeconds(stemsDurationSec) || !positiveSeconds(rowDurationSec)) return false;
  return Math.abs(stemsDurationSec - rowDurationSec) <= SAME_AUDIO_TOLERANCE_SEC;
}

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
  /** Roll-up count so callers log without re-counting. */
  quarantined: number;
  keptCount: number;
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
  /**
   * Whether the stems are proven to be the audio of the row that came back
   * (sameAudio). Read only for a known entry whose live slot is free, and
   * false for every other entry, where nothing asks.
   */
  sameAudio: boolean;
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
  /** Ids that came back with the live slot free, but whose stems are not proven
   *  to be the returning audio (sameAudio): never released, they age out. */
  mismatched: string[];
  deletedCount: number;
}

export function planOrphanPurge(
  entries: readonly CacheEntry[],
  { confirm }: { confirm: boolean },
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
    quarantined: quarantine.length,
    keptCount: kept.length,
  };
}

export function planQuarantinePurge(
  entries: readonly QuarantineEntry[],
  { confirm, graceMs = QUARANTINE_GRACE_MS }: { confirm: boolean; graceMs?: number },
): QuarantinePlan {
  const released: string[] = [];
  const deleted: Array<{ name: string }> = [];
  const aging: Array<{ name: string; remainingMs: number }> = [];
  const superseded: string[] = [];
  const mismatched: string[] = [];
  for (const e of entries) {
    if (e.known) {
      // The id is back. Give the quarantine copy back when the live slot is
      // free and the copy is proven to be the returning audio. When a fresh
      // analysis already filled the slot, the quarantine is the stale copy;
      // when the audio is not proven the same, it may be another recording's.
      // Either way it ages out like any other.
      if (e.liveSlotFree && e.sameAudio) {
        released.push(e.name);
        continue;
      }
      if (e.liveSlotFree) mismatched.push(e.name);
      else superseded.push(e.name);
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
    mismatched,
    deletedCount: deleted.length,
  };
}
