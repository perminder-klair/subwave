// A between-tracks handoff is already rendered before it begins waiting for a
// post-boundary seam. Its two-minute fallback therefore has to survive an
// ordinary controller rebuild without depending on another picker/agent run.
//
// Run: npm test -- handoff-pending-recovery

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionContext } from '../src/broadcast/session.js';

const root = mkdtempSync(join(tmpdir(), 'subwave-handoff-recovery-'));
process.env.STATE_DIR = root;

const { config } = await import('../src/config.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');

const signoffWav = join(root, 'signoff.wav');
const greetingWav = join(root, 'greeting.wav');
await writeSilentWav(signoffWav, 25);
await writeSilentWav(greetingWav, 25);

const template = settings.get().personas[0];
const WREN = { ...template, id: 'p_wren', name: 'Wren' };
const GIGI = { ...template, id: 'p_gigi', name: 'Gigi' };

function blankSchedule() {
  const week: Record<number, null[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill(null);
  return week;
}

function context(show: { id: string; name: string }, atMs: number): SessionContext {
  return {
    at: new Date(atMs).toISOString(),
    time: { period: 'morning', vibe: 'morning', mood: 'calm' },
    weather: null,
    festival: null,
    dominantMood: 'calm',
    date: {},
    clock: {},
    listeners: 1,
    activeShow: { ...show, topic: '', moods: ['calm'] },
  } as SessionContext;
}

async function waitFor(fn: () => boolean, timeoutMs = 4_000) {
  const until = Date.now() + timeoutMs;
  while (!fn() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fn(), true);
}

after(() => {
  if (queue._handoffBoundaryTimer) {
    clearTimeout(queue._handoffBoundaryTimer);
  }
  if (queue._handoffGenerationTimer) {
    clearTimeout(queue._handoffGenerationTimer);
  }
  rmSync(root, { recursive: true, force: true });
});

test('an unrendered final-track handoff falls back to immediate delivery after its deadline', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, now));

  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_incoming');
  await settings.update({
    activePersonaId: GIGI.id,
    shows: [{ id: 's_incoming', name: 'Cultural Currents', topic: 'culture', personaId: GIGI.id }],
    schedule: week,
  } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, now + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming, { id: 'long-final-track' }), true);

  let generated = 0;
  await queue.runHandoffGenerationFallback({
    getContext: async at => {
      assert.equal(at?.getTime(), new Date(incoming.at).getTime(),
        'the fallback keeps the incoming show context while the final track is still playing');
      return incoming;
    },
    runHandoff: async ctx => {
      generated += 1;
      assert.equal(ctx, incoming);
      session.markHandoffAired();
    },
  });
  assert.equal(generated, 1, 'the fallback invokes the regular handoff runner without waiting for a seam');
  assert.equal(session.pendingHandoff(), null, 'the consumed handoff cannot be generated again at a later seam');
});

test('an ordinary scheduled roll uses its durable rolledFrom record for the fallback', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, now));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, now + 60_000);
  await session.maybeRoll(incoming);

  const pending = session.pendingHandoff();
  assert.ok(pending && !('incomingPersonaId' in pending),
    'a normal scheduled roll creates rolledFrom rather than a pre-armed final-track record');
  let generated = 0;
  await queue.runHandoffGenerationFallback({
    getContext: async at => {
      assert.equal(at, undefined, 'ordinary rolls use live incoming-show context, not a boundary forecast');
      return incoming;
    },
    runHandoff: async ctx => {
      generated += 1;
      assert.equal(ctx, incoming);
      session.markHandoffAired();
    },
  });
  assert.equal(generated, 1);
  assert.equal(session.pendingHandoff(), null);
});

test('a failed fallback attempt does not spin at an already-expired deadline', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, now));
  await settings.update({ activePersonaId: GIGI.id } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, now + 60_000);
  await session.maybeRoll(incoming);

  let attempts = 0;
  await queue.runHandoffGenerationFallback({
    getContext: async () => incoming,
    runHandoff: async () => {
      attempts += 1;
      throw new Error('LLM unavailable');
    },
  });
  assert.equal(attempts, 1);
  assert.equal(queue._handoffGenerationTimer, null,
    'the failed attempt is not immediately re-armed from a deadline already in the past');
  assert.ok(session.pendingHandoff(), 'a later normal track/session trigger may still retry the durable handoff');
  session.markHandoffAired();
});

test('a queued handoff falls back when no post-boundary seam arrives in time', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, now));

  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_incoming');
  await settings.update({
    activePersonaId: GIGI.id,
    shows: [{
      id: 's_incoming', name: 'Cultural Currents', topic: 'culture', personaId: GIGI.id,
    }],
    schedule: week,
  } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, now + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);

  // Put the absolute deadline just ahead of us so the test exercises the real
  // timer without spending two minutes waiting for it.
  const boundaryAt = Date.now() - 2 * 60_000 + 100;
  const boundary = session.getSession()?.boundaryHandoff;
  assert.ok(boundary);
  boundary.boundaryAt = boundaryAt;
  rmSync(config.liquidsoap.introFile, { force: true });
  assert.equal(queue.holdForNextTrack('handoff', [
    {
      text: 'That was the hour.', wavPath: signoffWav, persona: WREN, meta: {},
      settlesHandoff: false,
    },
    {
      text: 'Cultural Currents starts now.', wavPath: greetingWav, persona: GIGI, meta: {},
      settlesHandoff: true,
    },
  ], { exchange: true, notBefore: boundaryAt }), true);
  session.markHandoffQueued();

  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(config.liquidsoap.introFile), false,
    'the pair still waits while its original allowance remains');
  await waitFor(() => existsSync(config.liquidsoap.introFile));
  assert.equal(readFileSync(config.liquidsoap.introFile, 'utf8').includes(signoffWav), true);
  rmSync(config.liquidsoap.introFile, { force: true });
  await waitFor(() => existsSync(config.liquidsoap.introFile)
    && readFileSync(config.liquidsoap.introFile, 'utf8').includes(greetingWav));
  rmSync(config.liquidsoap.introFile, { force: true });
  await waitFor(() => session.boundaryHandoffStatus()?.state === 'aired');
});

test('a queued handoff preserves its rendered pair and overdue fallback across restart', async () => {
  await settings.update({
    personas: [WREN, GIGI], activePersonaId: WREN.id, shows: [], schedule: blankSchedule(),
  } as never);
  const now = Date.now();
  session.start(context({ id: 's_outgoing', name: 'The Soft Start Procedure' }, now));

  const week: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) week[day] = Array(24).fill('s_incoming');
  await settings.update({
    activePersonaId: GIGI.id,
    shows: [{
      id: 's_incoming', name: 'Cultural Currents', topic: 'culture', personaId: GIGI.id,
    }],
    schedule: week,
  } as never);
  const incoming = context({ id: 's_incoming', name: 'Cultural Currents' }, now + 60_000);
  assert.equal(session.armBoundaryHandoff(incoming), true);

  // Model the process going down while the pair is queued, then returning
  // after its two-minute post-boundary allowance has already elapsed.
  const boundaryAt = Date.now() - 2 * 60_000 - 1;
  const boundary = session.getSession()?.boundaryHandoff;
  assert.ok(boundary);
  boundary.boundaryAt = boundaryAt;
  assert.equal(queue.holdForNextTrack('handoff', [
    {
      text: 'That was the hour.', wavPath: signoffWav, persona: WREN, meta: {},
      settlesHandoff: false,
    },
    {
      text: 'Cultural Currents starts now.', wavPath: greetingWav, persona: GIGI, meta: {},
      settlesHandoff: true,
    },
  ], { exchange: true, notBefore: boundaryAt }), true);
  assert.ok(queue._handoffBoundaryTimer);
  clearTimeout(queue._handoffBoundaryTimer);
  queue._handoffBoundaryTimer = null;
  session.markHandoffQueued();

  // Both queue.json (500ms) and session.json (1s) are deliberately debounced.
  await new Promise(resolve => setTimeout(resolve, 1_100));
  const storedQueue = JSON.parse(readFileSync(config.queue.file, 'utf8')) as {
    pendingHandoff: { t: number; clips: Array<{ wavPath: string }> };
  };
  assert.deepEqual(
    storedQueue.pendingHandoff?.clips.map(clip => clip.wavPath),
    [signoffWav, greetingWav],
    'the already-rendered pair is durable before the process loses its heap',
  );

  queue._pendingVoice = null;
  await session.recover(incoming);
  rmSync(config.liquidsoap.introFile, { force: true });
  queue.recover();

  assert.equal(session.pendingHandoff(), null,
    'the recovered audio owns the queued record instead of reopening generation');
  assert.deepEqual(queue.pendingVoiceTalk(), { kind: 'handoff', queuedAt: storedQueue.pendingHandoff.t });

  await waitFor(() => existsSync(config.liquidsoap.introFile));
  assert.equal(readFileSync(config.liquidsoap.introFile, 'utf8').includes(signoffWav), true);
  rmSync(config.liquidsoap.introFile, { force: true });

  await waitFor(() => existsSync(config.liquidsoap.introFile)
    && readFileSync(config.liquidsoap.introFile, 'utf8').includes(greetingWav));
  rmSync(config.liquidsoap.introFile, { force: true });
  await waitFor(() => session.boundaryHandoffStatus()?.state === 'aired');
});
