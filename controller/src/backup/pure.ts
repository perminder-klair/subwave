// Scheduled-backup policy: the name grammar, the "is one due?" decision and
// the retention choice. Pure — no clock, no filesystem — so all three are
// pinned by scripts/backup-schedule.test.ts without a state dir (#1570).
//
// THE NAME GRAMMAR IS THE SAFETY PROPERTY
// ---------------------------------------
// Retention deletes files. `GET /backup/restorable` lists EVERY top-level
// `*.zip` in STATE_DIR (isSafeBackupName), which is exactly what makes the
// disk-restore escape hatch work: an operator copies a zip in by hand and it
// shows up. So a prune that reasoned over that same set — or over any `*.zip`
// glob — would eventually delete the hand-copied restore point someone dropped
// in ten minutes ago, which is the worst thing this feature could do.
//
// Hence a name only the scheduled writer produces:
//
//     subwave-auto-backup-YYYY-MM-DD-HHMMSS.zip
//
// deliberately NOT a suffix of the manual export's `subwave-backup-<date>.zip`
// (an anchored regex, so `my-subwave-auto-backup-….zip` is not ours either).
// `backupsToPrune` only ever names files matching it, and everything else in
// the state dir is invisible to this module. Widening the pattern to catch
// "backups from an older version" is the bug: an older version wrote none.
//
// The name also carries the clock, which is why there is no `last-backup.json`
// beside it: the newest scheduled file IS the record of the last run. That
// falls the right way on its own — a run that fails writes nothing, so the next
// tick still reads the older stamp and retries, rather than a marker file
// claiming success for a backup that isn't there.

import { BACKUP_KEEP_BOUNDS, SETTINGS_BACKUP_CADENCES } from '../schemas/settings.js';

// The vocabulary and the bound live in the mirrored schema, never a copy: the
// save path, the browser pre-flight and this module all have to agree, and the
// admin select is built from the same list.
export type BackupCadence = (typeof SETTINGS_BACKUP_CADENCES)[number];

/** Anchored — the whole basename or nothing. See the header. */
export const SCHEDULED_BACKUP_RE =
  /^subwave-auto-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/;

const DAY_MS = 86_400_000;

// How often each cadence comes round. `monthly` is 30 days rather than a
// calendar month on purpose: the decision below is elapsed-time arithmetic on
// UTC stamps, and a calendar step would drag DST and the station timezone into
// a retention job that has no listener-facing clock to be right about.
export const BACKUP_CADENCE_DAYS: Readonly<Record<string, number>> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// The tick that asks this question is hourly, so a strict `>= interval` walks
// the run time forward by up to an hour every cycle (04:23 → 05:23 → …). Half
// a tick of slack pins a daily backup to the same minute each day instead. It
// can never make two runs land in one tick: the shortest interval is 24h and
// the slack is 30 minutes.
export const BACKUP_DUE_SLACK_MS = 30 * 60_000;

export function isScheduledBackupName(name: unknown): boolean {
  return typeof name === 'string' && SCHEDULED_BACKUP_RE.test(name);
}

/** The name a run at `now` writes. UTC, so the sort order is the time order. */
export function scheduledBackupName(now: Date): string {
  const iso = now.toISOString(); // 2026-09-06T04:23:17.123Z
  return `subwave-auto-backup-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}.zip`;
}

/**
 * The instant encoded in a scheduled backup's name, or null.
 *
 * Null for anything that isn't ours AND for a name that matches the shape but
 * names no real instant (`…-2026-13-45-999999.zip`). The two are different
 * facts — such a file is still ours to prune — so pruning keys on the NAME and
 * only the due decision keys on this.
 */
export function scheduledBackupStamp(name: string): number | null {
  const m = SCHEDULED_BACKUP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When the last scheduled backup ran, read off the file names.
 *
 * A stamp in the FUTURE is ignored rather than trusted. A clock that was wrong
 * once (a container booting before NTP, a restored state dir from another box)
 * would otherwise leave a file dated 2031 sitting in the dir, and every tick
 * from now until then would compute a negative elapsed time and decline to back
 * up — silently, for years. Ignoring it fails toward taking a backup, which is
 * the safe direction for this feature.
 */
export function lastScheduledBackupAt(names: readonly string[], nowMs: number): number | null {
  let latest: number | null = null;
  for (const name of names) {
    const ms = scheduledBackupStamp(name);
    if (ms === null || ms > nowMs) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/**
 * Is a scheduled backup due?
 *
 * An unrecognised cadence is `off`. That is the CLAUDE.md rule about absent or
 * malformed settings coercing to the pre-existing behaviour, and here it is the
 * whole safety story for the feature: a station that upgrades and changes
 * nothing has no `backups` block at all, reads as `off`, and never writes a
 * byte.
 *
 * A cadence that IS set with no previous backup on disk is due immediately —
 * the operator turning this on wants a backup, not one a month from now.
 */
export function backupDue({
  cadence,
  lastRunMs,
  nowMs,
}: {
  cadence: unknown;
  lastRunMs: number | null;
  nowMs: number;
}): boolean {
  const days = typeof cadence === 'string' ? BACKUP_CADENCE_DAYS[cadence] : undefined;
  if (!days) return false;
  if (lastRunMs === null) return true;
  return nowMs - lastRunMs >= days * DAY_MS - BACKUP_DUE_SLACK_MS;
}

/**
 * Which files retention deletes, newest-first over the SCHEDULED backups only.
 *
 * `names` is whatever `readdir(STATE_DIR)` returned — settings.json, the tag
 * DB, an operator's hand-copied restore zip, all of it. Everything that is not
 * ours by the grammar above is dropped before anything is counted, so a station
 * with `keep: 1` and forty hand-copied zips still deletes only its own.
 *
 * The sort is lexicographic on the name, which is the time order because the
 * stamp is fixed-width UTC — no Date parsing, so a name with an impossible date
 * still lands in a stable place instead of vanishing from the count and living
 * forever.
 */
export function backupsToPrune(names: readonly string[], keep: number): string[] {
  const bounded = Number.isFinite(keep)
    ? Math.min(BACKUP_KEEP_BOUNDS.max, Math.max(BACKUP_KEEP_BOUNDS.min, Math.floor(keep)))
    : BACKUP_KEEP_BOUNDS.min;
  const ours = names.filter(isScheduledBackupName).sort().reverse();
  return ours.slice(bounded);
}
