// Scheduled-backup policy: the name grammar, the "is one due?" decision and the
// retention choice. Pure, so pinned by scripts/backup-schedule.test.ts without a
// state dir (#1570).
//
// The name grammar is the safety property. Retention DELETES, while
// `GET /backup/restorable` lists every top-level `*.zip` in STATE_DIR so an
// operator can hand-copy a restore point in. So only a name this writer could
// have produced is ours to touch — `subwave-auto-backup-YYYY-MM-DD-HHMMSS.zip`,
// anchored, and deliberately not a suffix of the manual export's
// `subwave-backup-<date>.zip`. Never widen the pattern.
//
// The name also carries the clock, so there is no marker file: the newest
// scheduled file IS the record of the last run, and a failed run leaves nothing
// claiming success.

import { clampBackupKeep, type BackupCadence } from '../schemas/settings.js';

// Vocabulary, bound and clamp live in the mirrored schema, never a copy — the
// save path, the browser pre-flight and this module must agree.
export type { BackupCadence };

// The one spelling of the name; both patterns below anchor it rather than
// restating it, since the sweep keys on one and the prune on the other.
const SCHEDULED_BACKUP_STEM =
  String.raw`subwave-auto-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.zip`;

/** Anchored: the whole basename or nothing. */
export const SCHEDULED_BACKUP_RE = new RegExp(`^${SCHEDULED_BACKUP_STEM}$`);

/**
 * The half-written form: `writeFileAtomic` writes `<target>.<hex>.tmp`, so a run
 * killed mid-write leaves one behind. Anchored on the same stem because every
 * other `*.tmp` in the state dir (settings.json, session.json) belongs to another
 * writer and must never be swept.
 */
export const SCHEDULED_BACKUP_TMP_RE =
  new RegExp(String.raw`^${SCHEDULED_BACKUP_STEM}\.[0-9a-f]+\.tmp$`);

const DAY_MS = 86_400_000;

// How often each cadence comes round. `monthly` is 30 days, not a calendar
// month: the decision below is elapsed-time arithmetic on UTC stamps.
export const BACKUP_CADENCE_DAYS: Readonly<Record<string, number>> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// The tick is hourly, so a strict `>= interval` would walk the run time forward
// by up to an hour every cycle. Half a tick of slack pins it to the same minute
// instead, and can't make two runs land in one tick (shortest interval is 24h).
export const BACKUP_DUE_SLACK_MS = 30 * 60_000;

export function isScheduledBackupName(name: unknown): boolean {
  return typeof name === 'string' && SCHEDULED_BACKUP_RE.test(name);
}

/** A temp file only the scheduled writer could have dropped. */
export function isScheduledBackupTempName(name: unknown): boolean {
  return typeof name === 'string' && SCHEDULED_BACKUP_TMP_RE.test(name);
}

/** The name a run at `now` writes. UTC, so the sort order is the time order. */
export function scheduledBackupName(now: Date): string {
  const iso = now.toISOString(); // 2026-09-06T04:23:17.123Z
  return `subwave-auto-backup-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}.zip`;
}

/**
 * The instant encoded in a scheduled backup's name, or null — for anything not
 * ours AND for a name matching the shape but naming no real instant. Such a file
 * is still ours to prune, so pruning keys on the NAME and only the due decision
 * keys on this.
 */
export function scheduledBackupStamp(name: string): number | null {
  const m = SCHEDULED_BACKUP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When the last scheduled backup ran, read off the file names. A stamp in the
 * FUTURE is ignored rather than trusted — a clock that was wrong once would
 * otherwise suppress every backup until it caught up. Fails toward backing up.
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
 * Is a scheduled backup due? An unrecognised cadence is `off`, so a station that
 * upgrades and changes nothing never writes a byte. A cadence that IS set with
 * no previous backup on disk is due immediately.
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
 * Headroom kept free beyond the archive itself, so a scheduled backup can never
 * be the write that takes the last byte on the station's volume. Decimal MB, not
 * MiB, because the operator reads this figure back out of an error message
 * rendered by the same divisor.
 */
export const FREE_SPACE_HEADROOM_BYTES = 64_000_000;

/**
 * How many bytes short `freeBytes` is of `needBytes` plus the headroom, or null
 * when it fits — and null ALSO when the free figure is unusable. That second null
 * is the fail-open: an unmeasurable filesystem still gets the write attempted.
 */
export function freeSpaceShortfall(freeBytes: number, needBytes: number): number | null {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return null;
  if (!Number.isFinite(needBytes) || needBytes < 0) return null;
  const need = needBytes + FREE_SPACE_HEADROOM_BYTES;
  return freeBytes < need ? need - freeBytes : null;
}

/**
 * Which files retention deletes, newest-first over the SCHEDULED backups only.
 * `names` is the whole readdir, so everything not ours by the grammar above is
 * dropped before anything is counted.
 *
 * Sorted lexicographically on the name, which is the time order (fixed-width UTC)
 * — never on a parsed date, so a file stamped in the FUTURE is kept until the
 * clock catches up rather than deleted on the strength of a clock that has
 * already been wrong. An unreadable `keep` falls to the shipped default via
 * `clampBackupKeep`, not to the floor of 1.
 */
export function backupsToPrune(names: readonly string[], keep: unknown): string[] {
  const ours = names.filter(isScheduledBackupName).sort().reverse();
  return ours.slice(clampBackupKeep(keep));
}
