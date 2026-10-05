// A boundary handoff armed on the track ALREADY on air must be released at
// once, not wait for that track's start (queue.confirmOnAirBoundaryHandoff).
//
// THE DEFECT THIS GUARDS. runPickCycle arms the handoff with the on-air track
// as the outgoing show's final track whenever it has no held anchor, but the
// only thing that released an armed pair was onTrackStarted for that final
// track — a start that had already happened. Live timeline (Athens): Rutti
// starts 22:55:52; the next pick at 22:56:28 resolves the 23:00 show and arms
// on Rutti; nothing speaks; the six-minute overdue relax finally hands the
// pair to "any track" and the sign-off + greeting air at 23:09:58, over the
// middle of the incoming show's second song.
//
// Run: npm test -- handoff-armed-on-air

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-on-air-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');

after(() => rmSync(root, { recursive: true, force: true }));

const template = settings.get().personas[0];
const TOM = { ...template, id: 'p_tom', name: 'Tom Avro' };
const PROF = { ...template, id: 'p_prof', name: 'The Dead Professor' };
const RUTTI = { id: 'rutti', title: 'Rutti', artist: 'Slowdive' };

function blankSchedule() {
  const week: Record<number, null[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(null);
  return week;
}

function context(show: { id: string; name: string }, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'night', vibe: 'night', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    date: {}, clock: {}, listeners: 1,
    activeShow: { ...show, topic: '', moods: ['calm'] },
  } as SessionContext;
}

// Outgoing show on air with Rutti playing, the incoming show armed on Rutti.
async function armOnRutti(): Promise<void> {
  await settings.update({
    personas: [TOM, PROF], activePersonaId: TOM.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_shadowplay', name: 'Shadowplay' }, now));
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_cave');
  await settings.update({
    activePersonaId: PROF.id,
    shows: [{ id: 's_cave', name: 'The Minoan Cave', topic: 'caves', personaId: PROF.id }],
    schedule: week,
  } as never);
  (queue as any).current = { track: { ...RUTTI }, startedAt: new Date(now - 36_000).toISOString() };
  assert.equal(
    session.armBoundaryHandoff(context({ id: 's_cave', name: 'The Minoan Cave' }, now + 5 * 60_000), RUTTI),
    true,
  );
}

function stubRelease(): { calls: number; restore: () => void } {
  const original = (queue as any).runArmedBoundaryHandoff;
  const spy = { calls: 0, restore: () => { (queue as any).runArmedBoundaryHandoff = original; } };
  (queue as any).runArmedBoundaryHandoff = async () => { spy.calls++; };
  return spy;
}

test('armed on the on-air track with no held anchor → released now', async () => {
  await armOnRutti();
  assert.equal(session.boundaryHandoffAwaitsTrack(), true, 'the generic path stands down for it');
  const spy = stubRelease();
  try {
    assert.equal(queue.confirmOnAirBoundaryHandoff(true, null), true);
    assert.equal(spy.calls, 1);
  } finally { spy.restore(); }
});

test('deadline path (held anchor) → left for that track\'s own start', async () => {
  await armOnRutti();
  const spy = stubRelease();
  try {
    assert.equal(queue.confirmOnAirBoundaryHandoff(true, { track: { id: 'held' } } as never), false);
    assert.equal(spy.calls, 0);
  } finally { spy.restore(); }
});

test('nothing armed this cycle → no release', async () => {
  await armOnRutti();
  const spy = stubRelease();
  try {
    assert.equal(queue.confirmOnAirBoundaryHandoff(false, null), false);
    assert.equal(spy.calls, 0);
  } finally { spy.restore(); }
});

test('the on-air track is not the recorded final track → no release', async () => {
  await armOnRutti();
  (queue as any).current = { track: { id: 'other', title: 'Night', artist: 'Someone' }, startedAt: new Date().toISOString() };
  const spy = stubRelease();
  try {
    assert.equal(queue.confirmOnAirBoundaryHandoff(true, null), false);
    assert.equal(spy.calls, 0);
  } finally { spy.restore(); }
});

test('runPickCycle calls it after the mic-pass step', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'broadcast', 'queue.ts'), 'utf8');
  const cycle = src.slice(src.indexOf('  runPickCycle('));
  const armAt = cycle.indexOf('session.armBoundaryHandoff(');
  const callAt = cycle.indexOf('this.confirmOnAirBoundaryHandoff(finalTrackHandoff, pickAnchorItem)');
  assert.ok(armAt > 0 && callAt > armAt, 'the release follows the arming in the same cycle');
});
