// Final-track handoff lifecycle: arming on an already-playing track, late air
// after a session roll, and recovery when the recorded final track never airs.
//
// Rutti started at 22:55:52 and the picker armed it at 22:56:28. Waiting for its
// already-past start delayed the mic-pass to 23:09:58, over the incoming show's
// second song. confirmOnAirBoundaryHandoff must release it immediately.
//
// A late Tom Avro to Dead Professor handoff then left an "aired" record on the
// incoming session. handoffInProgress stayed true for the entire show and
// blocked all scheduled speech. Late air must release that guard while keeping
// the record for diagnostics, programme transfer, and the next boundary.
//
// If a final track is skipped or replaced, the armed record must not hold the
// mic-pass forever. After six minutes past the boundary, confirmed playback
// accepts a replacement with fresh context. A readiness read cannot confirm it.
// Run: npm test -- handoff-armed-on-air

import assert from 'node:assert/strict';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';
import { emptyWeek as emptyScheduleWeek } from '../src/schemas/schedule.js';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createTempDir } from './test-utils/temp-dir.js';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionContext } from '../src/broadcast/session.js';

const root = createTempDir(join(tmpdir(), 'subwave-handoff-on-air-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { getDateContext, getClockContext } = await import('../src/context.js');
const { queue } = await import('../src/broadcast/queue.js');

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom Avro' };
const PROF = { ...template, id: 'p_prof', name: 'The Dead Professor' };
const MANOLO = { ...template, id: 'p_manolo', name: 'Manolo X' };
const FINAL = { id: 'final', title: 'In Hundreds', artist: 'Karate' };
const OTHER = { id: 'fallback', title: 'Something Else', artist: 'Someone' };
const DRIVE = { id: 's_drive', name: 'Friday Drive' };
const CAVE = { id: 's_cave', name: 'The Minoan Cave' };
const RUTTI = { id: 'rutti', title: 'Rutti', artist: 'Slowdive' };

function blankSchedule() { return emptyScheduleWeek(); }

function context(show: { id: string; name: string }, atMs: number, period = 'night', mood = 'calm'): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period, vibe: period, mood, show: '' },
    weather: null, festival: null, dominantMood: mood,
    date: getDateContext(new Date(atMs)), clock: getClockContext(new Date(atMs)), listeners: { count: 1 },
    showHandover: null,
    activeShow: { ...show, topic: '', moods: [mood] },
  } as SessionContext;
}

// Start an outgoing session, schedule the incoming host, then arm its final
// track. The on-air case confirms a start that happened before the arm.
async function armed({
  incoming = CAVE, persona = PROF, finalTrack = RUTTI,
  outgoing = { id: 's_shadowplay', name: 'Shadowplay' },
  onAir = false, pinBoundary = false, period = 'night', mood = 'calm',
} = {}): Promise<number> {
  await settings.update({
    personas: [TOM, persona], activePersonaId: TOM.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context(outgoing, now, period, mood));
  const week: Record<number, string[]> = fullScheduleWeek(incoming.id);
  await settings.update({
    activePersonaId: persona.id,
    shows: [{ ...incoming, topic: incoming === DRIVE ? 'drive' : 'caves', personaId: persona.id }],
    schedule: week,
  } as never);
  queue.current = onAir
    ? { track: { ...finalTrack }, startedAt: new Date(now - 36_000).toISOString(), source: 'auto' }
    : null;
  assert.equal(session.armBoundaryHandoff(context(incoming, now + 5 * 60_000, period, mood), finalTrack), true);
  if (pinBoundary) {
    // A fixture filling the entire schedule has no clock boundary to find.
    const boundaryAt = now + 5 * 60_000;
    session.getSession()!.boundaryHandoff!.boundaryAt = boundaryAt;
    assert.equal(session.handoffBoundaryAt(), boundaryAt);
    return boundaryAt;
  }
  return now;
}

test('armed on the on-air track with no held anchor → released now', async (t) => {
  await armed({ onAir: true });
  assert.equal(session.boundaryHandoffAwaitsTrack(), true, 'the generic path stands down for it');
  const spy = t.mock.method(queue, 'runArmedBoundaryHandoff', async () => {});
  assert.equal(queue.confirmOnAirBoundaryHandoff(true, null), true);
  assert.equal(spy.mock.callCount(), 1);
});

test('deadline path (held anchor) → left for that track\'s own start', async (t) => {
  await armed({ onAir: true });
  const spy = t.mock.method(queue, 'runArmedBoundaryHandoff', async () => {});
  assert.equal(queue.confirmOnAirBoundaryHandoff(true, { track: { id: 'held' } } as never), false);
  assert.equal(spy.mock.callCount(), 0);
});

test('nothing armed this cycle → no release', async (t) => {
  await armed({ onAir: true });
  const spy = t.mock.method(queue, 'runArmedBoundaryHandoff', async () => {});
  assert.equal(queue.confirmOnAirBoundaryHandoff(false, null), false);
  assert.equal(spy.mock.callCount(), 0);
});

test('the on-air track is not the recorded final track → no release', async (t) => {
  await armed({ onAir: true });
  queue.current = { track: { id: 'other', title: 'Night', artist: 'Someone' },
    startedAt: new Date().toISOString(), source: 'auto' };
  const spy = t.mock.method(queue, 'runArmedBoundaryHandoff', async () => {});
  assert.equal(queue.confirmOnAirBoundaryHandoff(true, null), false);
  assert.equal(spy.mock.callCount(), 0);
});

test('runPickCycle calls it after the mic-pass step', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'broadcast', 'queue.ts'), 'utf8');
  const cycle = src.slice(src.indexOf('  runPickCycle('));
  const armAt = cycle.indexOf('session.armBoundaryHandoff(');
  const callAt = cycle.indexOf('this.confirmOnAirBoundaryHandoff(finalTrackHandoff, pickAnchorItem)');
  assert.ok(armAt > 0 && callAt > armAt, 'the release follows the arming in the same cycle');
});

test('aired BEFORE the roll → still guards the outgoing show', async () => {
  await armed();
  session.markHandoffQueued();
  session.markHandoffAired();
  assert.equal(session.handoffInProgress(), true);
  assert.equal(session.boundaryHandoffStatus()?.state, 'aired');
});

test('carried across the roll, aired after it → released for the incoming show', async () => {
  const now = await armed();
  const next = await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  assert.equal(next.show?.id, CAVE.id);
  assert.ok(next.boundaryHandoff, 'the un-aired record rides onto the incoming session');
  session.markHandoffQueued();
  assert.equal(session.handoffInProgress(), true, 'queued still holds the air');
  session.markHandoffAired();
  assert.equal(session.handoffInProgress(), false, 'scheduled speech is allowed again');
  assert.equal(session.boundaryHandoffStatus()?.state, 'aired', 'kept for /debug, as history');
  assert.equal(session.pendingHandoff(), null, 'no second mic-pass');
  assert.equal(session.getSession()?.handoffAired, true);
});

test('a session already persisted with an aired record is released on read', async () => {
  const now = await armed();
  await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  // Simulate the persisted state from before the fix.
  const s = session.getSession()!;
  s.boundaryHandoff!.aired = true;
  s.boundaryHandoff!.queued = false;
  assert.equal(session.handoffInProgress(), false);
});

test('a record aired on the live show gives way to the next boundary', async () => {
  const now = await armed();
  await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  session.markHandoffQueued();
  session.markHandoffAired();
  // The Cave's own boundary into the next host's show.
  const ANYA = { ...TOM, id: 'p_anya', name: 'Anya' };
  const DAWN = { id: 's_dawn', name: 'Dawn Patrol' };
  const week: Record<number, string[]> = fullScheduleWeek(DAWN.id);
  await settings.update({
    personas: [TOM, PROF, ANYA], activePersonaId: ANYA.id,
    shows: [{ ...CAVE, topic: 'caves', personaId: PROF.id }, { ...DAWN, topic: '', personaId: ANYA.id }],
    schedule: week,
  } as never);
  assert.equal(session.armBoundaryHandoff(context(DAWN, now + 65 * 60_000), RUTTI), true,
    'the history record does not block the next mic-pass');
  assert.equal(session.boundaryHandoffStatus()?.state, 'armed');
  assert.equal(session.handoffInProgress(), false, 'armed alone does not hold the air');
});

test('airing after the roll hands the record\'s programme to the live show', async () => {
  const now = await armed();
  await session.maybeRoll(context(CAVE, now + 5 * 60_000));
  const s = session.getSession()!;
  s.programme = null;
  const programme = { showId: CAVE.id, episode: 'e1' } as never;
  s.boundaryHandoff!.programme = programme;
  session.markHandoffQueued();
  session.markHandoffAired();
  assert.equal(session.getProgramme(), programme);
});

test('within six minutes of the boundary the record still waits for its final track', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const boundaryAt = await armed({ incoming: DRIVE, persona: MANOLO, finalTrack: FINAL,
    outgoing: { id: 's_evening', name: 'Evening Shift' }, pinBoundary: true, period: 'evening', mood: 'warm' });
  t.mock.timers.setTime(boundaryAt + 5 * 60_000);
  assert.equal(session.boundaryHandoffReadyForTrack(OTHER), false, 'another track does not release it');
  assert.equal(session.boundaryHandoffReadyForTrack(FINAL), true, 'its own final track does');
  assert.equal(session.boundaryHandoffAwaitsTrack(), true);
});

test('past six minutes it accepts the next track that starts, with fresh context', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const boundaryAt = await armed({ incoming: DRIVE, persona: MANOLO, finalTrack: FINAL,
    outgoing: { id: 's_evening', name: 'Evening Shift' }, pinBoundary: true, period: 'evening', mood: 'warm' });
  const late = boundaryAt + 6 * 60_000 + 1_000;
  t.mock.timers.setTime(late);
  assert.ok(session.pendingHandoff(), 'the mic-pass is still owed, not dropped');
  assert.equal(session.boundaryHandoffReadyForTrack(OTHER), false, 'a read does not confirm playback');
  assert.equal(session.boundaryHandoffAwaitsTrack(), true);
  assert.equal(session.confirmBoundaryHandoffTrack(OTHER), true, 'confirmed playback replaces the missing track');
  assert.equal(session.boundaryHandoffAwaitsTrack(), true, 'generic callers still wait while rendering');
  const record = session.getSession()!.boundaryHandoff!;
  assert.deepEqual(record.finalTrack, OTHER);
  assert.equal(record.contextAt, new Date(late).toISOString(), 'the greeting reads conditions as of now');
  assert.equal(session.boundaryHandoffStatus()?.state, 'armed', 'still owed: armed, not aired');
});
