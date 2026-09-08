// settings.backups — scheduled, rotating config backups (#1570). Two decisions
// carry the feature and both fail silently in the field: retention may only
// delete files matching our own anchored name grammar (the state dir also holds
// hand-copied restore zips, #612), and off must mean off. Plus the usual
// settings plumbing: cold-load round trip and patch-registry inventory.
// Run: `npm test -- backup-schedule`.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir before the first config-derived import.
const stateRoot = mkdtempSync(path.join(tmpdir(), 'subwave-backup-schedule-'));
process.env.STATE_DIR = stateRoot;

const {
  BACKUP_CADENCE_DAYS,
  BACKUP_DUE_SLACK_MS,
  SCHEDULED_BACKUP_RE,
  backupDue,
  backupsToPrune,
  freeSpaceShortfall,
  FREE_SPACE_HEADROOM_BYTES,
  isScheduledBackupName,
  isScheduledBackupTempName,
  lastScheduledBackupAt,
  scheduledBackupName,
  scheduledBackupStamp,
} = await import('../src/backup/pure.js');
const { normalizeBackups } = await import('../src/settings/normalize.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { BACKUP_KEEP_BOUNDS, SETTINGS_BACKUP_CADENCES, backupsPatchSchema } =
  await import('../src/schemas/settings.js');

const SETTINGS_PATH = path.join(stateRoot, 'settings.json');
const DAY = 86_400_000;

// Load a hand-written settings.json the way a controller restart would.
async function coldLoad(backups: unknown) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(backups === undefined ? {} : { backups }));
  setCache(null);
  await settings.load();
  return settings.get().backups;
}


test('the writer produces a name the grammar recognises, and it sorts by time', () => {
  const early = scheduledBackupName(new Date('2026-09-06T04:23:17.123Z'));
  const later = scheduledBackupName(new Date('2026-09-06T05:00:00.000Z'));
  assert.equal(early, 'subwave-auto-backup-2026-09-06-042317.zip');
  assert.ok(isScheduledBackupName(early));
  assert.ok(isScheduledBackupName(later));
  // Fixed-width UTC, so lexicographic order is chronological: the prune never parses a date.
  assert.ok(early < later);
  // …and the listing route can restore it: isSafeBackupName wants a bare basename.zip.
  assert.equal(path.basename(early), early);
  assert.ok(early.toLowerCase().endsWith('.zip'));
});

test('the stamp round-trips out of the name', () => {
  const at = new Date('2026-09-06T04:23:17.000Z');
  assert.equal(scheduledBackupStamp(scheduledBackupName(at)), at.getTime());
});

test('a matching name that is not a real instant is still ours, but has no stamp', () => {
  // Read by different callers: the prune must still count (and delete) this file,
  // while the due decision must not treat NaN as a time.
  // must still count (and eventually delete) this file, while the due decision
  const junk = 'subwave-auto-backup-2026-13-45-999999.zip';
  assert.ok(SCHEDULED_BACKUP_RE.test(junk));
  assert.ok(isScheduledBackupName(junk));
  assert.equal(scheduledBackupStamp(junk), null);
});

test('nothing an operator or the manual export puts in the state dir is ours', () => {
  // Every one of these sits in a live STATE_DIR. The manual export's name is first:
  // it differs from ours by one word and is what an operator copies back to restore.
  for (const name of [
    'subwave-backup-2026-09-06.zip',          // GET /backup/export's filename
    'subwave-backup-2026-09-06-042317.zip',   // …with a time, if that ever changes
    'my-subwave-auto-backup-2026-09-06-042317.zip', // anchored: prefix is not enough
    'subwave-auto-backup-2026-09-06-042317.zip.bak',
    'subwave-auto-backup-2026-09-06-0423.zip', // short time field
    'subwave-auto-backup-2026-09-06.zip',
    'subwave-auto-backup-.zip',
    'SUBWAVE-AUTO-BACKUP-2026-09-06-042317.ZIP', // no case folding
    'library.db',
    'settings.json',
    'before-the-big-migration.zip',
    '',
  ]) {
    assert.equal(isScheduledBackupName(name), false, `${JSON.stringify(name)} must not be ours`);
  }
  for (const junk of [null, undefined, 7, {}, []]) {
    assert.equal(isScheduledBackupName(junk), false);
  }
});


const AUTO = [
  'subwave-auto-backup-2026-09-01-042300.zip',
  'subwave-auto-backup-2026-09-02-042300.zip',
  'subwave-auto-backup-2026-09-03-042300.zip',
  'subwave-auto-backup-2026-09-04-042300.zip',
];

test('keep last N deletes the OLDEST, never the newest', () => {
  assert.deepEqual(backupsToPrune(AUTO, 2), [
    'subwave-auto-backup-2026-09-02-042300.zip',
    'subwave-auto-backup-2026-09-01-042300.zip',
  ]);
  assert.deepEqual(backupsToPrune(AUTO, 4), []);
  assert.deepEqual(backupsToPrune(AUTO, 10), []);
  assert.deepEqual(backupsToPrune([], 3), []);
});

test('the prune never names a file it could not have written itself', () => {
  // The bad bug this feature could ship: a hand-copied restore zip deleted for
  // matching a glob. keep:1 is the most aggressive retention and still spares it.
  // deleted because it matched a glob. keep:1 is the most aggressive retention
  const foreign = [
    'subwave-backup-2026-09-06.zip',
    'before-the-big-migration.zip',
    'library.db',
    'settings.json',
    'jingles.m3u',
    'sfx.json',
    'themes',
  ];
  const pruned = backupsToPrune([...foreign, ...AUTO], 1);
  assert.deepEqual(pruned, [
    'subwave-auto-backup-2026-09-03-042300.zip',
    'subwave-auto-backup-2026-09-02-042300.zip',
    'subwave-auto-backup-2026-09-01-042300.zip',
  ]);
  for (const f of foreign) assert.ok(!pruned.includes(f), `${f} must never be pruned`);
});

// Ten of ours, so a fallback to the shipped default (7) is visible as a count
// rather than as "nothing was pruned".
const TEN_AUTO = Array.from({ length: 10 }, (_, i) =>
  `subwave-auto-backup-2026-09-${String(i + 1).padStart(2, '0')}-042300.zip`);

test('an out-of-range keep clamps, but an UNREADABLE one falls to the default', () => {
  // keep arrives from settings, but this is the function that unlinks, so it
  // re-reads. Out of range clamps to the nearest bound; not-a-number falls to the
  // shipped default, the same answer normalizeBackups() gives (#1585 review).
  for (const unreadable of [Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '', 'seven', {}]) {
    const pruned = backupsToPrune(TEN_AUTO, unreadable);
    assert.equal(pruned.length, TEN_AUTO.length - DEFAULTS.backups.keep,
      `keep=${JSON.stringify(unreadable)} should keep the default ${DEFAULTS.backups.keep}`);
  }
  // Finite but impossible: clamp. 0 would delete the backup just written.
  for (const bad of [0, -5]) {
    assert.equal(backupsToPrune(TEN_AUTO, bad).length, TEN_AUTO.length - BACKUP_KEEP_BOUNDS.min);
  }
  // The newest survives every one of those, readable or not.
  for (const any of [0, -5, Number.NaN, undefined, null, 'seven']) {
    assert.ok(!backupsToPrune(TEN_AUTO, any).includes(TEN_AUTO[TEN_AUTO.length - 1]),
      'the newest backup must survive any retention this function is handed');
  }
  // A float truncates rather than refusing — the parseInt family this key uses.
  assert.equal(backupsToPrune(AUTO, 2.9).length, 2);
  // Above the ceiling clamps down, which can only ever keep MORE than asked.
  assert.deepEqual(backupsToPrune(AUTO, 10_000), []);
  // A numeric STRING is readable — the admin number input posts one.
  assert.equal(backupsToPrune(TEN_AUTO, '3').length, 7);
});

test('the prune and the load path agree about an unreadable retention', () => {
  const viaLoad = normalizeBackups({ cadence: 'daily', keep: 'nonsense' }).keep;
  assert.equal(viaLoad, DEFAULTS.backups.keep);
  assert.equal(backupsToPrune(TEN_AUTO, 'nonsense').length, TEN_AUTO.length - viaLoad);
});

test('a future-dated backup is kept, not ranked away', () => {
  // The pair of `lastScheduledBackupAt` ignoring a future stamp: there the safe
  // direction is take a backup anyway, here it is never delete a real snapshot.
  const future = 'subwave-auto-backup-2031-01-01-000000.zip';
  const pruned = backupsToPrune([...AUTO, future], 2);
  // keep:2 leaves the 2031 file and the newest real one: the odd file costs a slot.
  assert.deepEqual(pruned, [
    'subwave-auto-backup-2026-09-03-042300.zip',
    'subwave-auto-backup-2026-09-02-042300.zip',
    'subwave-auto-backup-2026-09-01-042300.zip',
  ]);
  assert.ok(!pruned.includes(future));
  // And the due decision still ignores it, so the schedule is not wedged shut.
  assert.equal(lastScheduledBackupAt([...AUTO, future], NOW), Date.parse('2026-09-04T04:23:00Z'));
});


const NOW = Date.parse('2026-09-06T04:23:00.000Z');

test('off means off, and so does anything unrecognisable', () => {
  // The upgrade case IS the absent case: no backups block at all reads as off
  // and the station writes nothing, which is the byte-identical behaviour rule.
  for (const cadence of ['off', undefined, null, '', 'DAILY', 'hourly', 7, {}, []]) {
    assert.equal(
      backupDue({ cadence, lastRunMs: null, nowMs: NOW }),
      false,
      `cadence=${JSON.stringify(cadence)} must not schedule a backup`,
    );
  }
});

test('a configured cadence with nothing on disk is due at once', () => {
  // Turning the schedule on and waiting a month for the first backup is not
  // what the operator asked for.
  for (const cadence of ['daily', 'weekly', 'monthly']) {
    assert.equal(backupDue({ cadence, lastRunMs: null, nowMs: NOW }), true);
  }
});

test('each cadence waits its own interval', () => {
  for (const [cadence, days] of Object.entries(BACKUP_CADENCE_DAYS)) {
    const interval = days * DAY;
    // Just after the last run: not due.
    assert.equal(
      backupDue({ cadence, lastRunMs: NOW - 60_000, nowMs: NOW }), false,
      `${cadence} should not fire a minute after the last run`);
    // Comfortably inside the interval: not due.
    assert.equal(
      backupDue({ cadence, lastRunMs: NOW - interval + 2 * BACKUP_DUE_SLACK_MS, nowMs: NOW }), false,
      `${cadence} should not fire early`);
    // Exactly the interval, and past it: due.
    assert.equal(backupDue({ cadence, lastRunMs: NOW - interval, nowMs: NOW }), true);
    assert.equal(backupDue({ cadence, lastRunMs: NOW - 400 * DAY, nowMs: NOW }), true);
  }
});

// Runs the real hourly tick over 400 simulated days, feeding each run's name back
// onto disk as runScheduledBackup does. The failures are about repetition: drift
// out of the hours a part-time station is up, and a double fire inside one interval.
function simulate({
  cadence,
  days = 400,
  upHours,
}: {
  cadence: string;
  days?: number;
  /** Hours (UTC) the station is powered on. Default: always up. */
  upHours?: readonly number[];
}) {
  const start = Date.parse('2026-01-01T03:17:00.000Z'); // a deliberately odd minute
  const names: string[] = [];
  const runs: number[] = [];
  for (let h = 0; h < days * 24; h++) {
    const nowMs = start + h * 3_600_000;
    if (upHours && !upHours.includes(new Date(nowMs).getUTCHours())) continue;
    if (!backupDue({ cadence, lastRunMs: lastScheduledBackupAt(names, nowMs), nowMs })) continue;
    names.push(scheduledBackupName(new Date(nowMs)));
    runs.push(nowMs);
  }
  return runs;
}

test('every cadence holds its interval over 400 days of hourly ticks', () => {
  for (const [cadence, days] of Object.entries(BACKUP_CADENCE_DAYS)) {
    const runs = simulate({ cadence });
    // One at the first tick, then one per interval for the rest of the window.
    assert.equal(runs.length, 1 + Math.floor((400 - 1) / days),
      `${cadence} fired ${runs.length} times in 400 days`);
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i] - runs[i - 1];
      assert.ok(gap >= days * DAY - BACKUP_DUE_SLACK_MS,
        `${cadence} fired twice inside one interval (gap ${gap / DAY}d at run ${i})`);
      // The tick is hourly, so a run is at most an hour late — that is the drift check.
      assert.ok(gap < days * DAY + 3_600_000,
        `${cadence} drifted to a ${gap / DAY}d gap at run ${i}`);
    }
  }
});

test('a station that is only up four hours a day still gets its weekly and monthly backup', () => {
  // Why the cadence is elapsed-time against the stamps on disk: a box switched off
  // overnight would never meet a nightly cron.
  const upHours = [18, 19, 20, 21];
  for (const cadence of ['weekly', 'monthly'] as const) {
    const runs = simulate({ cadence, upHours });
    const interval = BACKUP_CADENCE_DAYS[cadence] * DAY;
    assert.ok(runs.length >= Math.floor(400 / BACKUP_CADENCE_DAYS[cadence]),
      `${cadence} on a part-time station fired only ${runs.length} times in 400 days`);
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i] - runs[i - 1] >= interval - BACKUP_DUE_SLACK_MS,
        `${cadence} fired twice inside one interval`);
      // The catch-up is bounded by the station being off, not by the schedule:
      // at worst it waits out the 20 hours it was down.
      assert.ok(runs[i] - runs[i - 1] < interval + 24 * 3_600_000,
        `${cadence} missed a whole window`);
    }
    // And every run lands inside the hours the station is actually up.
    for (const ms of runs) assert.ok(upHours.includes(new Date(ms).getUTCHours()));
  }
});

test('the slack keeps a daily backup on the same minute instead of walking the clock', () => {
  // The tick is hourly, so a strict `>= 24h` would slip a 04:23 run to 05:23, then
  // 06:23 — a daily backup drifting a full day around the clock every month.
  const yesterdayTick = NOW - DAY + 1000; // last night's run, a second late
  assert.equal(backupDue({ cadence: 'daily', lastRunMs: yesterdayTick, nowMs: NOW }), true);
  // …and the slack cannot fit two runs in one interval: shortest cadence is a day.
  assert.ok(BACKUP_DUE_SLACK_MS < DAY / 2);
  assert.equal(
    backupDue({ cadence: 'daily', lastRunMs: NOW - 60 * 60_000, nowMs: NOW }),
    false,
    'an hour after a run is never due',
  );
});

test('the last run is read off the newest file, ignoring anything else in the dir', () => {
  const names = [
    'settings.json',
    'subwave-backup-2026-09-05.zip',              // a manual export: not a run
    'subwave-auto-backup-2026-09-01-042300.zip',
    'subwave-auto-backup-2026-09-05-042300.zip',
    'subwave-auto-backup-2026-13-45-999999.zip',  // ours, but names no instant
  ];
  assert.equal(
    lastScheduledBackupAt(names, NOW),
    Date.parse('2026-09-05T04:23:00Z'),
  );
  assert.equal(lastScheduledBackupAt(['library.db'], NOW), null);
  assert.equal(lastScheduledBackupAt([], NOW), null);
});

test('a backup stamped in the future cannot wedge the schedule shut', () => {
  // A file dated years ahead (booted before NTP, restored state dir) is ignored:
  // trusting it computes a negative elapsed time and backups silently stop.
  const names = ['subwave-auto-backup-2031-01-01-000000.zip'];
  assert.equal(lastScheduledBackupAt(names, NOW), null);
  assert.equal(
    backupDue({ cadence: 'daily', lastRunMs: lastScheduledBackupAt(names, NOW), nowMs: NOW }),
    true,
  );
  // A real run alongside it still wins.
  const withReal = [...names, 'subwave-auto-backup-2026-09-06-000000.zip'];
  assert.equal(lastScheduledBackupAt(withReal, NOW), Date.parse('2026-09-06T00:00:00Z'));
});


test('an absent block is the pre-existing station: off', async () => {
  const b = await coldLoad(undefined);
  assert.equal(b.cadence, 'off');
  assert.equal(DEFAULTS.backups.cadence, 'off');
  assert.equal(backupDue({ cadence: b.cadence, lastRunMs: null, nowMs: NOW }), false);
});

test('a configured schedule survives a cold load', async () => {
  // load() composes each block explicitly, so a field missing from it saves, works
  // for the process, then vanishes on the next restart. Cold-load or nothing.
  await settings.update({ backups: { cadence: 'weekly', keep: 3 } });
  setCache(null);
  await settings.load();
  assert.equal(settings.get().backups.cadence, 'weekly');
  assert.equal(settings.get().backups.keep, 3);
});

test('the load path repairs a malformed block toward off, never toward daily', async () => {
  for (const bad of ['DAILY', 'hourly', 42, null, [], { nested: true }]) {
    const b = await coldLoad({ cadence: bad, keep: 5 });
    assert.equal(b.cadence, 'off', `stored cadence=${JSON.stringify(bad)} should fall back to off`);
    // A bad cadence must not take a good retention down with it, and vice
    // versa — the two are repaired independently.
    assert.equal(b.keep, 5);
  }
  for (const bad of [0, -1, 10_000, Number.NaN, 'seven', null]) {
    const b = await coldLoad({ cadence: 'daily', keep: bad });
    assert.equal(b.cadence, 'daily', 'a bad retention must not disarm a cadence the operator set');
    assert.ok(b.keep >= BACKUP_KEEP_BOUNDS.min && b.keep <= BACKUP_KEEP_BOUNDS.max);
  }
  const half = await coldLoad({ cadence: 'monthly' });
  assert.equal(half.cadence, 'monthly');
  assert.equal(half.keep, DEFAULTS.backups.keep);
});

test('the save path refuses what the load path repairs', () => {
  assert.equal(backupsPatchSchema.safeParse({ cadence: 'weekly', keep: 4 }).success, true);
  for (const cadence of SETTINGS_BACKUP_CADENCES) {
    assert.equal(backupsPatchSchema.safeParse({ cadence }).success, true);
  }
  for (const bad of ['DAILY', 'hourly', '', 7, null]) {
    assert.equal(
      backupsPatchSchema.safeParse({ cadence: bad }).success, false,
      `cadence=${JSON.stringify(bad)} should be refused at save`);
  }
  for (const bad of [0, -1, 101, 'seven']) {
    assert.equal(
      backupsPatchSchema.safeParse({ keep: bad }).success, false,
      `keep=${JSON.stringify(bad)} should be refused at save`);
  }
  // A non-object block is a silent no-op, not an error — settingsBlockOf's
  // leniency, and a backup restore is what meets it.
  assert.deepEqual(backupsPatchSchema.parse(null), {});
});

test('the refusal messages name their own dotted field', () => {
  // The flat `error` string is the zod message verbatim, so it must name the field.
  assert.equal(
    backupsPatchSchema.safeParse({ cadence: 'hourly' }).error!.issues[0].message,
    `backups.cadence must be one of: ${SETTINGS_BACKUP_CADENCES.join(', ')}`,
  );
  assert.equal(
    backupsPatchSchema.safeParse({ keep: 0 }).error!.issues[0].message,
    `backups.keep must be int in [${BACKUP_KEEP_BOUNDS.min}, ${BACKUP_KEEP_BOUNDS.max}]`,
  );
});

test('saving the schedule does NOT ask for a mixer restart', async () => {
  // Nothing here is handed to Liquidsoap. A restart banner raised by a backup
  // setting would take the station off air for a file-copy job.
  await coldLoad(undefined);
  const r = await settings.update({ backups: { cadence: 'daily', keep: 5 } });
  assert.equal(r.requiresRestart, false);
  assert.equal(settings.get().backups.cadence, 'daily');
  assert.equal(settings.get().backups.keep, 5);
});

test('the key is in the patch inventory, so POST /settings accepts it', async () => {
  const { SETTINGS_PATCH_KEYS, validateSettingsPatch, SETTINGS_PATCH_SHAPE_ONLY } =
    await import('../src/settings/patch-registry.js');
  // A key absent from this list is rejected at the route — the Backup panel
  // would post it and get a 400 naming an unknown key.
  assert.ok(SETTINGS_PATCH_KEYS.includes('backups'));
  assert.equal(
    validateSettingsPatch({ backups: { cadence: 'daily', keep: 7 } }, SETTINGS_PATCH_SHAPE_ONLY),
    null,
  );
  const bad = validateSettingsPatch({ backups: { keep: 0 } }, SETTINGS_PATCH_SHAPE_ONLY);
  assert.ok(bad, 'an out-of-range retention should be refused at the route');
  // The fieldErrors channel is the point of registering the key: the input can
  // only highlight itself if the error is keyed by its dotted path.
  assert.ok(bad!.fieldErrors?.['backups.keep']);
});


test('an off station does no work at all', async () => {
  // Not just "writes nothing" — it must not even walk the state dir once an
  // hour on the overwhelming majority of installs that never turn this on.
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  await coldLoad(undefined);
  const r = await runScheduledBackup(new Date(NOW));
  assert.equal(r.skipped, 'off');
  assert.equal(r.written, null);
  assert.deepEqual(r.pruned, []);
  assert.deepEqual(r.errors, []);
});

// One pass over the real thing: the file lands, it is the same zip
// GET /backup/export builds, the cadence holds, and the prune spares the
// operator's own zip.
// restorable, so one pass over the real thing: the file lands, it is a genuine

test('a due run writes a restorable zip, and is not due again an hour later', async () => {
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const AdmZip = (await import('adm-zip')).default;
  await coldLoad({ cadence: 'daily', keep: 3 });

  const first = await runScheduledBackup(new Date(NOW));
  assert.deepEqual(first.errors, []);
  assert.ok(first.written, 'a configured station with no backups on disk is due at once');
  assert.ok(isScheduledBackupName(first.written!));
  assert.ok(first.bytes > 0);

  // What landed is a real backup, not a truncated temp file: the manifest is
  // what applyBackupZip() validates before it touches any state.
  const zip = new AdmZip(path.join(stateRoot, first.written!));
  const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'));
  assert.equal(manifest.format, 'subwave-backup');
  assert.equal(manifest.version, 1);
  assert.ok(zip.getEntry('settings.json'), 'the snapshot must carry settings.json');

  // The cadence now holds: the stamp it just wrote is the record of the run.
  const soon = await runScheduledBackup(new Date(NOW + 60 * 60_000));
  assert.equal(soon.skipped, 'not-due');
  assert.equal(soon.written, null);
});

test('retention keeps the last N of its own and never the operator\'s', async () => {
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const { readdirSync, unlinkSync } = await import('node:fs');
  await coldLoad({ cadence: 'daily', keep: 2 });
  // Start from a dir with none of ours in it — the previous test left one, and
  // its stamp would hold the first run below off.
  for (const n of readdirSync(stateRoot).filter(isScheduledBackupName)) {
    unlinkSync(path.join(stateRoot, n));
  }

  // A backup the operator downloaded and copied back in to restore — the file
  // this feature must never delete. Its name is one word away from ours.
  const handCopied = 'subwave-backup-2026-09-01.zip';
  writeFileSync(path.join(stateRoot, handCopied), 'not really a zip');

  // Four days of runs; only the last two of OURS may survive.
  const written: string[] = [];
  for (let day = 0; day < 4; day++) {
    const r = await runScheduledBackup(new Date(NOW + day * DAY));
    assert.deepEqual(r.errors, [], `day ${day} should not error`);
    assert.ok(r.written, `day ${day} should be due`);
    written.push(r.written!);
  }

  const left = readdirSync(stateRoot);
  assert.ok(left.includes(handCopied), 'the hand-copied backup must survive every sweep');
  const ours = left.filter(isScheduledBackupName).sort();
  assert.deepEqual(ours, written.slice(-2).sort());
  // And no half-written temp survived the atomic rename.
  assert.deepEqual(left.filter(n => n.endsWith('.tmp')), []);
});

// This job writes the largest file the station produces into the directory it
// protects, and retries hourly, so a FAILED run must not compound.

test('the temp grammar is as narrow as the finished one', () => {
  // The sweep DELETES, so the prune's rule applies: only a name this writer could
  // have produced. Every other *.tmp is another writer's in-flight file.
  const ours = 'subwave-auto-backup-2026-09-06-042317.zip.a1b2c3d4.tmp';
  assert.ok(isScheduledBackupTempName(ours));
  assert.ok(isScheduledBackupTempName(`${scheduledBackupName(new Date(NOW))}.deadbeef.tmp`));
  for (const foreign of [
    'settings.json.a1b2c3d4.tmp',                    // another writer, mid-flight
    'session.json.a1b2c3d4.tmp',
    'queue.json.a1b2c3d4.tmp',
    'auto.m3u.a1b2c3d4.tmp',
    'subwave-backup-2026-09-06.zip.a1b2c3d4.tmp',    // the MANUAL export's name
    'my-subwave-auto-backup-2026-09-06-042317.zip.a1b2c3d4.tmp', // anchored
    'subwave-auto-backup-2026-09-06-042317.zip',     // the finished file
    'subwave-auto-backup-2026-09-06-042317.tmp',     // no .zip in the stem
    'subwave-auto-backup-2026-09-06-042317.zip.tmp', // no random suffix
    'subwave-auto-backup-2026-09-06-042317.zip.zzzz.tmp', // not hex
    '',
  ]) {
    assert.equal(isScheduledBackupTempName(foreign), false,
      `${JSON.stringify(foreign)} is not ours to delete`);
  }
  for (const junk of [null, undefined, 7, {}, []]) {
    assert.equal(isScheduledBackupTempName(junk), false);
  }
  // A temp is invisible to both finished-name readers, hence its own sweep.
  assert.equal(isScheduledBackupName(ours), false);
});

test('writeFileAtomic removes its own temp when the write fails', async () => {
  // The in-process half of the leak: a failed rename left a partial
  // multi-hundred-MB zip behind under a name no later call reuses.
  const { writeFileAtomic } = await import('../src/util/atomic-file.js');
  const { mkdirSync, readdirSync, rmSync } = await import('node:fs');

  const blocked = path.join(stateRoot, 'blocked-target.zip');
  mkdirSync(blocked, { recursive: true }); // rename onto a directory fails
  await assert.rejects(
    () => writeFileAtomic(blocked, Buffer.from('some backup bytes')),
    'the original error must still propagate — cleanup is bookkeeping',
  );
  assert.deepEqual(
    readdirSync(stateRoot).filter(n => n.startsWith('blocked-target.zip.')),
    [],
    'the temp must not survive a failed write',
  );
  rmSync(blocked, { recursive: true, force: true });
});

test('a run sweeps half-written backups a killed run left, and only those', async () => {
  // The out-of-process half: a kill mid-write gets no catch block, so every run
  // sweeps on the way in, BEFORE the due check.
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const { readdirSync, unlinkSync } = await import('node:fs');
  await coldLoad({ cadence: 'daily', keep: 3 });

  const stale = 'subwave-auto-backup-2026-09-05-042300.zip.deadbeef.tmp';
  const foreign = 'settings.json.deadbeef.tmp';
  writeFileSync(path.join(stateRoot, stale), 'half a zip');
  writeFileSync(path.join(stateRoot, foreign), '{"mid":"flight"}');

  // An hour after the newest backup the previous test left, so this run is NOT
  // due — which also pins that the sweep does not ride on the writing path.
  const r = await runScheduledBackup(new Date(NOW + 3 * DAY + 60 * 60_000));
  assert.equal(r.skipped, 'not-due');
  assert.deepEqual(r.sweptTemps, [stale]);
  assert.deepEqual(r.errors, []);

  const left = readdirSync(stateRoot);
  assert.ok(!left.includes(stale), 'our half-written file must be swept');
  assert.ok(left.includes(foreign), "another writer's in-flight file must survive");
  unlinkSync(path.join(stateRoot, foreign));
});

test('the free-space decision declines only what genuinely will not fit', () => {
  // Verified live against a container's 64 MB /dev/shm; this pins the arithmetic.
  const ARCHIVE = 1_500_000;
  const need = ARCHIVE + FREE_SPACE_HEADROOM_BYTES;

  // Room to spare, and exactly enough, both fit.
  assert.equal(freeSpaceShortfall(500e9, ARCHIVE), null);
  assert.equal(freeSpaceShortfall(need, ARCHIVE), null);

  // One byte short is short, and the shortfall is what is missing.
  assert.equal(freeSpaceShortfall(need - 1, ARCHIVE), 1);
  assert.equal(freeSpaceShortfall(need - 5_000_000, ARCHIVE), 5_000_000);

  // The headroom is the point: an archive that fits with nothing left over is
  // refused — STATE_DIR also holds session.json and the tag DB.
  assert.ok(freeSpaceShortfall(ARCHIVE + 1, ARCHIVE) !== null,
    'a write that would leave the volume full must be declined');

  // FAILS OPEN on anything unmeasurable — the write is attempted, because
  // taking the backup is the whole job.
  for (const unmeasurable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(freeSpaceShortfall(unmeasurable, ARCHIVE), null,
      `free=${unmeasurable} must fail open`);
  }

  // Decimal MB, not MiB: the same divisor renders the error message, so MiB would
  // mean a constant saying 64 and a message saying 67.
  assert.equal(Math.round(FREE_SPACE_HEADROOM_BYTES / 1_000_000), 64);
});

test('a normal run is not blocked by the free-space pre-flight', async () => {
  // The pre-flight fails open and declines only a write that genuinely will not fit.
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const { readdirSync, unlinkSync } = await import('node:fs');
  await coldLoad({ cadence: 'daily', keep: 3 });
  for (const n of readdirSync(stateRoot).filter(isScheduledBackupName)) {
    unlinkSync(path.join(stateRoot, n));
  }
  const r = await runScheduledBackup(new Date(NOW + 5 * DAY));
  assert.deepEqual(r.errors, []);
  assert.ok(r.written, 'a due run on a disk with room must write');
  assert.ok(r.bytes > 0);
});

test('an undeletable file does not abandon the rest of the prune', async () => {
  // One unremovable file must cost its own line in `errors`, not the sweep, or a
  // single stuck file freezes retention and the disk fills anyway.
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const { chmodSync, mkdirSync, readdirSync, rmSync, unlinkSync } = await import('node:fs');
  await coldLoad({ cadence: 'daily', keep: 1 });
  for (const n of readdirSync(stateRoot).filter(isScheduledBackupName)) {
    unlinkSync(path.join(stateRoot, n));
  }

  // A DIRECTORY carrying one of our names: unlink() refuses it (EISDIR/EPERM).
  const stuck = 'subwave-auto-backup-2026-09-01-000000.zip';
  const alsoOld = 'subwave-auto-backup-2026-09-02-000000.zip';
  mkdirSync(path.join(stateRoot, stuck), { recursive: true });
  writeFileSync(path.join(stateRoot, alsoOld), 'an older backup');

  const r = await runScheduledBackup(new Date(NOW + 10 * DAY));
  assert.ok(r.written, 'the backup itself still happens');
  assert.ok(r.pruned.includes(alsoOld), 'the removable older backup is still pruned');
  assert.equal(r.errors.length, 1, 'exactly one failure reported');
  assert.match(r.errors[0], /could not remove subwave-auto-backup-2026-09-01-000000\.zip/);

  chmodSync(path.join(stateRoot, stuck), 0o755);
  rmSync(path.join(stateRoot, stuck), { recursive: true, force: true });
});
