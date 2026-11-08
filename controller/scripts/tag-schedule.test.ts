// Scheduled tagging (#2282): settings.tagger.auto starts a daily tagger run at
// a set station-clock time. Pins the policy (music/tag-schedule-policy.ts), the
// tick (broadcast/tag-schedule.ts, driven through injected deps so nothing
// spawns), the settings plumbing (cold-load round trip, patch inventory, the
// strict/lenient split) and the tagger's exit callback.
// Run: `npm test -- tag-schedule`.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';
import { coldLoadSettings } from './test-utils/settings.js';

const stateRoot = createTempDir(path.join(tmpdir(), 'subwave-tag-schedule-'));
process.env.STATE_DIR = stateRoot;

const {
  armedStep,
  baselineOnSuccess,
  holdStep,
  lapsedHold,
  lowerBaseline,
  newMusicBaseline,
  normalizeTagScheduleRecord,
  pendingWork,
  pendingWorkText,
  restartRecovery,
  scheduleArmChanged,
  scheduleDue,
  scheduleGate,
  scheduleMinuteOfDay,
  scheduledRunEnded,
  scheduledRunKind,
  skippedStep,
  startFailedStep,
  startingStep,
} = await import('../src/music/tag-schedule-policy.js');
const { createTagSchedule, scheduledTaggerOptions, scheduledTagView, untaggedWorkCount } = await import('../src/broadcast/tag-schedule.js');
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

test("scheduleDue: armed after today's time owes nothing today; armed before it still catches up", () => {
  const base = { auto: daily(), today: '2026-11-07', lastDay: '2026-11-06' };
  const armed = (today: string, minuteOfDay: number) => ({ today, minuteOfDay });
  // Turned on at 14:00 with the time at 02:30: no run today...
  assert.equal(scheduleDue({ ...base, minuteOfDay: 14 * 60 + 5, armed: armed('2026-11-07', 14 * 60) }), 'armed-after');
  // ...and tomorrow it is due at 02:30.
  assert.equal(scheduleDue({ ...base, today: '2026-11-08', minuteOfDay: 150, armed: armed('2026-11-07', 14 * 60) }), 'due');
  // Armed before the time, today or any earlier day: a controller that was
  // down across the time still catches the day up.
  assert.equal(scheduleDue({ ...base, minuteOfDay: 14 * 60, armed: armed('2026-11-07', 60) }), 'due');
  assert.equal(scheduleDue({ ...base, minuteOfDay: 14 * 60, armed: armed('2026-11-01', 15 * 60) }), 'due');
  // Set to the current minute: that minute has not passed, so it is due.
  assert.equal(scheduleDue({ ...base, minuteOfDay: 150, armed: armed('2026-11-07', 150) }), 'due');
  // A later time today is not due yet, however it was armed.
  assert.equal(
    scheduleDue({ ...base, auto: daily({ time: '20:00' }), minuteOfDay: 14 * 60, armed: armed('2026-11-07', 14 * 60) }),
    'not-due',
  );
});

test('scheduleArmChanged: turning it on or moving its time arms; nothing else does', () => {
  const off = { mode: 'off' as const, time: '02:30' };
  const on = { mode: 'daily' as const, time: '02:30' };
  assert.equal(scheduleArmChanged(off, on), true);
  assert.equal(scheduleArmChanged(undefined, on), true);
  assert.equal(scheduleArmChanged(on, { ...on, time: '10:00' }), true);
  assert.equal(scheduleArmChanged(on, on), false, 'a steps or limit save does not arm');
  assert.equal(scheduleArmChanged(on, off), false);
  assert.equal(scheduleArmChanged(off, { ...off, time: '10:00' }), false);
  assert.deepEqual(
    armedStep(new Date('2026-11-07T14:00:00Z')),
    { patch: { armedAt: '2026-11-07T14:00:00.000Z' }, message: null },
  );
});

test('scheduledRunKind mirrors the Run tab: none, reconcile only, or a tag run', () => {
  const off = { reconcile: false, enrich: false, tagMoods: false, analyze: false };
  assert.equal(scheduledRunKind(off), null);
  assert.equal(scheduledRunKind({ ...off, reconcile: true }), 'reconcile');
  assert.equal(scheduledRunKind({ ...off, analyze: true }), 'tag');
  assert.equal(scheduledRunKind(ALL_STEPS), 'tag');
});

// The stand-in a first night uses: library.db's rows (newMusicBaseline).
const TAG = { tagMoods: true, baseline: 100 };

test('pendingWork sees untagged rows, new Navidrome songs, and fails open on unknown', () => {
  assert.deepEqual(pendingWork({ dbUntagged: 3, dbRows: 100, navidromeCount: 100 }, TAG), { pending: true, reason: 'untagged', amount: 3 });
  // library.db has no row for a track until a walk finds it: Navidrome's count does.
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: 104 }, TAG), { pending: true, reason: 'new-in-navidrome', amount: 4 });
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: 100 }, TAG), { pending: false });
  // A never-tagged station: no rows yet, songs in Navidrome.
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 0, navidromeCount: 50 }, { tagMoods: true, baseline: 0 }), { pending: true, reason: 'new-in-navidrome', amount: 50 });
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: 100, navidromeCount: null }, TAG), { pending: true, reason: 'unknown', amount: null });
  assert.deepEqual(pendingWork({ dbUntagged: null, dbRows: null, navidromeCount: 100 }, TAG), { pending: true, reason: 'unknown', amount: null });
  assert.deepEqual(pendingWork({ dbUntagged: 0, dbRows: null, navidromeCount: 100 }, { tagMoods: true, baseline: null }), { pending: true, reason: 'unknown', amount: null });
  assert.equal(pendingWorkText({ pending: true, reason: 'new-in-navidrome', amount: 4 }), '4 new in Navidrome');
});

test('pendingWork compares Navidrome with the baseline, not library.db rows', () => {
  // One blocklisted song: Navidrome counts it, the walk never writes its row.
  const counts = { dbUntagged: 0, dbRows: 99, navidromeCount: 100 };
  // With no saved baseline the rows stand in, so the first night runs...
  assert.equal(pendingWork(counts, { tagMoods: true, baseline: newMusicBaseline(null, counts) }).pending, true);
  // ...and once a walk started from 100 succeeds, the gap is no longer work.
  assert.deepEqual(pendingWork(counts, { tagMoods: true, baseline: newMusicBaseline(100, counts) }), { pending: false });
  // A real addition beyond the baseline still is.
  const more = { ...counts, navidromeCount: 103 };
  assert.deepEqual(
    pendingWork(more, { tagMoods: true, baseline: newMusicBaseline(100, more) }),
    { pending: true, reason: 'new-in-navidrome', amount: 3 },
  );
});

test('pendingWork: untagged rows are work only for a run that tags moods', () => {
  const counts = { dbUntagged: 40, dbRows: 100, navidromeCount: 100 };
  assert.deepEqual(pendingWork(counts, { tagMoods: false, baseline: 100 }), { pending: false });
  // An unreadable library.db does not matter to a run that does not tag moods.
  assert.deepEqual(pendingWork({ ...counts, dbUntagged: null }, { tagMoods: false, baseline: 100 }), { pending: false });
  assert.equal(pendingWork(counts, { tagMoods: true, baseline: 100 }).pending, true);
});

test('newMusicBaseline: the saved baseline, else the rows, lowered either way', () => {
  assert.equal(newMusicBaseline(100, { dbUntagged: 0, dbRows: 5, navidromeCount: 120 }), 100);
  assert.equal(newMusicBaseline(null, { dbUntagged: 0, dbRows: 99, navidromeCount: 100 }), 99);
  // Stale rows above Navidrome's count: the stand-in comes down to it.
  assert.equal(newMusicBaseline(null, { dbUntagged: 0, dbRows: 10000, navidromeCount: 9500 }), 9500);
  assert.equal(newMusicBaseline(null, { dbUntagged: 0, dbRows: null, navidromeCount: 9500 }), null);
});

test('baselineOnSuccess: the start count, never capped by a limit', () => {
  assert.equal(baselineOnSuccess(100, 1100), 1100);
  assert.equal(baselineOnSuccess(null, 1100), 1100);
  assert.equal(baselineOnSuccess(100, null), 100);
});

test('lowerBaseline: a removal lowers it, nothing here raises it', () => {
  assert.equal(lowerBaseline(100, 90), 90);
  assert.equal(lowerBaseline(100, 120), 100);
  assert.equal(lowerBaseline(null, 90), null);
  assert.equal(lowerBaseline(100, null), 100);
});

test('scheduleGate checks a scan before judging the work', () => {
  const g = scheduleGate({
    auto: daily(), today: '2026-11-07', minuteOfDay: 151, lastDay: null, walkedCount: 100,
    running: false, quiet: { enabled: false, minutes: 10 }, quietState: { quietSince: null }, nowMs: 0,
    // Mid-scan, nothing new is visible yet: that must hold, not spend the day.
    counts: { dbUntagged: 0, dbRows: 100, navidromeCount: 100, scanning: true },
  });
  assert.equal(g.kind, 'hold');
  assert.equal(g.kind === 'hold' && g.reason, 'scanning');
});

test('scheduleGate asks for each input only when it needs it', () => {
  const base = {
    auto: daily(), today: '2026-11-07', minuteOfDay: 151, lastDay: null, walkedCount: null,
    running: false, quietState: { quietSince: null }, nowMs: 0,
  };
  assert.equal(scheduleGate({ ...base, quiet: { enabled: false, minutes: 10 } }).kind, 'need-counts');
  const counts = { dbUntagged: 1, dbRows: 100, navidromeCount: 100, scanning: false };
  assert.equal(scheduleGate({ ...base, counts, quiet: { enabled: true, minutes: 10 } }).kind, 'need-listeners');
  assert.equal(scheduleGate({ ...base, counts, quiet: { enabled: false, minutes: 10 } }).kind, 'start');
  assert.equal(scheduleGate({ ...base, counts, running: true, quiet: { enabled: false, minutes: 10 } }).kind, 'hold');
});

test('scheduledRunEnded: only a clean finish raises the baseline, to raiseTo', () => {
  const rec = { raiseTo: 120, walkedCount: 100 };
  const run = { error: null, signal: null, exitCode: 0, holds: [] as string[], runLogId: 'r' };
  assert.equal(scheduledRunEnded(rec, { ...run, outcome: 'ok' }).patch!.walkedCount, 120);
  assert.equal('walkedCount' in scheduledRunEnded(rec, { ...run, outcome: 'failed', exitCode: 1 }).patch!, false);
  assert.equal('walkedCount' in scheduledRunEnded(rec, { ...run, outcome: 'stopped', signal: 'SIGTERM' }).patch!, false);
  // A hold outranks a clean exit, and leaves the baseline, so the run comes back.
  const held = scheduledRunEnded(rec, { ...run, outcome: 'ok', holds: ['a', 'b'] });
  assert.equal(held.patch!.outcome, 'held');
  assert.equal(held.patch!.detail, 'a (+1 more)');
  assert.equal('walkedCount' in held.patch!, false);
  // An unknown raise target keeps the old baseline.
  assert.equal(scheduledRunEnded({ raiseTo: null, walkedCount: 100 }, { ...run, outcome: 'ok' }).patch!.walkedCount, 100);
  const failed = scheduledRunEnded(rec, { ...run, outcome: 'failed', exitCode: 1, error: 'LLM unreachable' });
  assert.match(failed.message!, /failed: LLM unreachable\. Not retried/);
});

test('lapsedHold: a hold from an earlier day lapses, recorded unless that day was used', () => {
  const w = { day: '2026-11-07', reason: 'busy' as const, text: 'x' };
  assert.equal(lapsedHold(null, '2026-11-08', null), null);
  assert.equal(lapsedHold({ ...w, day: '2026-11-08' }, '2026-11-08', null), null);
  const missed = lapsedHold(w, '2026-11-08', null)!;
  assert.deepEqual(missed.patch, { lastDay: '2026-11-07', startedAt: null, outcome: 'missed', detail: 'x', runLogId: null });
  assert.match(missed.message!, /did not run on 2026-11-07: x all day/);
  const used = lapsedHold(w, '2026-11-08', '2026-11-07')!;
  assert.equal(used.patch, null);
  assert.ok(used.message);
});

test('restartRecovery: only a running record this process did not start is interrupted', () => {
  assert.equal(restartRecovery({ outcome: 'ok' }, false), null);
  assert.equal(restartRecovery({ outcome: 'running' }, true), null);
  const step = restartRecovery({ outcome: 'running' }, false)!;
  assert.equal(step.patch!.outcome, 'interrupted');
  assert.equal('lastDay' in step.patch!, false, 'the day stays used');
});

test('holdStep logs once per reason and day', () => {
  const g = { reason: 'busy' as const, text: 'busy text' };
  const first = holdStep(null, g, '2026-11-07');
  assert.match(first.message!, /waiting: busy text/);
  assert.equal(holdStep(first.waiting, g, '2026-11-07').message, null);
  assert.ok(holdStep(first.waiting, { reason: 'quiet', text: 'q' }, '2026-11-07').message);
  assert.ok(holdStep(first.waiting, g, '2026-11-08').message);
});

test('skip, start and a failed start write the record the tick saves', () => {
  const skip = skippedStep('2026-11-07', { detail: 'nothing new or untagged', walkedCount: 90 });
  assert.deepEqual(skip.patch, {
    lastDay: '2026-11-07', startedAt: null, outcome: 'skipped', detail: 'nothing new or untagged', runLogId: null, walkedCount: 90,
  });
  const start = startingStep('2026-11-07', '2026-11-07T02:31:00.000Z', { detail: '4 new', walkedCount: 100, raiseTo: 104 });
  assert.equal(start.patch!.outcome, 'running');
  assert.equal(start.patch!.lastDay, '2026-11-07', 'a start uses the day before the spawn');
  assert.equal(start.patch!.raiseTo, 104);
  assert.match(start.message!, /starting \(4 new\)/);
  const failed = startFailedStep('spawn exploded');
  assert.deepEqual(failed.patch, { outcome: 'failed', detail: 'could not start: spawn exploded' });
  assert.match(failed.message!, /Not retried/);
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
  const counts = normalizeTagScheduleRecord({ walkedCount: 120, raiseTo: -1 });
  assert.equal(counts.walkedCount, 120);
  assert.equal(counts.raiseTo, null);
  assert.equal(normalizeTagScheduleRecord({ walkedCount: '120' }).walkedCount, null);
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
  // 0 is the Run tab's "all": startTagger sends no --limit for it.
  assert.equal(scheduledTaggerOptions(daily()).limit, 0);
});

// ---------------------------------------------------------------------------
// The tick, through fake deps

const utcClock = (d: Date) => ({ today: d.toISOString().slice(0, 10), minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes() });
const at = (iso: string) => new Date(iso);

function harness(over: {
  auto?: Auto;
  running?: boolean;
  counts?: { dbUntagged: number | null; dbRows: number | null; navidromeCount: number | null; scanning: boolean | null };
  quiet?: { enabled: boolean; minutes: number };
  listeners?: number | null;
  record?: unknown;
  startThrows?: boolean;
  /** Read the station clock off the tick's own Date (UTC), not h.today. */
  utcClock?: boolean;
  /** Holds the record read open until it resolves. */
  readGate?: Promise<void>;
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
    reads: 0,
    starts: [] as Array<{ kind: string; onExit: (end: any) => void }>,
    writes: [] as any[],
    logs: [] as string[],
    onCounts: undefined as undefined | (() => void),
    onProbe: undefined as undefined | (() => void),
  };
  const schedule = createTagSchedule({
    auto: () => h.auto,
    clock: (now) => (over.utcClock ? utcClock(now) : { today: h.today, minuteOfDay: h.minuteOfDay }),
    running: () => h.running,
    counts: async () => { h.countCalls++; h.onCounts?.(); return h.counts; },
    quiet: () => h.quiet,
    probeListeners: async () => { h.probeCalls++; h.onProbe?.(); return h.listeners; },
    start: (kind, _auto, onExit) => {
      if (over.startThrows) throw new Error('spawn exploded');
      h.starts.push({ kind, onExit });
    },
    readRecord: async () => {
      h.reads++;
      if (over.readGate) await over.readGate;
      return over.record ?? null;
    },
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

test('reconcile only starts the reconcile run, for new music only', async () => {
  const off = { reconcile: false, enrich: false, tagMoods: false, analyze: false };
  // Untagged rows are not work for a run that does not tag moods.
  const { h, schedule } = harness({ auto: daily({ steps: { ...off, reconcile: true } }) });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).outcome, 'skipped');
  h.today = '2026-11-08';
  h.counts = { dbUntagged: 5, dbRows: 100, navidromeCount: 104, scanning: false };
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts[0].kind, 'reconcile');
  assert.match(h.writes.at(-1).detail, /reconcile only, 4 new in Navidrome/);
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

test('a scan holds even when nothing looks new yet, and does not spend the day', async () => {
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 100, navidromeCount: 100, scanning: true } });
  await schedule.tick(T0);
  assert.equal(h.writes.length, 0, 'a hold is not a used day');
  assert.match((await schedule.view()).waiting ?? '', /scanning/);
  // The scan finishes having found new music: the same day runs.
  h.counts = { dbUntagged: 0, dbRows: 100, navidromeCount: 130, scanning: false };
  await schedule.tick(later(5));
  assert.equal(h.starts.length, 1);
});

test('a manual Start during the count read wins; the schedule does not start a second run', async () => {
  const { h, schedule } = harness();
  h.onCounts = () => { h.running = true; };
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.length, 0, 'the day is not used');
  assert.match((await schedule.view()).waiting ?? '', /another tagger/);
});

test('a manual Start during the listener probe wins too', async () => {
  const { h, schedule } = harness({ quiet: { enabled: true, minutes: 10 }, listeners: null });
  h.onProbe = () => { h.running = true; };
  await schedule.tick(T0);
  assert.equal(h.probeCalls, 1);
  assert.equal(h.starts.length, 0);
});

test('one blocklisted song: the first night runs, then the gap is never work again', async () => {
  // Navidrome counts 100; the walk drops one blocklisted song, so 99 rows.
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 99, navidromeCount: 100, scanning: false } });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 1);
  assert.equal(h.writes.at(-1).raiseTo, 100);
  h.starts[0].onExit(end());
  assert.equal(h.writes.at(-1).walkedCount, 100);
  h.today = '2026-11-08';
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts.length, 1, 'the same gap the next night is nothing new');
  assert.equal(h.writes.at(-1).outcome, 'skipped');
  assert.match(h.writes.at(-1).detail, /nothing new/);
  // Three songs land: that is new music.
  h.counts = { ...h.counts, navidromeCount: 103 };
  h.today = '2026-11-09';
  await schedule.tick(later(48 * 60));
  assert.equal(h.starts.length, 2);
  assert.match(h.writes.at(-1).detail, /3 new in Navidrome/);
});

test('a removal lowers the baseline, so a later addition still counts', async () => {
  const { h, schedule } = harness({
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100 },
    counts: { dbUntagged: 0, dbRows: 90, navidromeCount: 90, scanning: false },
  });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).walkedCount, 90);
  h.counts = { ...h.counts, navidromeCount: 92 };
  h.today = '2026-11-08';
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts.length, 1);
});

test('with Tag moods off, untagged rows never start a run', async () => {
  const { h, schedule } = harness({
    auto: daily({ steps: { ...ALL_STEPS, tagMoods: false } }),
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100 },
    counts: { dbUntagged: 40, dbRows: 100, navidromeCount: 100, scanning: false },
  });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).outcome, 'skipped');
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

test('stale rows above Navidrome never hide new music: the first skip saves a real baseline', async () => {
  // The review's sequence: 10,000 rows, Navidrome 9,500, nothing untagged.
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 10000, navidromeCount: 9500, scanning: false } });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).outcome, 'skipped');
  assert.equal(h.writes.at(-1).walkedCount, 9500, 'the stand-in is lowered and saved');
  h.counts = { ...h.counts, navidromeCount: 9800 };
  h.today = '2026-11-08';
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts.length, 1, '300 new songs run the next night');
  assert.match(h.writes.at(-1).detail, /300 new in Navidrome/);
  h.starts[0].onExit(end());
  assert.equal(h.writes.at(-1).walkedCount, 9800);
  h.counts = { ...h.counts, navidromeCount: 9999 };
  h.today = '2026-11-09';
  await schedule.tick(later(48 * 60));
  assert.equal(h.starts.length, 2);
  assert.match(h.writes.at(-1).detail, /199 new in Navidrome/);
});

test('a stand-in below Navidrome runs the first night', async () => {
  const { h, schedule } = harness({ counts: { dbUntagged: 0, dbRows: 95, navidromeCount: 100, scanning: false } });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 1);
  assert.match(h.writes.at(-1).detail, /5 new in Navidrome/);
  assert.equal(h.writes.at(-1).walkedCount, 95);
  assert.equal(h.writes.at(-1).raiseTo, 100);
});

test('a limit never caps the raise: a gap the walk cannot close costs one walk, then skips', async () => {
  // 50,000 songs in Navidrome, 5,000 of them never rows (blocklisted,
  // mixdowns), limit 250. Capping the raise at the limit would take 20 walks.
  for (const steps of [ALL_STEPS, { reconcile: true, enrich: false, tagMoods: false, analyze: false }]) {
    const { h, schedule } = harness({
      auto: daily({ limit: 250, steps: { ...steps } }),
      counts: { dbUntagged: 0, dbRows: 45000, navidromeCount: 50000, scanning: false },
    });
    await schedule.tick(T0);
    assert.equal(h.starts.length, 1);
    assert.equal(h.writes.at(-1).raiseTo, 50000);
    h.starts[0].onExit(end());
    assert.equal(h.writes.at(-1).walkedCount, 50000);
    h.today = '2026-11-08';
    await schedule.tick(later(24 * 60));
    assert.equal(h.starts.length, 1, `the next night skips (${h.starts[0].kind})`);
    assert.equal(h.writes.at(-1).outcome, 'skipped');
  }
});

test('a night Navidrome reads 0 costs one extra walk when it recovers, not one per limit', async () => {
  const { h, schedule } = harness({
    auto: daily({ limit: 250 }),
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 50000 },
    counts: { dbUntagged: 0, dbRows: 50000, navidromeCount: 0, scanning: false },
  });
  await schedule.tick(T0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).walkedCount, 0, 'the reading lowers the baseline');
  h.counts = { ...h.counts, navidromeCount: 50000 };
  h.today = '2026-11-08';
  await schedule.tick(later(24 * 60));
  assert.equal(h.starts.length, 1, 'the recovery reads as new: one walk');
  h.starts[0].onExit(end());
  assert.equal(h.writes.at(-1).walkedCount, 50000);
  h.today = '2026-11-09';
  await schedule.tick(later(48 * 60));
  assert.equal(h.starts.length, 1, 'and only one');
  assert.equal(h.writes.at(-1).outcome, 'skipped');
});

test("turned on after today's time: no run today, the first run is tomorrow at the time", async () => {
  const { h, schedule } = harness({
    utcClock: true,
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100 },
  });
  await schedule.armed(at('2026-11-07T14:00:00Z'));
  assert.equal(h.writes.at(-1).armedAt, '2026-11-07T14:00:00.000Z');
  assert.equal(h.writes.at(-1).at, null, 'arming is not an outcome');
  await schedule.tick(at('2026-11-07T14:05:00Z'));
  await schedule.tick(at('2026-11-07T23:55:00Z'));
  assert.equal(h.countCalls, 0);
  assert.equal(h.starts.length, 0);
  await schedule.tick(at('2026-11-08T02:25:00Z'));
  assert.equal(h.starts.length, 0);
  await schedule.tick(at('2026-11-08T02:30:00Z'));
  assert.equal(h.starts.length, 1);
});

test('the time moved to one already past today: no run today', async () => {
  const { h, schedule } = harness({
    utcClock: true,
    auto: daily({ time: '20:00' }),
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100 },
  });
  await schedule.tick(at('2026-11-07T14:00:00Z'));
  h.auto = daily({ time: '10:00' });
  await schedule.armed(at('2026-11-07T14:02:00Z'));
  await schedule.tick(at('2026-11-07T14:05:00Z'));
  assert.equal(h.starts.length, 0);
  await schedule.tick(at('2026-11-08T10:00:00Z'));
  assert.equal(h.starts.length, 1);
});

test('a controller down across the set time catches the day up when it is back', async () => {
  // Armed at 01:00 for 02:30, then down from 02:00 to 14:00: a fresh process.
  const { h, schedule } = harness({
    utcClock: true,
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100, armedAt: '2026-11-07T01:00:00.000Z' },
  });
  await schedule.tick(at('2026-11-07T14:00:00Z'));
  assert.equal(h.starts.length, 1);
  h.starts[0].onExit(end());
  await schedule.tick(at('2026-11-07T14:05:00Z'));
  assert.equal(h.starts.length, 1);
});

test('a controller down across midnight runs the new day once and never the old one again', async () => {
  // Ran on the 7th, down from 23:00 to 03:00 on the 8th.
  const ran = harness({
    utcClock: true,
    record: { version: 1, lastDay: '2026-11-07', outcome: 'ok', walkedCount: 100, armedAt: '2026-11-01T12:00:00.000Z' },
  });
  await ran.schedule.tick(at('2026-11-08T03:00:00Z'));
  ran.h.starts[0]?.onExit(end());
  await ran.schedule.tick(at('2026-11-08T03:05:00Z'));
  assert.equal(ran.h.starts.length, 1);
  assert.equal(ran.h.writes.at(-1).lastDay, '2026-11-08');
  // Down from 02:00 on the 7th, before its run, to 03:00 on the 8th: the 7th
  // is not run late, and the 8th runs once.
  const missed = harness({
    utcClock: true,
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100, armedAt: '2026-11-01T12:00:00.000Z' },
  });
  await missed.schedule.tick(at('2026-11-08T03:00:00Z'));
  missed.h.starts[0]?.onExit(end());
  await missed.schedule.tick(at('2026-11-08T03:05:00Z'));
  assert.equal(missed.h.starts.length, 1);
  assert.equal(missed.h.writes.at(-1).lastDay, '2026-11-08');
});

test('onceAsync: concurrent first calls share one call; a failure lets the next call retry', async () => {
  const { onceAsync } = await import('../src/util/async-pool.js');
  let calls = 0;
  const shared = onceAsync(async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { n: calls }; });
  const [a, b] = await Promise.all([shared(), shared()]);
  assert.equal(calls, 1);
  assert.equal(a, b, 'the same instance');
  assert.equal(await shared(), a);
  let tries = 0;
  const flaky = onceAsync(async () => { tries++; if (tries === 1) throw new Error('first read failed'); return tries; });
  await assert.rejects(flaky(), /first read failed/);
  assert.equal(await flaky(), 2, 'retried after the failure');
  assert.equal(await flaky(), 2);
});

test('two first calls in a new process share one record read', async () => {
  let open!: () => void;
  const readGate = new Promise<void>((r) => { open = r; });
  const { h, schedule } = harness({
    readGate,
    record: { version: 1, lastDay: '2026-11-07', outcome: 'ok', walkedCount: 100 },
  });
  const tick = schedule.tick(T0);
  const view = schedule.view();
  open();
  await tick;
  assert.equal((await view).outcome, 'ok');
  assert.equal(h.reads, 1);
});

test('an armed() racing the first tick keeps armedAt', async () => {
  let open!: () => void;
  const readGate = new Promise<void>((r) => { open = r; });
  const { h, schedule } = harness({
    utcClock: true,
    readGate,
    record: { version: 1, lastDay: '2026-11-06', outcome: 'ok', walkedCount: 100 },
  });
  const tick = schedule.tick(at('2026-11-07T14:05:00Z'));
  const armed = schedule.armed(at('2026-11-07T14:00:00Z'));
  open();
  await Promise.all([tick, armed]);
  assert.equal(h.reads, 1);
  assert.equal((await schedule.view()).armedAt, '2026-11-07T14:00:00.000Z');
  assert.equal(h.writes.at(-1).armedAt, '2026-11-07T14:00:00.000Z');
  // A later tick still reads it: armed after 02:30 today, so no run today.
  await schedule.tick(at('2026-11-07T14:10:00Z'));
  assert.equal(h.starts.length, 0);
  assert.equal(h.writes.at(-1).armedAt, '2026-11-07T14:00:00.000Z');
});

test('untaggable markers are work only once they stop matching what a run would ask', async () => {
  const db = await import('../src/music/library-db.js');
  const { tagInputFor, untaggableKey, tagPromptStamp, tagModelLabels } = await import('../src/music/tag-library/tag-input.js');
  await coldLoadSettings({});
  await db.open({ embeddingDim: 4 });
  db.upsertTrackMeta('silent', { title: '[silence]', artist: '[no artist]', album: 'Hidden', genres: [] });
  db.upsertTrackMeta('song', { title: 'Song', artist: 'Band', album: 'Album', genres: ['Rock'] });
  const [label] = tagModelLabels();
  db.markTrackUntaggable('silent', untaggableKey(tagInputFor(db.getTrack('silent')!), tagPromptStamp(), label));
  assert.equal(await untaggedWorkCount(), 1, 'a matching marker is held back, so not work');
  // Another model: the run asks the marked row again, so it is work.
  await coldLoadSettings({ llm: { model: 'another-model:7b' } });
  assert.notEqual(tagModelLabels()[0], label);
  assert.equal(await untaggedWorkCount(), 2);
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

test('a save that turns the schedule on or moves its time stamps armedAt; other saves do not', async () => {
  await coldLoadSettings({});
  const before = Date.now();
  await settings.update({ tagger: { auto: { mode: 'daily', time: '05:00' } } });
  const first = (await scheduledTagView()).armedAt;
  assert.ok(first && Date.parse(first) >= before, String(first));
  await settings.update({ tagger: { auto: { limit: 30, steps: { analyze: false } } } });
  assert.equal((await scheduledTagView()).armedAt, first, 'a limit or steps save does not arm');
  await new Promise((r) => setTimeout(r, 5));
  await settings.update({ tagger: { auto: { time: '06:00' } } });
  const moved = (await scheduledTagView()).armedAt;
  assert.ok(moved && moved > first!, 'moving the time arms again');
  const disk = JSON.parse(readFileSync(path.join(stateRoot, 'tagger-schedule.json'), 'utf8'));
  assert.equal(disk.armedAt, moved, 'kept in the record, so a restart keeps it');
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

test('a run end waits for close: a hold printed after exit is still reported', async () => {
  const { createRunEndReporter } = await import('../src/broadcast/tagger.js');
  const ends: any[] = [];
  const r = createRunEndReporter((e) => ends.push(e), 'run-1', () => {});
  const last = { mode: 'tag' as const, outcome: 'ok' as const, exitCode: 0, signal: null, error: null, startedAt: 'a', finishedAt: 'b' };
  r.exited(last);
  assert.equal(ends.length, 0, "'exit' alone does not report");
  r.hold('12 files look replaced');
  r.closed();
  r.closed();
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].holds, ['12 files look replaced']);
  assert.equal(ends[0].runLogId, 'run-1');
});

test('a run end that never sees close is reported after the grace', async () => {
  const { createRunEndReporter } = await import('../src/broadcast/tagger.js');
  const ends: any[] = [];
  const r = createRunEndReporter((e) => ends.push(e), null, () => {}, 20);
  r.hold('held');
  r.exited({ mode: 'tag', outcome: 'ok', exitCode: 0, signal: null, error: null, startedAt: 'a', finishedAt: 'b' });
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].holds, ['held']);
  r.closed();
  assert.equal(ends.length, 1, 'once');
});

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
