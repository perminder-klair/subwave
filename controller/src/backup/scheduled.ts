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
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import * as settings from '../settings.js';
import { writeFileAtomic } from '../util/atomic-file.js';
import { buildBackupZip } from './zip.js';
import {
  backupDue,
  backupsToPrune,
  lastScheduledBackupAt,
  scheduledBackupName,
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
  /** Human-readable failures. Non-empty does not mean nothing was written. */
  errors: string[];
}

const NOTHING = (skipped: ScheduledBackupResult['skipped']): ScheduledBackupResult => ({
  skipped, written: null, bytes: 0, pruned: [], errors: [],
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
  if (!cadence || cadence === 'off') return NOTHING('off');

  const errors: string[] = [];
  let names: string[];
  try {
    names = await readdir(STATE_DIR);
  } catch (err: any) {
    return { ...NOTHING(null), errors: [`could not read the state dir: ${err.message}`] };
  }

  const nowMs = now.getTime();
  if (!backupDue({ cadence, lastRunMs: lastScheduledBackupAt(names, nowMs), nowMs })) {
    // Still prune: a retention lowered between runs must take effect now rather
    // than on the next cadence boundary, which for `monthly` is a month of the
    // operator watching the disk not shrink.
    return { ...NOTHING('not-due'), ...(await prune(names, cfg?.keep)) };
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
    await writeFileAtomic(join(STATE_DIR, name), buf);
  } catch (err: any) {
    // No file was written, so no stamp was recorded and the next tick retries.
    return { ...NOTHING(null), errors: [`backup failed: ${err.message}`] };
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
    errors: [...errors, ...pruneResult.errors],
  };
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
  for (const name of backupsToPrune(names, Number(keep))) {
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
