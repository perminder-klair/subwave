// An armed boundary handoff whose recorded final track never airs must not
// wait for it forever (session.relaxOverdueBoundaryHandoffTrack).
//
// THE DEFECT THIS GUARDS. An armed record only advances once
// boundaryHandoffReadyForTrack() sees the recorded final track start. When
// that track was skipped or replaced, nothing timed the record out: it held
// boundaryHandoffAwaitsTrack() true, so the sign-off/greeting never aired, and
// armBoundaryHandoff() refused every later boundary on top of it.
// Six minutes past the boundary the record now accepts whatever track starts
// next, with its context refreshed to that moment.
//
// Run: npm test -- handoff-overdue-relax

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-overdue-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');

after(() => rmSync(root, { recursive: true, force: true }));

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom Avro' };
const MANOLO = { ...template, id: 'p_manolo', name: 'Manolo X' };
const FINAL = { id: 'final', title: 'In Hundreds', artist: 'Karate' };
const OTHER = { id: 'fallback', title: 'Something Else', artist: 'Someone' };
const DRIVE = { id: 's_drive', name: 'Friday Drive' };

function context(show: { id: string; name: string }, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'evening', vibe: 'evening', mood: 'warm' },
    weather: null, festival: null, dominantMood: 'warm',
    date: {}, clock: {}, listeners: 1,
    activeShow: { ...show, topic: '', moods: ['warm'] },
  } as SessionContext;
}

async function armedOnFinalTrack(): Promise<number> {
  const blank: Record<number, null[]> = {};
  for (let day = 0; day < 7; day++) blank[day] = Array(24).fill(null);
  await settings.update({ personas: [TOM, MANOLO], activePersonaId: TOM.id, shows: [], schedule: blank } as never);
  const now = Date.now();
  session.start(context({ id: 's_evening', name: 'Evening Shift' }, now));
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(DRIVE.id);
  await settings.update({
    activePersonaId: MANOLO.id,
    shows: [{ ...DRIVE, topic: 'drive', personaId: MANOLO.id }],
    schedule: week,
  } as never);
  assert.equal(session.armBoundaryHandoff(context(DRIVE, now + 5 * 60_000), FINAL), true);
  // The fixture schedule has no clock boundary to find; pin one 5 min out.
  const boundaryAt = now + 5 * 60_000;
  session.getSession()!.boundaryHandoff!.boundaryAt = boundaryAt;
  assert.equal(session.handoffBoundaryAt(), boundaryAt);
  return boundaryAt;
}

test('within six minutes of the boundary the record still waits for its final track', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const boundaryAt = await armedOnFinalTrack();
  t.mock.timers.setTime(boundaryAt + 5 * 60_000);
  assert.equal(session.boundaryHandoffReadyForTrack(OTHER), false, 'another track does not release it');
  assert.equal(session.boundaryHandoffReadyForTrack(FINAL), true, 'its own final track does');
  assert.equal(session.boundaryHandoffAwaitsTrack(), true);
});

test('past six minutes it accepts the next track that starts, with fresh context', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const boundaryAt = await armedOnFinalTrack();
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
