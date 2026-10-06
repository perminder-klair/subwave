// The same-host acknowledgement is for a change of SHOW, not for the 4h
// session safety cap (session.stampRolledFrom).
//
// THE DEFECT THIS GUARDS. maybeRoll hard-rolls a session older than four hours
// even when the show is unchanged. stampRolledFrom treated any show:→show:
// roll with the same host as a "same-host show change", so with
// djBehaviour.sameHostAcknowledgement on, the host of a long show
// (23:00-06:00) acknowledged a show change to themself at about 03:00 every
// night.
//
// Run: npm test -- same-host-ack-session-cap

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-same-host-cap-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const stationContext = await import('../src/context.js');

after(() => rmSync(root, { recursive: true, force: true }));

const template = settings.get().personas[0];
const PROF = { ...template, id: 'p_prof', name: 'The Dead Professor' };
const CAVE = { id: 's_cave', name: 'The Minoan Cave' };
const DAWN = { id: 's_dawn', name: 'Sunrise On The Beach' };

function context(show: { id: string; name: string }, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { ...stationContext.getTimeContext(new Date(atMs)), period: 'night', vibe: 'night', mood: 'calm' },
    weather: null, festival: null, dominantMood: 'calm',
    date: stationContext.getDateContext(new Date(atMs)),
    clock: stationContext.getClockContext(new Date(atMs)),
    listeners: { count: 1 }, showHandover: null, episodeEditorial: '',
    activeShow: { ...show, topic: '', moods: ['calm'] },
  };
}

async function setup() {
  await settings.update({
    personas: [PROF], activePersonaId: PROF.id,
    djBehaviour: { sameHostAcknowledgement: true },
  } as never);
}

test('the 4h cap rolls the session without a same-host acknowledgement', async () => {
  await setup();
  const t0 = Date.now();
  const first = session.start(context(CAVE, t0));
  // Four hours into the same show.
  session.getSession()!.startedAt = new Date(t0 - 4 * 3600_000 - 60_000).toISOString();
  const next = await session.maybeRoll(context(CAVE, t0 + 60_000));
  assert.notEqual(next.id, first.id, 'the safety cap still rolls the session');
  assert.equal(next.key, first.key, 'same show');
  assert.equal(next.rolledFrom, null);
  assert.equal(session.pendingHandoff(), null, 'no mic-pass to the same host mid-show');
});

test('a genuine same-host show change is still acknowledged', async () => {
  await setup();
  const t0 = Date.now();
  session.start(context(CAVE, t0));
  await session.maybeRoll(context(DAWN, t0 + 60_000));
  assert.equal(session.pendingHandoff()?.sameHost, true);
});
