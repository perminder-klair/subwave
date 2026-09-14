// The scheduled backup run — the impure half of the feature (#1570). Every
// decision lives in ./pure.ts; this file reads the state dir, writes one zip and
// unlinks what retention retired.
//
// Driven by one HOURLY cron in broadcast/scheduler.ts, not a talk slot and not a
// nightly one: `backupDue` decides from elapsed time, so a station up an hour a
// day still gets its daily backup.
//
// Nothing here may throw at its caller's expense — failures come back as strings
// in `errors`, and one undeletable file does not abandon the rest of the prune.
// Two guards stop a failing run from filling the disk it protects: every run
// first sweeps its OWN half-written temps (a killed run gets no unlink), and a
// free-space pre-flight declines a write that would not fit. That pre-flight
// FAILS OPEN — an unmeasurable filesystem still gets the write attempted.
import { readdir, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { buildBackupZip } from './zip.js';
import {
  backupDue,
  backupsToPrune,
  isScheduledBackupTempName,
  lastScheduledBackupAt,
  scheduledBackupName,
  FREE_SPACE_HEADROOM_BYTES,
  freeSpaceShortfall,
} from './pure.js';

export interface ScheduledBackupResult {
  /** Why the tick did nothing, or null when it wrote a backup. */
  skipped: 'off' | 'not-due' | null;
  /** The file written, or null. */
  written: string | null;
  /** Bytes written, for the log line. */
  bytes: number;
  /** Files retention removed. */
  pruned: string[];
  /** Half-written temps from a killed earlier run, cleaned up on the way in. */
  sweptTemps: string[];
  /** Human-readable failures. Non-empty does not mean nothing was written. */
  errors: string[];
}

/** Nothing to do, and nothing went wrong: the schedule is off, or not yet due. */
const idle = (skipped: NonNullable<ScheduledBackupResult['skipped']>): ScheduledBackupResult => ({
  skipped, written: null, bytes: 0, pruned: [], sweptTemps: [], errors: [],
});

/** The run was due and did not produce a backup. `skipped` is null: it tried. */
const failed = (message: string): ScheduledBackupResult => ({
  skipped: null, written: null, bytes: 0, pruned: [], sweptTemps: [], errors: [message],
});

/**
 * Take a scheduled backup if one is due, then apply retention.
 *
 * `now` is injectable so a test can drive the cadence without waiting a day.
 */
export async function runScheduledBackup(now: Date = new Date()): Promise<ScheduledBackupResult> {
  const cfg = settings.get()?.backups;
  const cadence = cfg?.cadence;
  // Short-circuit before the readdir AND before the temp sweep: a station that
  // never asked for this feature must not unlink files or pay a readdir an hour.
  // Cost is a temp left by a run killed before the schedule was turned off
  // (documented in docs/updating.md); it is invisible to the restorable listing.
  if (!cadence || cadence === 'off') return idle('off');

  const errors: string[] = [];
  let names: string[];
  try {
    names = await readdir(STATE_DIR);
  } catch (err: any) {
    return failed(`could not read the state dir: ${err.message}`);
  }

  // Runs whether or not a backup is due, so a quiet schedule still tidies up
  // after the restart that interrupted an earlier run.
  const sweptTemps = await sweepStaleTemps(names, errors);

  const nowMs = now.getTime();
  if (!backupDue({ cadence, lastRunMs: lastScheduledBackupAt(names, nowMs), nowMs })) {
    // Still prune: a retention lowered between runs must take effect now, not on
    // the next cadence boundary.
    const p = await prune(names, cfg?.keep);
    return { ...idle('not-due'), sweptTemps, pruned: p.pruned, errors: [...errors, ...p.errors] };
  }

  const name = scheduledBackupName(now);
  let bytes = 0;
  try {
    // writeFileAtomic renames a `<name>.<hex>.tmp` into place, so a half-written
    // archive is never listed by GET /backup/restorable and a crash mid-write
    // leaves no corrupt restore point.
    const buf = (await buildBackupZip()).toBuffer();
    bytes = buf.length;
    const shortfall = freeSpaceShortfall(await freeSpaceBytes(), bytes);
    if (shortfall !== null) {
      // No file is written, so no stamp is recorded and the next tick retries.
      const why = `backup skipped — needs ${mb(bytes)} MB plus ${mb(FREE_SPACE_HEADROOM_BYTES)} MB `
        + `headroom, ${mb(shortfall)} MB short on ${STATE_DIR}`;
      return { ...failed(why), sweptTemps, errors: [...errors, why] };
    }
    await writeFileAtomic(join(STATE_DIR, name), buf);
  } catch (err: any) {
    // No file was written, so no stamp was recorded and the next tick retries.
    const why = `backup failed: ${err.message}`;
    return { ...failed(why), sweptTemps, errors: [...errors, why] };
  }

  // Re-list rather than appending to `names`: the write just changed the dir,
  // and the prune must count the file it just created.
  const after = await readdir(STATE_DIR).catch((err: any) => {
    errors.push(`retention skipped — could not re-read the state dir: ${err.message}`);
    return null;
  });
  const pruneResult = after ? await prune(after, cfg?.keep) : { pruned: [], errors: [] };

  return {
    skipped: null,
    written: name,
    bytes,
    pruned: pruneResult.pruned,
    sweptTemps,
    errors: [...errors, ...pruneResult.errors],
  };
}

const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

/**
 * Free bytes on the state dir's volume, or NaN when `statfs` cannot answer. What
 * an unanswerable NaN means is `freeSpaceShortfall`'s decision, in pure.ts.
 */
async function freeSpaceBytes(): Promise<number> {
  try {
    const fs = await statfs(STATE_DIR);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return Number.NaN;
  }
}

// Remove half-written archives from a run killed before its rename. Only names
// `isScheduledBackupTempName` recognises — every other `*.tmp` in the state dir
// is another writer's in-flight file.
async function sweepStaleTemps(names: readonly string[], errors: string[]): Promise<string[]> {
  const swept: string[] = [];
  for (const name of names.filter(isScheduledBackupTempName)) {
    try {
      await unlink(join(STATE_DIR, name));
      swept.push(name);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') errors.push(`could not remove stale temp ${name}: ${err.message}`);
    }
  }
  return swept;
}

// Delete only what backupsToPrune names. Each unlink is guarded on its own: an
// unremovable file must not cost the rest of the sweep.
async function prune(
  names: readonly string[],
  keep: unknown,
): Promise<{ pruned: string[]; errors: string[] }> {
  const pruned: string[] = [];
  const errors: string[] = [];
  for (const name of backupsToPrune(names, keep)) {
    try {
      await unlink(join(STATE_DIR, name));
      pruned.push(name);
    } catch (err: any) {
      // ENOENT is not a failure: the file is gone either way.
      if (err?.code !== 'ENOENT') errors.push(`could not remove ${name}: ${err.message}`);
    }
  }
  return { pruned, errors };
}
