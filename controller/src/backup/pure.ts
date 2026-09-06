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

import { clampBackupKeep, type BackupCadence } from '../schemas/settings.js';

// The vocabulary, the bound and the clamp all live in the mirrored schema,
// never a copy: the save path, the browser pre-flight and this module have to
// agree, and the admin select is built from the same list.
export type { BackupCadence };

// The one spelling of the name. Both patterns below anchor it rather than
// restating it, so the finished form and the half-written form cannot drift
// apart — and they must not: the sweep keys on one, the prune on the other, and
// each of them DELETES.
const SCHEDULED_BACKUP_STEM =
  String.raw`subwave-auto-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.zip`;

/** Anchored — the whole basename or nothing. See the header. */
export const SCHEDULED_BACKUP_RE = new RegExp(`^${SCHEDULED_BACKUP_STEM}$`);

/**
 * The half-written form of the same name: `writeFileAtomic` writes
 * `<target>.<hex>.tmp` and renames it into place, so a run killed mid-write
 * (a container restart, an OOM) leaves one of these behind.
 *
 * It gets its own anchored pattern, built from the same stem, for the same
 * reason the finished name has one: the sweep that removes these DELETES, and
 * every other `*.tmp` in the state dir belongs to another writer — settings.json
 * and session.json are written the same way, and eating one of those mid-flight
 * would be a far worse bug than the leak this fixes. Only a name this writer
 * could itself have produced is ours to remove.
 */
export const SCHEDULED_BACKUP_TMP_RE =
  new RegExp(String.raw`^${SCHEDULED_BACKUP_STEM}\.[0-9a-f]+\.tmp$`);

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

/** A temp file only the scheduled writer could have dropped. See the pattern. */
export function isScheduledBackupTempName(name: unknown): boolean {
  return typeof name === 'string' && SCHEDULED_BACKUP_TMP_RE.test(name);
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
 *
 * A file stamped in the FUTURE therefore sorts first and is kept until the
 * clock catches up, costing one slot of the operator's N. That is deliberate,
 * and it is the pair of `lastScheduledBackupAt` ignoring the same file: there
 * the safe direction is "take a backup anyway", here it is "do not delete a
 * real snapshot because its name disagrees with a clock that has already been
 * wrong once". Ranking by anything but the name would mean deleting files on
 * the strength of that clock.
 *
 * An unreadable `keep` falls to the shipped default via `clampBackupKeep`, NOT
 * to the floor of 1 — the same answer `settings.load()`'s normaliser gives, so
 * the module that deletes cannot be the one that guesses most destructively.
 */
/**
 * Headroom kept free beyond the archive itself, so a scheduled backup can never
 * be the write that takes the last byte on the volume the station runs from.
 *
 * Decimal MB, not MiB, because the operator reads this number back out of an
 * error message rendered by the same divisor. 64 * 1024 * 1024 would be a
 * constant that says 64 and a message that says 67.
 */
export const FREE_SPACE_HEADROOM_BYTES = 64_000_000;

/**
 * How many bytes short `freeBytes` is of holding `needBytes` plus the headroom,
 * or null when it fits — and null ALSO when the free figure is unusable.
 *
 * That second null is the fail-open: `statfs` is meaningless or unavailable on
 * some mounts, and the feature's whole job is taking the backup, so a
 * filesystem we cannot measure gets the write attempted. Only a filesystem we
 * CAN measure, and which genuinely will not fit it, declines — because
 * STATE_DIR is also where session.json, the tag DB and the archive live, and
 * filling it stops all three.
 */
export function freeSpaceShortfall(freeBytes: number, needBytes: number): number | null {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return null;
  if (!Number.isFinite(needBytes) || needBytes < 0) return null;
  const need = needBytes + FREE_SPACE_HEADROOM_BYTES;
  return freeBytes < need ? need - freeBytes : null;
}

export function backupsToPrune(names: readonly string[], keep: unknown): string[] {
  const ours = names.filter(isScheduledBackupName).sort().reverse();
  return ours.slice(clampBackupKeep(keep));
}
