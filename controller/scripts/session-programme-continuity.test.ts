import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProgrammeState, SessionContext } from '../src/broadcast/session.js';
import type { generateProgrammePlan } from '../src/llm/dj.js';
import { emptyWeek } from '../src/schemas/schedule.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-programme-continuity-'));
process.env.STATE_DIR = root;
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const context = await import('../src/context.js');
const { config } = await import('../src/config.js');
after(() => rmSync(root, { recursive: true, force: true }));

const host = { ...settings.get().personas[0], id: 'p_continuity', name: 'Host' };
const guest = { ...host, id: 'p_next', name: 'Next host' };
const show = { id: 's_continuity', name: 'Friday Drive', topic: 'drive', programme: true, personaId: host.id };
const incoming = { ...show, id: 's_incoming', name: 'Dawn', personaId: guest.id };
const hour = 3600_000;
const friday = Date.parse('2026-10-09T23:00:00Z');

function ctx(ms: number): SessionContext {
  const at = new Date(ms);
  return {
    at: at.toISOString(), time: context.getTimeContext(at),
    date: context.getDateContext(at), clock: context.getClockContext(at),
    weather: { condition: 'unknown', mood: null, temp: null, tempUnit: 'C', location: '' },
    festival: null, dominantMood: 'calm', listeners: { count: 1 },
    activeShow: settings.resolveActiveShow(at), showHandover: null, episodeEditorial: '',
  };
}

async function schedule(week = emptyWeek(), timezone = 'UTC') {
  await settings.update({
    timezone, personas: [host, guest], activePersonaId: host.id,
    shows: [show, incoming], schedule: week, scheduleOverride: null,
    tts: { enabled: true }, djBehaviour: { sameHostAcknowledgement: false },
  });
}

function episode(status: ProgrammeState['status'] = 'ok'): ProgrammeState {
  return {
    status, plan: status === 'ok' ? { angle: 'Old angle', features: [{ topic: 'Feature' }] } : null,
    beats: { intro: true, 'feature:0': true, outro: true },
    introAiredAt: new Date(friday).toISOString(),
  };
}

function age() {
  session.getSession()!.startedAt = new Date(Date.now() - 4 * hour - 1).toISOString();
}

function save() {
  writeFileSync(config.session.currentFile, JSON.stringify(session.getSession()));
}

test('legacy recovery in next week\'s same show starts a fresh programme and archives the old beats', async () => {
  const week = emptyWeek();
  week[5][23] = show.id;
  await schedule(week);
  const old = session.start(ctx(friday - 7 * 24 * hour));
  delete old.takeoverStartedAt; // pre-upgrade persisted session
  session.attachProgramme(episode());
  age();
  save();
  const next = await session.recover(ctx(friday));
  assert.notEqual(next.id, old.id);
  assert.equal(next.programme, null);
  assert.deepEqual(JSON.parse(readFileSync(join(config.session.dir, `${old.id}.json`), 'utf8')).programme, episode());
  await settings.update({ tts: { enabled: false } });
  await programme.ensurePlan(ctx(friday));
  const planned = session.getProgramme();
  assert.ok(planned);
  assert.equal(planned.status, 'pending');
  assert.equal(planned.plan, null);
  assert.deepEqual(planned.beats, {});
  assert.equal(planned.introAiredAt, null);
});

test('a missed one-hour gap starts the next same-key airing even below the cap', async () => {
  const week = emptyWeek();
  week[5][20] = show.id;
  week[5][22] = show.id;
  await schedule(week);
  const old = session.start(ctx(friday - 3 * hour));
  session.attachProgramme(episode());
  const next = await session.maybeRoll(ctx(friday - hour));
  assert.notEqual(next.id, old.id);
  assert.equal(next.programme, null);
});

for (const status of ['ok', 'fallback', 'pending'] satisfies ProgrammeState['status'][]) {
  test(`a continuous overnight show preserves ${status} state across recovery and repeated caps`, async () => {
    const week = emptyWeek();
    week[5][23] = show.id;
    for (let h = 0; h < 12; h++) week[6][h] = show.id;
    await schedule(week);
    const old = session.start(ctx(friday));
    session.attachProgramme(episode(status));
    save();
    const resumed = await session.recover(ctx(friday + 4 * hour));
    assert.equal(resumed.id, old.id);
    const owned = resumed.programme;
    age();
    const capped = await session.maybeRoll(ctx(friday + 4 * hour));
    assert.notEqual(capped.id, old.id);
    assert.equal(capped.programme, owned);
    age();
    const again = await session.maybeRoll(ctx(friday + 8 * hour));
    assert.equal(again.programme, owned);
    session.markProgrammeBeat('feature:8');
    const archived = JSON.parse(readFileSync(join(config.session.dir, `${old.id}.json`), 'utf8'));
    assert.equal(archived.programme.beats['feature:8'], undefined);
  });
}

test('same-show takeover start, replacement and expiry are separate programme owners', async () => {
  const week = emptyWeek();
  for (const day of Object.values(week)) day.fill(show.id);
  await schedule(week);
  session.start(ctx(friday));
  session.attachProgramme(episode());
  await settings.update({ scheduleOverride: { showId: show.id, startedAt: friday + 60_000, expiresAt: friday + hour } });
  const takeover = await session.maybeRoll(ctx(friday + 60_000));
  assert.equal(takeover.programme, null);
  assert.equal(takeover.takeoverStartedAt, friday + 60_000);
  session.attachProgramme(episode());
  age();
  assert.equal((await session.maybeRoll(ctx(friday + 120_000))).programme?.plan?.angle, 'Old angle', 'cap within one takeover');
  save();
  await settings.update({ scheduleOverride: { showId: show.id, startedAt: friday + 180_000, expiresAt: friday + hour } });
  const replaced = await session.recover(ctx(friday + 180_000));
  assert.equal(replaced.programme, null, 'replacement is distinct even during recovery');
  session.attachProgramme(episode());
  save();
  await settings.update({ scheduleOverride: null });
  const expired = await session.recover(ctx(friday + hour));
  assert.equal(expired.programme, null, 'removed override must not look like continuous scheduled airtime');
});

test('station-zone half-hour boundaries detect a same-show gap', async () => {
  const week = emptyWeek();
  week[6][4] = show.id;
  week[6][6] = show.id;
  await schedule(week, 'Asia/Kolkata');
  const old = session.start(ctx(friday)); // Saturday 04:30 IST
  session.attachProgramme(episode());
  const next = await session.maybeRoll(ctx(friday + 2 * hour));
  assert.notEqual(next.id, old.id);
  assert.equal(next.programme, null);
});

test('recovery upgrades legacy takeover ownership before the override is removed', async () => {
  const week = emptyWeek();
  for (const day of Object.values(week)) day.fill(show.id);
  await schedule(week);
  await settings.update({ scheduleOverride: { showId: show.id, startedAt: friday, expiresAt: friday + hour } });
  const old = session.start(ctx(friday + 60_000));
  delete old.takeoverStartedAt;
  session.attachProgramme(episode());
  save();
  const resumed = await session.recover(ctx(friday + 120_000));
  assert.equal(resumed.id, old.id);
  assert.equal(resumed.takeoverStartedAt, friday);
  assert.equal(JSON.parse(readFileSync(config.session.currentFile, 'utf8')).takeoverStartedAt, friday);
  await settings.update({ scheduleOverride: null });
  assert.equal((await session.maybeRoll(ctx(friday + hour))).programme, null);
});

test('recovery before a saved look-ahead context retains the continuous programme', async () => {
  const week = emptyWeek();
  for (const day of Object.values(week)) day.fill(show.id);
  await schedule(week);
  const old = session.start(ctx(friday + 5 * 60_000));
  session.attachProgramme(episode());
  save();
  const resumed = await session.recover(ctx(friday));
  assert.equal(resumed.id, old.id);
  assert.equal(resumed.programme?.plan?.angle, 'Old angle');
});

test('a prepared programme takes precedence over same-key cap carryover', async () => {
  const week = emptyWeek();
  for (const day of Object.values(week)) day.fill(show.id);
  await schedule(week);
  const old = session.start(ctx(friday));
  session.attachProgramme(episode());
  const prepared = episode();
  prepared.plan = { angle: 'Prepared owner' };
  old.boundaryHandoff = {
    personaId: guest.id, personaName: guest.name, showName: incoming.name,
    incomingPersonaId: host.id, incomingPersonaName: host.name, incomingShowName: show.name,
    targetKey: old.key, boundaryAt: friday, takeoverStartedAt: null,
    aired: true, programme: prepared,
  };
  age();
  assert.equal((await session.maybeRoll(ctx(friday + 4 * hour))).programme, prepared);
});

test('an old aired boundary record cannot restore a later airing\'s programme on recovery', async () => {
  const week = emptyWeek();
  week[5][23] = show.id;
  await schedule(week);
  const old = session.start(ctx(friday - 7 * 24 * hour));
  const prepared = episode();
  session.attachProgramme(prepared);
  old.boundaryHandoff = {
    personaId: guest.id, personaName: guest.name, showName: incoming.name,
    incomingPersonaId: host.id, incomingPersonaName: host.name, incomingShowName: show.name,
    targetKey: old.key, boundaryAt: friday - 7 * 24 * hour,
    aired: true, programme: prepared,
  };
  save();
  assert.equal((await session.recover(ctx(friday))).programme, null);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function deferredPlan() {
  const started = deferred<void>();
  const result = deferred<Awaited<ReturnType<typeof generateProgrammePlan>>>();
  return { started, result, generateProgrammePlan: async () => { started.resolve(); return result.promise; } };
}

test('a delayed plan completes across a continuous cap but cannot replace a later airing', async () => {
  const week = emptyWeek();
  week[5][23] = show.id;
  for (let h = 0; h < 5; h++) week[6][h] = show.id;
  await schedule(week);
  session.start(ctx(friday));
  const kept = deferredPlan();
  const work = programme.ensurePlan(ctx(friday), new Date(friday), kept);
  await kept.started.promise;
  age();
  const cap = await session.maybeRoll(ctx(friday + 4 * hour));
  kept.result.resolve({ angle: 'Continuous plan', features: [], introNote: null, outroNote: null });
  await work;
  assert.equal(cap.programme?.plan?.angle, 'Continuous plan');

  session.start(ctx(friday));
  const stale = deferredPlan();
  const oldWork = programme.ensurePlan(ctx(friday), new Date(friday), stale);
  await stale.started.promise;
  const next = await session.maybeRoll(ctx(friday + 7 * 24 * hour));
  const fresh = episode();
  fresh.plan = { angle: 'New airing' };
  session.attachProgramme(fresh);
  stale.result.resolve({ angle: 'Stale completion', features: [], introNote: null, outroNote: null });
  await oldWork;
  assert.equal(next.programme, fresh);
  assert.equal(next.programme.plan?.angle, 'New airing');
});

test('an in-flight prepared boundary plan takes precedence and completes after the incoming cap', async () => {
  const week = emptyWeek();
  week[5][22] = show.id;
  week[5][23] = incoming.id;
  for (let h = 0; h < 8; h++) week[6][h] = incoming.id;
  await schedule(week);
  const outgoing = session.start(ctx(friday - hour));
  session.attachProgramme(episode());
  assert.equal(session.armBoundaryHandoff(ctx(friday)), true);
  // Arming uses the wall clock for the forecast; pin this deterministic fixture.
  session.getSession()!.boundaryHandoff!.boundaryAt = friday;
  const producer = deferredPlan();
  const work = programme.prepareBoundaryPlan(ctx(friday), producer);
  await producer.started.promise;
  const prepared = session.getBoundaryProgramme();
  const next = await session.maybeRoll(ctx(friday));
  assert.equal(next.programme, prepared);
  age();
  const cap = await session.maybeRoll(ctx(friday + 4 * hour));
  assert.equal(cap.programme, prepared);
  producer.result.resolve({ angle: 'Prepared incoming', features: [], introNote: null, outroNote: null });
  await work;
  assert.equal(cap.programme?.plan?.angle, 'Prepared incoming');
  assert.equal(JSON.parse(readFileSync(join(config.session.dir, `${outgoing.id}.json`), 'utf8')).programme.plan.angle, 'Old angle');
  // Producer completion persists through the ordinary session debounce.
  const deadline = Date.now() + 4_000;
  while (JSON.parse(readFileSync(config.session.currentFile, 'utf8')).programme.plan?.angle !== 'Prepared incoming'
      && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(readFileSync(config.session.currentFile, 'utf8')).programme.plan.angle, 'Prepared incoming');
});
