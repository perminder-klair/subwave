// Scheduled tagging (#2282): settings.tagger.auto starts a daily tagger run at
// a set station-clock time. Pins the policy (music/tag-schedule-policy.ts), the
// tick (broadcast/tag-schedule.ts, driven through injected deps so nothing
// spawns), the settings plumbing (cold-load round trip, patch inventory, the
// strict/lenient split) and the tagger's exit callback.
// Run: `npm test -- tag-schedule`.

import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-tag-schedule-'));
process.env.STATE_DIR = stateRoot;

const {
  normalizeTagScheduleRecord,
  pendingWork,
  pendingWorkText,
  scheduleDue,
  scheduleMinuteOfDay,
  scheduledRunKind,
} = await import('../src/music/tag-schedule-policy.js');
const { createTagSchedule, scheduledTaggerOptions } = await import('../src/broadcast/tag-schedule.js');
const { quietAfterMinutes } = await import('../src/music/analyze-quiet-pure.js');
const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const { normalizeTaggerAuto } = await import('../src/settings/normalize.js');
const { taggerPatchSchema, taggerAutoFormSchema, SETTINGS_TAGGER_AUTO_MODES } = await import('../src/schemas/settings.js');

type Auto = typeof DEFAULTS.tagger.auto;
const ALL_STEPS = { reconcile: true, enrich: true, tagMoods: true, analyze: true };
const daily = (over: Partial<Auto> = {}): Auto =>
  ({ mode: 'daily', time: '02:30', limit: 0, steps: { ...ALL_STEPS }, ...over });

// ---------------------------------------------------------------------------
// Policy

test('scheduleMinuteOfDay reads HH:MM and refuses anything else', () => {
  assert.equal(scheduleMinuteOfDay('00:00'), 0);
  assert.equal(scheduleMinuteOfDay('02:30'), 150);
  assert.equal(scheduleMinuteOfDay('23:59'), 1439);
  for (const bad of ['24:00', '2:30', '02:60', '', '02:30:00']) {
    assert.equal(scheduleMinuteOfDay(bad), null, bad);
  }
});

test('scheduleDue: off, before the time, at and after it, and once a day', () => {
  const base = { today: '2026-11-07', lastDay: null };
  assert.equal(scheduleDue({ ...base, auto: { mode: 'off', time: '02:30' }, minuteOfDay: 200 }), 'off');
  assert.equal(scheduleDue({ ...base, auto: daily(), minuteOfDay: 149 }), 'not-due');
  assert.equal(scheduleDue({ ...base, auto: daily(), minuteOfDay: 150 }), 'due');
  // A controller that was down at 02:30 catches the day up on its first tick.
  assert.equal(scheduleDue({ ...base, auto: daily(), minuteOfDay: 14 * 60 }), 'due');
  assert.equal(
    scheduleDue({ auto: daily(), today: '2026-11-07', lastDay: '2026-11-07', minuteOfDay: 200 }),
    'done-today',
  );
  assert.equal(
    scheduleDue({ auto: daily(), today: '2026-11-08', lastDay: '2026-11-07', minuteOfDay: 151 }),
    'due',
  );
  // An unreadable time stays quiet rather than firing at midnight.
  assert.equal(scheduleDue({ ...base, auto: daily({ time: 'soon' }), minuteOfDay: 1000 }), 'off');
});

test('scheduledRunKind mirrors the Run tab: none, reconcile only, or a tag run', () => {
  const off = { reconcile: false, enrich: false, tagMoods: false, analyze: false };
  assert.equal(scheduledRunKind(off), null);
  assert.equal(scheduledRunKind({ ...off, reconcile: true }), 'reconcile');
  assert.equal(scheduledRunKind({ ...off, analyze: true }), 'tag');
  assert.equal(scheduledRunKind(ALL_STEPS), 'tag');
});

test('pendingWork sees untagged rows, new Navidrome songs, and fails open on unknown', () => {
  assert.deepEqual(pendingWork({ dbUntagged: 3, dbRows: 100, navidromeCount: 100 }), { pending: true, reason: 'untagged' });
  // library.db has no row for a track until a walk finds it: Navidrome's count does.
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: 104 }), { pending: true, reason: 'new-in-navidrome' });
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: 100 }), { pending: false });
  // A removal is not work for the tagger.
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: 90 }), { pending: false });
  // A never-tagged station: no rows yet, songs in Navidrome.
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 0, navidromeCount: 50 }), { pending: true, reason: 'new-in-navidrome' });
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: null }), { pending: true, reason: 'unknown' });
  assert.deepEqual(pendingWork({ dbUntagged: null, dbRows: null, navidromeCount: 100 }), { pending: true, reason: 'unknown' });
  assert.equal(pendingWorkText({ dbUntagged: 0, dbRows: 100, navidromeCount: 104 }, { pending: true, reason: 'new-in-navidrome' }), '4 new in Navidrome');
});

test('the record reads leniently: corrupt or foreign is "never ran"', () => {
  for (const raw of [null, 'x', [], 42]) {
    assert.equal(normalizeTagScheduleRecord(raw).lastDay, null);
  }
  const r = normalizeTagScheduleRecord({ lastDay: '2026-11-07', outcome: 'ok', startedAt: '2026-11-07T02:30:00Z' });
  assert.equal(r.lastDay, '2026-11-07');
  assert.equal(r.outcome, 'ok');
  const bad = normalizeTagScheduleRecord({ lastDay: 'yesterday', outcome: 'exploded', startedAt: 'never' });
  assert.equal(bad.lastDay, null);
  assert.equal(bad.outcome, null);
  assert.equal(bad.startedAt, null);
});

test('quietAfterMinutes is the analysis pass rule: 1..120, else 10', () => {
  assert.equal(quietAfterMinutes(undefined), 10);
  assert.equal(quietAfterMinutes({ analyzeQuietMinutes: 25.9 }), 25);
  for (const bad of [0, 121, '15', Number.NaN, null]) {
    assert.equal(quietAfterMinutes({ analyzeQuietMinutes: bad }), 10, String(bad));
  }
});

test('the scheduled start never answers a replaced-file hold', () => {
  const opts = scheduledTaggerOptions(daily({ limit: 250, steps: { ...ALL_STEPS, enrich: false } }));
  assert.deepEqual(opts, { limit: 250, reconcile: true, enrich: false, tagMoods: true, analyze: true });
  assert.equal('confirmReplaced' in opts, false);
  assert.equal('acceptReplaced' in opts, false);
  // 0 is the Run tab's "all": no --limit at all.
  assert.equal(scheduledTaggerOptions(daily()).limit, undefined);
});

// ---------------------------------------------------------------------------
// The tick, through fake deps

function harness(over: {
  auto?: Auto;
  running?: boolean;
  counts?: { dbUntagged: number | null; dbRows: number | null; navidromeCount: number | null; scanning: boolean | null };
  quiet?: { enabled: boolean; minutes: number };
  listeners?: number | null;
  record?: unknown;
  startThrows?: boolean;
} = {}) {
  const h = {
    auto: over.auto ?? daily(),
    running: over.running ?? false,
    counts: over.counts ?? { dbUntagged: 5, dbRows: 100, navidromeCount: 100, scanning: false },
    quiet: over.quiet ?? { enabled: false, minutes: 10 },
    listeners: ('listeners' in over ? over.listeners : 0) as number | null,
    today: '2026-11-07',
    minuteOfDay: 151,
    countCalls: 0,
    probeCalls: 0,
    starts: [] as Array<{ kind: string; onExit: (end: any) => void }>,
    writes: [] as any[],
    logs: [] as string[],
  };
  const schedule = createTagSchedule({
    auto: () => h.auto,
    clock: () => ({ today: h.today, minuteOfDay: h.minuteOfDay }),
    running: () => h.running,
    counts: async () => { h.countCalls++; return h.counts; },
    quiet: () => h.quiet,
    probeListeners: async () => { h.probeCalls++; return h.listeners; },
    start: (kind, _auto, onExit) => {
      if (over.startThrows) throw new Error('spawn exploded');
      h.starts.push({ kind, onExit });
    },
    readRecord: async () => over.record ?? null,
    writeRecord: async (rec) => { h.writes.push(rec); },
    log: (m) => { h.logs.push(m); },
  });
  return { h, schedule };
}

const T0 = new Date('2026-11-07T02:31:00Z');
const later = (min: number) => new Date(T0.getTime() + min * 60_000);
const end = (o: Partial<{ outcome: string; error: string | null; holds: string[] }> = {}) => ({
  mode: 'tag', outcome: 'ok', exitCode: 0, signal: null, error: null,
  startedAt: T0.toISOString(), finishedAt: T0.toISOString(), holds: [], runLogId: 'tagger-run-x', ...o,
});

test('an off schedule asks nothing of Navidrome, Icecast or the disk beyond its record', async () => {
  const { h, schedule } = harness({ auto: daily({ mode: 'off' }) });
  await schedule.tick(T0);
  assert.equal(h.countCalls, 0);
  assert.equal(h.probeCalls, 0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.length, 0);
});

test('before the set time nothing is counted or started', async () => {
  const { h, schedule } = harness();
  h.minuteOfDay = 149;
  await schedule.tick(T0);
  assert.equal(h.countCalls, 0);
  assert.equal(h.starts.length, 0);
});

test('a due day with work starts one tag run and records it', async () => {
  const { h, schedule } = harness();
  await schedule.tick(T0);
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].kind, 'tag');
  const rec = h.writes.at(-1);
  assert.equal(rec.lastDay, '2026-11-07');
  assert.equal(rec.outcome, 'running');
  assert.match(rec.detail, /5 untagged, all untagged/);
  // The day is used: a second tick, even after the run ends, starts nothing.
  h.starts[0].onExit(end());
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 1);
  assert.equal(h.writes.at(-1).outcome, 'ok');
});

test('nothing untagged skips and uses the day', async () => {
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 100, navidromeCount: 100, scanning: false } });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).outcome, 'skipped');
  assert.equal(h.writes.at(-1).lastDay, '2026-11-07');
  h.counts = { dbUntagged: 3, dbRows: 100, navidromeCount: 103, scanning: false };
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 0, 'the run is daily: new music waits for tomorrow');
  h.today = '2026-11-08';
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts.length, 1);
});

test('no steps on skips the day without counting', async () => {
  const off = { reconcile: false, enrich: false, tagMoods: false, analyze: false };
  const { h, schedule } = harness({ auto: daily({ steps: off }) });
  await schedule.tick(T0);
  assert.equal(h.countCalls, 0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).outcome, 'skipped');
});

test('reconcile only starts the reconcile run', async () => {
  const off = { reconcile: false, enrich: false, tagMoods: false, analyze: false };
  const { h, schedule } = harness({ auto: daily({ steps: { ...off, reconcile: true } }) });
  await schedule.tick(T0);
  assert.equal(h.starts[0].kind, 'reconcile');
});

test('a run already going holds the start without using the day', async () => {
  const { h, schedule } = harness({ running: true });
  await schedule.tick(T0);
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.length, 0, 'a hold is not a used day');
  assert.equal(h.logs.filter((l) => /waiting/.test(l)).length, 1, 'logged once per hold, not per tick');
  assert.match((await schedule.view()).waiting ?? '', /another tagger/);
  h.running = false;
  await schedule.tick(later(10));
  assert.equal(h.starts.length, 1);
  assert.equal((await schedule.view()).waiting, null);
});

test('a Navidrome scan in progress holds the start', async () => {
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 100, navidromeCount: 120, scanning: true } });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  h.counts = { ...h.counts, scanning: false };
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 1);
});

test('quiet times hold the start until the quiet gate passes', async () => {
  const { h, schedule } = harness({ quiet: { enabled: true, minutes: 10 }, listeners: 2 });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.match((await schedule.view()).waiting ?? '', /2 listening/);
  // The listeners leave: the full window must elapse from here.
  h.listeners = 0;
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 0);
  await schedule.tick(later(10));
  assert.equal(h.starts.length, 0, 'five minutes of quiet is not ten');
  await schedule.tick(later(15));
  assert.equal(h.starts.length, 1);
});

test('an unknown listener count fails open, like the analysis gate', async () => {
  const { h, schedule } = harness({ quiet: { enabled: true, minutes: 10 }, listeners: null });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 1);
});

test('quiet times off never probes Icecast', async () => {
  const { h, schedule } = harness();
  await schedule.tick(T0);
  assert.equal(h.probeCalls, 0);
});

test('a hold standing at midnight lapses that day and says so', async () => {
  const { h, schedule } = harness({ running: true });
  await schedule.tick(T0);
  h.today = '2026-11-08';
  h.minuteOfDay = 10;
  await schedule.tick(later(22 * 60));
  assert.ok(h.logs.some((l) => /did not run on 2026-11-07/.test(l)));
  assert.equal(h.writes.at(-1).outcome, 'missed');
  assert.equal(h.writes.at(-1).lastDay, '2026-11-07');
  assert.equal(h.starts.length, 0);
});

test('a failed run is logged and not retried the same day', async () => {
  const { h, schedule } = harness();
  await schedule.tick(T0);
  h.starts[0].onExit(end({ outcome: 'failed', error: 'LLM unreachable' }));
  assert.ok(h.logs.some((l) => /failed: LLM unreachable/.test(l)));
  assert.equal(h.writes.at(-1).outcome, 'failed');
  await schedule.tick(later(5));
  await schedule.tick(later(60));
  assert.equal(h.starts.length, 1);
});

test('a held run is recorded as held and said in the booth log', async () => {
  const { h, schedule } = harness();
  await schedule.tick(T0);
  h.starts[0].onExit(end({ holds: ['12 files look replaced; confirm before re-tagging'] }));
  assert.equal(h.writes.at(-1).outcome, 'held');
  assert.match(h.writes.at(-1).detail, /look replaced/);
  assert.ok(h.logs.some((l) => /held for the operator: 12 files look replaced/.test(l)));
});

test('a start that throws records a failure and does not retry', async () => {
  const { h, schedule } = harness({ startThrows: true });
  await schedule.tick(T0);
  assert.equal(h.writes.at(-1).outcome, 'failed');
  await schedule.tick(later(5));
  assert.equal(h.writes.at(-1).outcome, 'failed');
  assert.equal(h.logs.filter((l) => /could not start/.test(l)).length, 1);
});

test('the record survives a restart: the day is not run twice', async () => {
  const { h, schedule } = harness({
    record: { version: 1, lastDay: '2026-11-07', outcome: 'ok', startedAt: '2026-11-07T02:31:00Z' },
  });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.countCalls, 0);
  assert.equal((await schedule.view()).outcome, 'ok');
});

test('a run the record says is going was interrupted by the restart', async () => {
  const { h, schedule } = harness({
    record: { version: 1, lastDay: '2026-11-07', outcome: 'running', startedAt: '2026-11-07T02:31:00Z' },
  });
  await schedule.tick(T0);
  assert.equal(h.writes.at(-1).outcome, 'interrupted');
  assert.equal(h.starts.length, 0, 'an interrupted day is still a used day');
});

// ---------------------------------------------------------------------------
// Settings plumbing

test('an absent block is the pre-existing station: off', async () => {
  assert.equal(DEFAULTS.tagger.auto.mode, 'off');
  assert.equal(SETTINGS_TAGGER_AUTO_MODES[0], 'off');
  const s = await coldLoadSettings({});
  assert.deepEqual(s.tagger.auto, DEFAULTS.tagger.auto);
});

test('a configured schedule survives a cold load', async () => {
  await coldLoadSettings({});
  await settings.update({
    tagger: { auto: { mode: 'daily', time: '03:15', limit: 200, steps: { analyze: false } } },
  });
  setCache(null);
  await settings.load();
  const a = settings.get().tagger.auto;
  assert.equal(a.mode, 'daily');
  assert.equal(a.time, '03:15');
  assert.equal(a.limit, 200);
  assert.deepEqual(a.steps, { reconcile: true, enrich: true, tagMoods: true, analyze: false });
});

test('a partial patch keeps the fields it does not name', async () => {
  await coldLoadSettings({ tagger: { auto: { mode: 'daily', time: '01:00', limit: 50 } } });
  await settings.update({ tagger: { auto: { time: '04:45' } } });
  const a = settings.get().tagger.auto;
  assert.equal(a.mode, 'daily');
  assert.equal(a.limit, 50);
  assert.equal(a.time, '04:45');
});

test('saving the schedule does NOT ask for a mixer restart', async () => {
  await coldLoadSettings({});
  const r = await settings.update({ tagger: { auto: { mode: 'daily' } } });
  assert.equal(r.requiresRestart, false);
});

test('the load path repairs each field on its own; a bad mode reads as off', () => {
  for (const bad of ['DAILY', 'nightly', 1, null, {}]) {
    assert.equal(normalizeTaggerAuto({ mode: bad, time: '03:00' }).mode, 'off', JSON.stringify(bad));
  }
  const a = normalizeTaggerAuto({ mode: 'daily', time: '25:00', limit: 'lots', steps: { enrich: 'no', analyze: false } });
  assert.equal(a.mode, 'daily', 'a bad time must not disarm a schedule the operator set');
  assert.equal(a.time, DEFAULTS.tagger.auto.time);
  assert.equal(a.limit, 0);
  assert.equal(a.steps.enrich, true);
  assert.equal(a.steps.analyze, false);
  assert.equal(normalizeTaggerAuto({ limit: -5 }).limit, 0);
  assert.equal(normalizeTaggerAuto({ limit: 12.7 }).limit, 12);
  assert.deepEqual(normalizeTaggerAuto(undefined), DEFAULTS.tagger.auto);
});

test('the save path refuses what the load path repairs, naming the field', () => {
  assert.equal(taggerPatchSchema.safeParse({ auto: { mode: 'daily', time: '02:30', limit: 0 } }).success, true);
  const refuse = (auto: unknown) => taggerPatchSchema.safeParse({ auto });
  assert.match(refuse({ mode: 'nightly' }).error!.issues[0].message, /^tagger\.auto\.mode must be one of: off, daily/);
  for (const t of ['2:30', '24:00', '02:30pm', '', 230]) {
    assert.match(refuse({ time: t }).error!.issues[0].message, /^tagger\.auto\.time must be HH:MM/, String(t));
  }
  for (const l of [-1, 1_000_001, 'many']) {
    assert.match(refuse({ limit: l }).error!.issues[0].message, /^tagger\.auto\.limit must be int/, String(l));
  }
  // settingsBlockOf's leniency: a non-object block is a no-op, not an error.
  assert.deepEqual(taggerPatchSchema.parse(null), {});
});

test('the admin form runs the same field rules on the whole block', () => {
  assert.deepEqual(taggerAutoFormSchema.parse(DEFAULTS.tagger.auto), DEFAULTS.tagger.auto);
  const bad = taggerAutoFormSchema.safeParse({ ...DEFAULTS.tagger.auto, time: '7pm' });
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0].message, /^tagger\.auto\.time must be HH:MM/);
  // The form posts the whole block, which the patch accepts as it stands.
  assert.equal(taggerPatchSchema.safeParse({ auto: DEFAULTS.tagger.auto }).success, true);
});

test('update() refuses a bad patch and leaves the stored schedule alone', async () => {
  await coldLoadSettings({ tagger: { auto: { mode: 'daily', time: '01:00' } } });
  await assert.rejects(settings.update({ tagger: { auto: { time: '1am' } } }), /tagger\.auto\.time/);
  assert.equal(settings.get().tagger.auto.time, '01:00');
});

test('the key is in the patch inventory, so POST /settings accepts it', async () => {
  const { validateSettingsPatch } = await import('../src/settings/patch-registry.js');
  assert.equal(validateSettingsPatch({ tagger: { auto: { mode: 'daily' } } }), null);
  const bad = validateSettingsPatch({ tagger: { auto: { time: 'noon' } } });
  assert.ok(bad, 'a bad time should be refused at the route');
  assert.ok(bad!.fieldErrors?.['tagger.auto.time'], JSON.stringify(bad!.fieldErrors));
});

// ---------------------------------------------------------------------------
// The tagger's exit callback

test('startTagger reports a failed spawn to its onExit, once', async () => {
  const tagger = await import('../src/broadcast/tagger.js');
  const realPath = process.env.PATH;
  process.env.PATH = path.join(stateRoot, 'no-binaries-here');
  const ends: any[] = [];
  try {
    writeFileSync(path.join(stateRoot, 'tagger.pid'), JSON.stringify({ pid: 2147483647 }));
    tagger.startTagger({ limit: 1, onExit: (e) => ends.push(e) });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(ends.length, 1);
    assert.equal(ends[0].outcome, 'failed');
    assert.ok(Array.isArray(ends[0].holds));
    assert.equal(existsSync(path.join(stateRoot, 'tagger.pid')), false);
  } finally {
    process.env.PATH = realPath;
  }
});
