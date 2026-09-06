// The scheduled backup run — the impure half of the feature (#1570).
//
// Everything that decides ANYTHING lives in ./pure.ts; this file only reads the
// state dir, writes one zip and unlinks the ones retention has retired. It is
// driven by one hourly cron in broadcast/scheduler.ts and is NOT a talk-slot
// concern — nothing here consumes the listener's ear, so it has no business in
// the per-minute talk tick's arbitration (see that file's header).
//
// WHY HOURLY AND NOT "AT 03:00"
// -----------------------------
// A daily cron only fires on a station that happens to be up at that minute.
// Plenty of these run on a laptop or a home box that is off overnight, and a
// backup feature that silently never fires on exactly the installs most likely
// to lose their state dir is worse than no feature. So the tick is cheap and
// hourly, and `backupDue` decides from elapsed time — a station up for one hour
// a day still gets its daily backup.
//
// NOTHING HERE MAY THROW AT ITS CALLER'S EXPENSE
// ----------------------------------------------
// A failed backup is an operator problem, never a scheduler problem: the tick
// must survive a full disk, a read-only mount, a state file that vanished
// mid-sweep. Failures come back as strings in `errors` for the caller to log,
// and one undeletable file does not abandon the rest of the prune.
//
// A FAILING RUN MUST NOT MAKE THINGS WORSE
// ----------------------------------------
// This job writes the largest file the station produces into the directory it
// is protecting, and it retries hourly until it succeeds. Two guards keep a
// failure from compounding into the disk filling up:
//
//   - Every run first sweeps its OWN half-written temps. `writeFileAtomic`
//     removes one when the write itself fails, but a container restart or an
//     OOM kill mid-write gets no such chance, and the leftover is invisible to
//     the restorable listing and to retention alike (neither is a `.zip`).
//   - A free-space pre-flight declines a write that would not fit. The archive
//     is already in memory by then, so the size is known exactly rather than
//     guessed. It FAILS OPEN — an unreadable filesystem means "try the write",
//     because the whole point of the feature is taking the backup.
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
  // An absent block reads as `off` in pure.ts, but short-circuit here too so an
  // upgraded station that never touches this doesn't even readdir the state dir
  // once an hour.
  //
  // This returns BEFORE the temp sweep below, and that is the intended reading
  // of "off means off": a station that never asked for this feature must not
  // have it unlink files, and the readdir it would cost is the whole reason the
  // short-circuit exists. The consequence is small and documented in
  // docs/updating.md — a run killed mid-write before the operator turned the
  // schedule off leaves its `.zip.<hex>.tmp` until the schedule comes back on.
  // It is invisible to `GET /backup/restorable` and to retention alike (neither
  // is a `.zip`), so it costs disk and nothing else.
  if (!cadence || cadence === 'off') return idle('off');

  const errors: string[] = [];
  let names: string[];
  try {
    names = await readdir(STATE_DIR);
  } catch (err: any) {
    return failed(`could not read the state dir: ${err.message}`);
  }

  // Before anything else, and whether or not a backup is due: an earlier run
  // killed mid-write left a partial archive that nothing else in the station
  // will ever look at again. Doing it here rather than only on the writing path
  // means a schedule that has gone quiet (not due for a month) still tidies up
  // after the restart that interrupted it.
  const sweptTemps = await sweepStaleTemps(names, errors);

  const nowMs = now.getTime();
  if (!backupDue({ cadence, lastRunMs: lastScheduledBackupAt(names, nowMs), nowMs })) {
    // Still prune: a retention lowered between runs must take effect now rather
    // than on the next cadence boundary, which for `monthly` is a month of the
    // operator watching the disk not shrink.
    const p = await prune(names, cfg?.keep);
    return { ...idle('not-due'), sweptTemps, pruned: p.pruned, errors: [...errors, ...p.errors] };
  }

  const name = scheduledBackupName(now);
  let bytes = 0;
  try {
    // writeFileAtomic renames a `<name>.<hex>.tmp` into place, which matters
    // twice here: GET /backup/restorable would happily list a half-written
    // `.zip` (the temp name is not one), and a crash mid-write leaves no
    // corrupt restore point behind.
    const buf = (await buildBackupZip()).toBuffer();
    bytes = buf.length;
    const shortfall = freeSpaceShortfall(await freeSpaceBytes(), bytes);
    if (shortfall !== null) {
      // Declining costs the operator this cadence's backup and says so. Writing
      // anyway costs them the station: STATE_DIR is where session.json, the tag
      // DB and the archive live, and a full volume stops all three. No file is
      // written, so no stamp is recorded and the next tick tries again — by
      // which time the sweep above may have freed exactly what was missing.
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
 * Free bytes on the state dir's volume, or NaN when the question cannot be
 * answered — `statfs` is unavailable or meaningless on some mounts. The
 * decision itself, including what an unanswerable NaN means, is
 * `freeSpaceShortfall` in pure.ts.
 */
async function freeSpaceBytes(): Promise<number> {
  try {
    const fs = await statfs(STATE_DIR);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return Number.NaN;
  }
}

// Remove half-written archives from a run that was killed before its rename.
// Only names `isScheduledBackupTempName` recognises — see pure.ts on why that
// set is narrow: every other `*.tmp` in the state dir is another writer's
// in-flight settings.json or session.json.
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

// Delete only what backupsToPrune names — see pure.ts on why that set is
// narrow. Each unlink is guarded on its own: a file the controller cannot
// remove (ownership on a bind mount) must not cost the rest of the sweep.
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
      // ENOENT is not a failure — a concurrent tick or the operator got there
      // first, and the file is gone either way.
      if (err?.code !== 'ENOENT') errors.push(`could not remove ${name}: ${err.message}`);
    }
  }
  return { pruned, errors };
}
