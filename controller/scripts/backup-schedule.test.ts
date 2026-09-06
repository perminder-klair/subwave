// settings.backups — scheduled, rotating config backups (#1570, the Discord
// ask "Backup DB/Settings on Schedule").
//
// Two decisions carry the whole feature and both fail silently in the field, so
// both are pinned here as pure logic:
//
//   1. THE RETENTION CHOICE. This is the only scheduled job in the station that
//      DELETES operator files, and it runs in a directory that deliberately
//      accepts hand-copied zips — `GET /backup/restorable` lists every
//      top-level *.zip in STATE_DIR so an operator can drop a big backup in and
//      restore it past their proxy's upload cap (#612). A prune that reasoned
//      over that set, or over any *.zip glob, would eventually eat the restore
//      point someone copied in ten minutes ago. So the tests below throw every
//      near-miss name at it that a real state dir contains.
//
//   2. THE SCHEDULE DECISION. Off must mean off: a station that upgrades and
//      changes nothing has no `backups` block, and every path into the decision
//      — absent, malformed, a cadence from a newer version — has to land on
//      "write nothing". The opposite direction matters too, and quietly: a
//      station that is only powered on for part of the day must still get its
//      daily backup, which is why the cadence is elapsed-time against the
//      stamps on disk rather than a nightly cron.
//
// Plus the settings plumbing every key here owes: the cold-load round trip
// (a field missing from load()'s composition saves, works for the process, then
// vanishes on the next restart — controller/CLAUDE.md's THREE edits) and the
// patch-registry inventory (a key absent from it 400s at the route).
//
// No containers, no network, no clock waiting.
//
// Run: `npm test -- backup-schedule`.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// STATE_DIR is redirected at a throwaway dir BEFORE the first import of
// anything config-derived (same pattern as scripts/duck-depth.test.ts).
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

// ---------------------------------------------------------------------------
// 1. The name grammar — the safety property behind the prune
// ---------------------------------------------------------------------------

test('the writer produces a name the grammar recognises, and it sorts by time', () => {
  const early = scheduledBackupName(new Date('2026-09-06T04:23:17.123Z'));
  const later = scheduledBackupName(new Date('2026-09-06T05:00:00.000Z'));
  assert.equal(early, 'subwave-auto-backup-2026-09-06-042317.zip');
  assert.ok(isScheduledBackupName(early));
  assert.ok(isScheduledBackupName(later));
  // Fixed-width UTC, so lexicographic order IS chronological order — which is
  // what lets backupsToPrune sort by name and never parse a date.
  assert.ok(early < later);
  // …and the listing route can restore it: isSafeBackupName wants a bare
  // basename ending in .zip.
  assert.equal(path.basename(early), early);
  assert.ok(early.toLowerCase().endsWith('.zip'));
});

test('the stamp round-trips out of the name', () => {
  const at = new Date('2026-09-06T04:23:17.000Z');
  assert.equal(scheduledBackupStamp(scheduledBackupName(at)), at.getTime());
});

test('a matching name that is not a real instant is still ours, but has no stamp', () => {
  // The two facts are different and are read by different callers: the prune
  // must still count (and eventually delete) this file, while the due decision
  // must not treat NaN as a time. Getting this backwards leaves a junk file
  // living forever, or wedges the cadence.
  const junk = 'subwave-auto-backup-2026-13-45-999999.zip';
  assert.ok(SCHEDULED_BACKUP_RE.test(junk));
  assert.ok(isScheduledBackupName(junk));
  assert.equal(scheduledBackupStamp(junk), null);
});

test('nothing an operator or the manual export puts in the state dir is ours', () => {
  // Every one of these is a real thing that sits in a live STATE_DIR. The
  // manual export's own name is the first entry for a reason: it differs from
  // ours by one word, and it is the file an operator downloads, edits nothing
  // and copies back to restore.
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

// ---------------------------------------------------------------------------
// 2. The retention choice
// ---------------------------------------------------------------------------

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
  // The bad bug this feature could ship: an operator's hand-copied restore zip
  // deleted because it matched a glob. keep:1 is the most aggressive retention
  // there is, and it still leaves every foreign file alone.
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
  // keep arrives from settings, which the schema bounds and load() repairs —
  // but this is the function that unlinks, so it re-reads rather than trusting
  // its caller. The two directions are different on purpose (#1585 review):
  //
  //   a number out of range is an answer, so it clamps to the nearest bound;
  //   a value that is not a number at all is NO answer, so it falls to the
  //   shipped default — the same answer normalizeBackups() gives.
  //
  // Falling to the FLOOR instead would make the one module in the station that
  // deletes operator files the one that guesses most destructively.
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
  // The finding this pins: two clamps, one in each module, disagreeing about
  // the direction to fail in. They are now one function.
  const viaLoad = normalizeBackups({ cadence: 'daily', keep: 'nonsense' }).keep;
  assert.equal(viaLoad, DEFAULTS.backups.keep);
  assert.equal(backupsToPrune(TEN_AUTO, 'nonsense').length, TEN_AUTO.length - viaLoad);
});

test('a future-dated backup is kept, not ranked away', () => {
  // The pair of `lastScheduledBackupAt` ignoring a future stamp. There the safe
  // direction is "take a backup anyway"; here it is "do not DELETE a real
  // snapshot on the word of a clock that has already been wrong once", so the
  // name still decides the order and the odd file simply costs a slot.
  const future = 'subwave-auto-backup-2031-01-01-000000.zip';
  const pruned = backupsToPrune([...AUTO, future], 2);
  // keep:2 leaves the 2031 file and the newest real one — the odd file costs a
  // slot rather than being deleted or being pruned around.
  assert.deepEqual(pruned, [
    'subwave-auto-backup-2026-09-03-042300.zip',
    'subwave-auto-backup-2026-09-02-042300.zip',
    'subwave-auto-backup-2026-09-01-042300.zip',
  ]);
  assert.ok(!pruned.includes(future));
  // And the due decision still ignores it, so the schedule is not wedged shut.
  assert.equal(lastScheduledBackupAt([...AUTO, future], NOW), Date.parse('2026-09-04T04:23:00Z'));
});

// ---------------------------------------------------------------------------
// 3. The schedule decision
// ---------------------------------------------------------------------------

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

// Everything above is arithmetic on one pair of instants. That is the whole of
// the daily case — a day is short enough to reason about — but `weekly` and
// `monthly` were never driven over their own interval, and the two failures
// that would matter there are both about REPETITION rather than one decision:
// a schedule that walks the clock until it lands outside the hours a part-time
// station is up, and one that double-fires because the slack is a larger share
// of a longer interval than anyone checked.
//
// So: run the real hourly tick over 400 simulated days, feeding each run's name
// back onto disk exactly as `runScheduledBackup` does, and assert the shape of
// the whole series. No clock waiting — the tick is a loop, and the state it
// reads is a filename.
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
      // The tick is hourly, so a run can be at most an hour late — and never
      // more, which is the drift check: an interval that crept by an hour each
      // time would blow this on the second or third run, not the four-hundredth.
      assert.ok(gap < days * DAY + 3_600_000,
        `${cadence} drifted to a ${gap / DAY}d gap at run ${i}`);
    }
  }
});

test('a station that is only up four hours a day still gets its weekly and monthly backup', () => {
  // The reason the cadence is elapsed-time against the stamps on disk rather
  // than a nightly cron. These are the installs most likely to lose a state dir
  // — a laptop, a box switched off overnight — and a monthly schedule that
  // needs to be up at 03:00 on the right date would simply never fire.
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
  // The tick is hourly. With a strict `>= 24h` a run at 04:23 is not due at
  // 04:23 the next day (elapsed is 24h to the millisecond only if the tick
  // fired at the same instant), so it slips to 05:23, then 06:23 — a daily
  // backup that drifts a full day around the clock every month.
  const yesterdayTick = NOW - DAY + 1000; // last night's run, a second late
  assert.equal(backupDue({ cadence: 'daily', lastRunMs: yesterdayTick, nowMs: NOW }), true);
  // …and the slack is far too small to let two runs land inside one interval:
  // the shortest cadence is a day and the tick is an hour.
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
  // A container that booted before NTP, or a state dir restored from another
  // box, leaves a file dated years ahead. Trusting it computes a negative
  // elapsed time forever and the station silently stops backing up — so a
  // future stamp is ignored and the decision falls toward taking a backup.
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

// ---------------------------------------------------------------------------
// 4. The settings plumbing
// ---------------------------------------------------------------------------

test('an absent block is the pre-existing station: off', async () => {
  const b = await coldLoad(undefined);
  assert.equal(b.cadence, 'off');
  assert.equal(DEFAULTS.backups.cadence, 'off');
  assert.equal(backupDue({ cadence: b.cadence, lastRunMs: null, nowMs: NOW }), false);
});

test('a configured schedule survives a cold load', async () => {
  // load() composes each block explicitly rather than spreading DEFAULTS, so a
  // field missing from that composition saves fine, works for the rest of the
  // process, and then vanishes on the next restart — after which backups
  // silently stop. An in-process assertion passes on the broken code.
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
  // The flat `error` string is the zod message verbatim (see the patch
  // registry), so it has to name the field itself or the toast reads as a bare
  // constraint.
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

// ---------------------------------------------------------------------------
// 5. The runner's own short-circuit
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 6. The writer, against a real state dir
//
// The pure halves above can all be right while the run still writes nothing
// restorable, so one pass over the real thing: the file lands, it is a genuine
// backup zip (the same one GET /backup/export builds — `POST
// /backup/import-file` cannot tell the two apart, so it had better be), the
// cadence holds it off until it is due, and the prune leaves the operator's own
// zip alone.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7. Not making things worse
//
// This job writes the largest file the station produces into the directory it
// exists to protect, and it retries hourly until it succeeds. Both guards below
// exist so a run that FAILS cannot compound into the disk filling up — which is
// the one condition where an operator needs the rest of the station working.
// ---------------------------------------------------------------------------

test('the temp grammar is as narrow as the finished one', () => {
  // The sweep DELETES, so the same rule applies as to the prune: only a name
  // this writer could itself have produced. Every other *.tmp in the state dir
  // is another writer's in-flight file, and settings.json is written the same
  // way — eating one of those mid-flight would be far worse than the leak.
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
  // And a temp is invisible to BOTH the finished-name readers, which is exactly
  // why it needs its own sweep: nothing else would ever look at it again.
  assert.equal(isScheduledBackupName(ours), false);
});

test('writeFileAtomic removes its own temp when the write fails', async () => {
  // The in-process half of the leak. A failed rename used to leave the temp
  // behind under a random name no later call reuses — a few hundred bytes for
  // the JSON writers, a partial multi-hundred-MB zip for this one.
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
  // The out-of-process half: an OOM kill or `docker compose restart` mid-write
  // gets no catch block, so every run tidies up on the way in. Doing it before
  // the due check matters — a monthly schedule must not sit on the wreckage of
  // an interrupted run for a month.
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
  // Verified live against a container's 64 MB /dev/shm: the run declined, wrote
  // no file and left no partial temp. This pins the arithmetic behind it.
  const ARCHIVE = 1_500_000;
  const need = ARCHIVE + FREE_SPACE_HEADROOM_BYTES;

  // Room to spare, and exactly enough, both fit.
  assert.equal(freeSpaceShortfall(500e9, ARCHIVE), null);
  assert.equal(freeSpaceShortfall(need, ARCHIVE), null);

  // One byte short is short, and the shortfall is what is missing.
  assert.equal(freeSpaceShortfall(need - 1, ARCHIVE), 1);
  assert.equal(freeSpaceShortfall(need - 5_000_000, ARCHIVE), 5_000_000);

  // The headroom is the point: an archive that would technically fit, on a
  // volume with nothing left afterwards, is still refused. STATE_DIR is where
  // session.json and the tag DB live.
  assert.ok(freeSpaceShortfall(ARCHIVE + 1, ARCHIVE) !== null,
    'a write that would leave the volume full must be declined');

  // FAILS OPEN on anything unmeasurable — the write is attempted, because
  // taking the backup is the whole job.
  for (const unmeasurable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(freeSpaceShortfall(unmeasurable, ARCHIVE), null,
      `free=${unmeasurable} must fail open`);
  }

  // Decimal MB, not MiB: the operator reads this figure back out of an error
  // message rendered by the same divisor, so 64 * 1024 * 1024 would be a
  // constant saying 64 and a message saying 67. (Caught on a live station.)
  assert.equal(Math.round(FREE_SPACE_HEADROOM_BYTES / 1_000_000), 64);
});

test('a normal run is not blocked by the free-space pre-flight', async () => {
  // The pre-flight FAILS OPEN and only declines a write that genuinely will not
  // fit. On any ordinary disk the backup still lands — the guard must never
  // become the reason a station stops taking backups.
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
  // One unremovable file (ownership on a bind mount) must cost its own line in
  // `errors`, not the sweep — otherwise a single stuck file freezes retention
  // and the disk fills anyway.
  const { runScheduledBackup } = await import('../src/backup/scheduled.js');
  const { chmodSync, mkdirSync, readdirSync, rmSync, unlinkSync } = await import('node:fs');
  await coldLoad({ cadence: 'daily', keep: 1 });
  for (const n of readdirSync(stateRoot).filter(isScheduledBackupName)) {
    unlinkSync(path.join(stateRoot, n));
  }

  // A DIRECTORY carrying one of our names: unlink() refuses it (EISDIR/EPERM)
  // the way a file the controller may not remove would.
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
