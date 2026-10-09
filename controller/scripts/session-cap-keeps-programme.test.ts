// The 4h session safety cap must not restart a programme show that is still
// on air (session.maybeRoll).
//
// THE DEFECT THIS GUARDS. maybeRoll hard-rolls a session older than four
// hours even when the show is unchanged, and the new session started with no
// programme state. The programme then re-planned "today's episode" and aired
// the show's intro again: live, Friday Drive began at 23:00 and at 03:00 the
// host said "Good evening, and welcome to Friday Drive".
//
// Run: npm test -- session-cap-keeps-programme

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-cap-programme-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const stationContext = await import('../src/context.js');
const programme = await import('../src/broadcast/programme.js');

after(() => rmSync(root, { recursive: true, force: true }));

const template = settings.get().personas[0];
const MANOLO = { ...template, id: 'p_manolo', name: 'Manolo X' };
const DRIVE = { id: 's_drive', name: 'Friday Drive' };
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

async function onAir(show: { id: string; name: string }) {
  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(show.id);
  await settings.update({
    personas: [MANOLO], activePersonaId: MANOLO.id,
    shows: [
      { ...DRIVE, topic: 'drive', personaId: MANOLO.id, programme: true },
      { ...DAWN, topic: 'dawn', personaId: MANOLO.id, programme: true },
    ],
    schedule: week,
  } as never);
}

function introCounter() {
  let intros = 0;
  const queue = {
    getDjRecap: () => null,
    getRecentOpeners: () => [],
    announce: async () => { intros++; },
    announceExchange: async () => { intros++; return true; },
    log: () => {},
  } as any;
  return { queue, count: () => intros };
}

test('the 4h cap keeps the episode: no new plan, no second intro', async () => {
  await onAir(DRIVE);
  const t0 = Date.now();
  const first = session.start(context(DRIVE, t0));
  const episode = {
    status: 'ok' as const,
    plan: { angle: 'Friday angle', features: [], introNote: null, outroNote: null } as never,
    beats: { intro: true },
    introAiredAt: new Date(t0 - 4 * 3600_000).toISOString(),
  };
  session.attachProgramme(episode);
  // Four hours into the same show.
  session.getSession()!.startedAt = new Date(t0 - 4 * 3600_000 - 60_000).toISOString();

  const next = await session.maybeRoll(context(DRIVE, t0 + 60_000));
  assert.notEqual(next.id, first.id, 'the safety cap still rolls the session');
  assert.equal(next.key, first.key, 'same show');
  assert.equal(session.getProgramme()?.plan?.angle, 'Friday angle', 'same episode plan');
  assert.equal(session.getProgramme()?.beats?.intro, true, 'its intro already aired');

  const { queue, count } = introCounter();
  assert.equal(await programme.maybeRunIntro(queue, context(DRIVE, t0 + 60_000)), false);
  assert.equal(count(), 0, 'no "welcome to the show" mid-show');
});

test('a genuine show change still starts a fresh episode', async () => {
  await onAir(DRIVE);
  const t0 = Date.now();
  session.start(context(DRIVE, t0));
  session.attachProgramme({ status: 'ok', plan: null, beats: { intro: true }, introAiredAt: null });
  await onAir(DAWN);
  await session.maybeRoll(context(DAWN, t0 + 60_000));
  assert.equal(session.getProgramme(), null, 'the next show does not inherit the previous episode');
});
