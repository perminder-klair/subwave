// Regression coverage for issue #1666: editing the host of the active show must
// refresh the live same-show session immediately, including repeated toggles and
// cold recovery, without discarding editorial continuity.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-session-host-refresh-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { config } = await import('../src/config.js');
await import('../src/broadcast/queue.js');

const template = settings.get().personas[0];
const SARA = { ...template, id: 'p_sara', name: 'Sara' };
const WESTIN = { ...template, id: 'p_westin', name: 'DJ Westin' };
const SHOW_ID = 's_relay';

function weekFor(showId: string | null) {
  const week: Record<number, (string | null)[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(showId);
  return week;
}

function show(personaId: string) {
  return {
    id: SHOW_ID,
    name: 'Relay Seven',
    topic: 'Late-night electronic sounds',
    personaId,
    programme: true,
  };
}

function context(at = new Date()) {
  return {
    at: at.toISOString(),
    time: { period: 'night', vibe: 'late', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    date: {},
    clock: {},
    listeners: 1,
    activeShow: { id: SHOW_ID, name: 'Relay Seven', topic: 'Late-night electronic sounds', moods: ['calm'] },
  } as any;
}

async function seed(personaId = WESTIN.id) {
  await settings.update({
    personas: [SARA, WESTIN],
    activePersonaId: SARA.id,
    shows: [show(personaId)],
    schedule: weekFor(SHOW_ID),
    scheduleOverride: null,
  } as never);
}

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('saving a new host refreshes the active same-show session without losing continuity', async () => {
  await seed(WESTIN.id);
  const live = session.start(context());
  session.attachProgramme({
    status: 'ok',
    plan: { angle: 'Neon relay' },
    beats: { intro: true },
    introAiredAt: new Date().toISOString(),
  });
  session.appendTurn({ role: 'segment', kind: 'link', text: 'A line already aired.', meta: { personaId: WESTIN.id } });
  const before = {
    id: live.id,
    key: live.key,
    startedAt: live.startedAt,
    messages: session.getSession()!.messages.length,
  };

  await settings.update({ shows: [show(SARA.id)] } as never);

  const refreshed = session.getSession()!;
  assert.equal(refreshed.persona?.id, SARA.id);
  assert.equal(session.onAirPersona()?.id, SARA.id);
  assert.equal(refreshed.hostRevision, 1);
  assert.equal(refreshed.id, before.id);
  assert.equal(refreshed.key, before.key);
  assert.equal(refreshed.startedAt, before.startedAt);
  assert.equal(refreshed.programme?.plan?.angle, 'Neon relay');
  assert.equal(refreshed.programme?.beats?.intro, true);
  assert.ok(refreshed.messages.length > before.messages, 'the host change is recorded as a scenario event');
});

test('host revisions detect A to B to A toggles and ignore unchanged or inactive-show edits', async () => {
  await seed(WESTIN.id);
  session.start(context());
  const initial = session.captureHostSpeech();
  assert.ok(initial);

  await settings.update({ shows: [show(SARA.id)] } as never);
  assert.equal(session.isHostSpeechCurrent(initial!), false);
  const sara = session.captureHostSpeech();
  assert.equal(sara?.personaId, SARA.id);
  assert.equal(sara?.revision, 1);

  await settings.update({ shows: [show(WESTIN.id)] } as never);
  assert.equal(session.isHostSpeechCurrent(sara!), false);
  const westinAgain = session.captureHostSpeech();
  assert.equal(westinAgain?.revision, 2);
  assert.equal(session.isHostSpeechCurrent(initial!), false, 'returning to A does not revive an old A generation');

  await settings.update({
    personas: [SARA, { ...WESTIN, name: 'DJ Westin Updated' }],
    shows: [show(WESTIN.id)],
  } as never);
  assert.equal(session.getSession()?.hostRevision, 2, 'same-id persona edits do not create a host epoch');
  assert.equal(session.onAirPersona()?.name, 'DJ Westin Updated', 'the live persona resolver still sees same-id edits');

  await settings.update({
    shows: [show(WESTIN.id), { ...show(SARA.id), id: 's_inactive', name: 'Inactive' }],
  } as never);
  assert.equal(session.getSession()?.hostRevision, 2, 'editing another show does not refresh the live session');
});

test('recovery repairs a persisted same-show session before returning it', async () => {
  await seed(WESTIN.id);
  session.start(context());
  await new Promise(resolve => setTimeout(resolve, 1_100));

  await settings.update({ shows: [show(SARA.id)] } as never);
  // Simulate the crash window where the settings save landed but the session's
  // debounced correction did not: restore the old persona into the durable file
  // by starting it again and waiting for that snapshot.
  await seed(WESTIN.id);
  session.start(context());
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await settings.update({ shows: [show(SARA.id)] } as never);

  const recovered = await session.recover(context());
  assert.equal(recovered.persona?.id, SARA.id);
  assert.ok((recovered.hostRevision ?? 0) >= 1);
  const persisted = JSON.parse(readFileSync(config.session.currentFile, 'utf8'));
  assert.equal(persisted.persona?.id, SARA.id, 'recovery persists the repaired host before returning');
  assert.equal(persisted.hostRevision, recovered.hostRevision);
});


test('cache subscribers are synchronous, isolated, and unsubscribable', async () => {
  let calls = 0;
  const unsubscribe = settings.onCacheChange(() => {
    calls += 1;
    throw new Error('listener test failure');
  });
  const realError = console.error;
  console.error = () => {};
  try {
    await settings.update({ activePersonaId: SARA.id } as never);
    assert.equal(calls, 1);
    unsubscribe();
    await settings.update({ activePersonaId: WESTIN.id } as never);
    assert.equal(calls, 1, 'unsubscribe prevents later publication callbacks');
  } finally {
    console.error = realError;
    unsubscribe();
  }
});
