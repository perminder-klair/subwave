// Automatic skill speech belongs to the host epoch that commissioned it.
// A host edit while catalogue/model/TTS work is in flight must silence that
// result, while guest and co-host speech keep their independent ownership.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-scheduled-skill-host-'));
process.env.STATE_DIR = root;

const skillDir = join(root, 'skills', 'host-race');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), [
  '---',
  'name: host-race',
  'cooldown: 0',
  '---',
  'Say one grounded sentence about the current moment.',
  '',
].join('\n'));

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { agenticTick, directorAgent, forcedDirectorAgent, runCapability } = await import('../src/skills/_agent.js');

const template = settings.get().personas[0];
const A = { ...template, id: 'p_a', name: 'Host A', skills: ['host-race'], frequency: 'aggressive' };
const B = { ...template, id: 'p_b', name: 'Host B', skills: ['host-race'], frequency: 'aggressive' };
const G = { ...template, id: 'p_guest', name: 'Guest', skills: ['host-race'], frequency: 'aggressive' };
const SHOW = 's_skill';

function week() {
  const out: Record<number, string[]> = {};
  for (let day = 0; day < 7; day++) out[day] = Array(24).fill(SHOW);
  return out;
}

function show(personaId: string, guests = [G.id]) {
  return { id: SHOW, name: 'Skill Show', topic: 'tests', personaId, guestPersonaIds: guests };
}

function ctx() {
  return {
    at: new Date().toISOString(),
    time: { period: 'day', vibe: 'day', mood: 'calm' },
    clock: {}, weather: null, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Skill Show', topic: 'tests' },
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const realDirectorRun = directorAgent.run;
const realForcedRun = forcedDirectorAgent.run;
const realSpeak = (queue as any)._speak;
const realAirVoice = (queue as any)._airVoice;

beforeEach(async () => {
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  (queue as any)._speak = async () => '/tmp/scheduled-skill.wav';
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  await settings.load();
  await settings.update({
    personas: [A, B, G], activePersonaId: A.id,
    shows: [show(A.id)], schedule: week(), scheduleOverride: null,
    skills: { enabled: { 'host-race': true } },
    llm: { pickerAgent: true },
    sfx: { enabled: false },
  } as never);
  session.start(ctx());
  await loadSkills();
});

after(async () => {
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  (queue as any)._speak = realSpeak;
  (queue as any)._airVoice = realAirVoice;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  rmSync(root, { recursive: true, force: true });
});

test('the autonomous segment director drops host speech completed after a host save', async () => {
  await settings.update({ shows: [show(A.id, [])] } as never);
  session.start(ctx());
  const model = deferred<any>();
  let modelStarted = false;
  let accepted = 0;
  directorAgent.run = async () => {
    modelStarted = true;
    return model.promise;
  };
  (queue as any)._airVoice = async () => {
    accepted += 1;
    return { voiceId: 'unexpected', clipMs: 1_000, aired: Promise.resolve(null) };
  };

  const tick = agenticTick(ctx());
  while (!modelStarted) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id, [])] } as never);
  model.resolve({
    object: { air: true, reason: 'worth saying', segment: { kind: 'host-race', text: 'Old host line.', sfx: null } },
    steps: 1, toolCalls: [], extras: undefined,
  });
  await tick;

  assert.equal(accepted, 0, 'stale scheduled host speech never enters the voice chain');
});

test('an automatic forced skill is stale across a host save, but the manual override remains explicit', async () => {
  const model = deferred<any>();
  let modelStarted = false;
  let accepted = 0;
  forcedDirectorAgent.run = async () => {
    modelStarted = true;
    return model.promise;
  };
  (queue as any)._airVoice = async () => {
    accepted += 1;
    return { voiceId: `voice-${accepted}`, clipMs: 1_000, aired: Promise.resolve(null) };
  };

  const automatic = runCapability('host-race', ctx(), { automaticHostSpeech: true });
  while (!modelStarted) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  model.resolve({ object: { text: 'Old automatic host line.', sfx: null }, steps: 1, toolCalls: [], extras: undefined });
  const automaticResult = await automatic;
  assert.equal(automaticResult.queued, false);
  assert.equal(accepted, 0);

  forcedDirectorAgent.run = async () => ({
    object: { text: 'Operator-triggered line.', sfx: null }, steps: 1, toolCalls: [], extras: undefined,
  });
  const manualResult = await runCapability('host-race', ctx());
  assert.equal(manualResult.queued, true);
  assert.equal(accepted, 1, 'manual speech remains outside the automatic host veto');
});

test('both automatic forced-skill callers opt into host ownership', () => {
  const scheduler = readFileSync(join(process.cwd(), 'src/broadcast/scheduler.ts'), 'utf8');
  const programme = readFileSync(join(process.cwd(), 'src/broadcast/programme.ts'), 'utf8');
  assert.match(scheduler, /runCapability\(cap\.kind, ctx, \{ automaticHostSpeech: true \}\)/);
  assert.match(programme, /runCapability\(kind, ctx, \{[\s\S]*?automaticHostSpeech,[\s\S]*?\}\)/);
});

test('an eligible guest skill and a co-host exchange survive a host edit', async () => {
  let accepted = 0;
  (queue as any)._airVoice = async (_file: string, _wav: string, _text: string, _gain: number, opts: any) => {
    accepted += 1;
    opts?.onQueued?.({ voiceId: `voice-${accepted}`, clipMs: 1_000, estimatedAirInMs: 0 });
    return { voiceId: `voice-${accepted}`, clipMs: 1_000, aired: Promise.resolve(null) };
  };

  const guestModel = deferred<any>();
  let guestStarted = false;
  forcedDirectorAgent.run = async () => {
    guestStarted = true;
    return guestModel.promise;
  };
  const guestRun = runCapability('host-race', ctx(), {
    persona: G,
    automaticHostSpeech: true,
  });
  while (!guestStarted) await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(B.id)] } as never);
  guestModel.resolve({ object: { text: 'Guest keeps the mic.', sfx: null }, steps: 1, toolCalls: [], extras: undefined });
  const guestResult = await guestRun;
  assert.equal(guestResult.queued, true);

  const firstRender = deferred<string>();
  let renders = 0;
  (queue as any)._speak = async () => {
    renders += 1;
    if (renders === 1) return firstRender.promise;
    return '/tmp/cohost-two.wav';
  };
  const exchange = queue.announceExchange([
    { persona: B, text: 'The new host opens.' },
    { persona: G, text: 'The guest answers.' },
  ], 'host-race');
  await new Promise(resolve => setImmediate(resolve));
  await settings.update({ shows: [show(A.id)] } as never);
  firstRender.resolve('/tmp/cohost-one.wav');
  assert.equal(await exchange, true);
  assert.equal(accepted, 3, 'guest solo plus both co-host lines enter the voice chain');
});
