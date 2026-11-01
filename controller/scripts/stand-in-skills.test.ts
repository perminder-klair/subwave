// A skill whose line never airs backs off rather than re-running its models
// every segment tick, whichever runner wrote the line. These drive the real
// runners with the model stubbed, and count the calls across two ticks: a
// stand-in that is not reported as one looks like a queue refusal, and the
// `segment` row offers the same skill again five minutes later.
//
// Run: npm test -- stand-in-skills

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-skills-'));
process.env.STATE_DIR = root;

const SOLO = ['solo-word', 'solo-bracket', 'solo-direct', 'solo-forced'];
const COHOSTED = ['duo-agent', 'duo-direct', 'duo-forced', 'curiosity'];
for (const slug of [...SOLO, ...COHOSTED]) {
  const dir = join(root, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  const cohosts = COHOSTED.includes(slug) ? 'cohosts: true\n' : '';
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ncooldown: 60\n${cohosts}---\nSay something.\n`);
}

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { agenticTick, directorAgent, forcedDirectorAgent, runCapability } = await import('../src/skills/_agent.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { recentAiredCuriosity } = await import('../src/skills/curiosity.js');

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<unknown> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
const realDirectorRun = directorAgent.run;
const realForcedRun = forcedDirectorAgent.run;

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '', frequency: 'aggressive' };
const GUEST = { ...template, id: 'p_guest', name: 'Niki', language: '', frequency: 'aggressive' };
const SHOW = 's_stand_in_skills';
const ctx = () => ({
  at: new Date().toISOString(),
  time: { period: 'day', vibe: 'day', mood: 'calm' },
  clock: {}, weather: null, festival: null, dominantMood: 'calm',
  activeShow: { id: SHOW, name: 'Stand-in', topic: 'tests' },
}) as never;

const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

let spoken: string[] = [];
let modelCalls = 0;
let reply: Record<string, unknown> = {};

async function station({ skill, guests = false, runtime = 'agent' }: { skill: string; guests?: boolean; runtime?: 'agent' | 'direct' }) {
  await settings.update({
    // Only this skill on offer, so "the second tick offers nothing" is about it.
    personas: [{ ...HOST, skills: [skill] }, { ...GUEST, skills: [skill] }], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, guestPersonaIds: guests ? [GUEST.id] : [], energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    sfx: { enabled: false },
    skills: { enabled: { [skill]: true } },
    llm: {
      provider: 'openai-compatible', compatibleMode: 'local', baseUrl: 'http://stand-in-model.invalid/v1',
      model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0, segmentRuntime: runtime,
    },
  } as never);
  session.start(ctx());
  await loadSkills();
}

// Answers every call with `reply`, as a finishing tool call when one is offered.
function stubModel(t: TestContext) {
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model as never, 'doGenerate', (async (options: { tools?: { name: string }[] }) => {
      modelCalls += 1;
      const finish = options.tools?.find(tool => tool.name === 'done' || tool.name === 'emit');
      return {
        content: finish
          ? [{ type: 'tool-call', toolCallId: 'finish', toolName: finish.name, input: JSON.stringify(reply) }]
          : [{ type: 'text', text: JSON.stringify(reply) }],
        finishReason: { unified: finish ? 'tool-calls' : 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    }) as never);
  }
}

const discussion = (host: string, guest: string) => ({
  reason: 'tests', air: true,
  lines: [{ speaker: HOST.id, text: host }, { speaker: GUEST.id, text: guest }],
});

const errors = () => queue.djLog.filter(entry => entry.kind === 'error').map(entry => entry.message);

beforeEach(() => {
  spoken = [];
  modelCalls = 0;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => ({ voiceId: 'v', clipMs: 1_000, aired: Promise.resolve(null) });
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
});

after(async () => {
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  directorAgent.run = realDirectorRun;
  forcedDirectorAgent.run = realForcedRun;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

const directorWrites = (kind: string, text: string) => {
  const runs = { count: 0 };
  directorAgent.run = (async () => {
    runs.count += 1;
    return { object: { air: true, reason: 'tests', segment: { kind, text, sfx: null } }, steps: 1, toolCalls: [], extras: undefined };
  }) as never;
  return runs;
};

for (const [skill, line] of [['solo-word', 'placeholder'], ['solo-bracket', '[Insert weather update here]']]) {
  test(`a solo skill whose line is ${line} backs off`, async () => {
    await station({ skill });
    const director = directorWrites(skill, line);

    await agenticTick(ctx());
    await agenticTick(ctx());

    assert.equal(director.count, 1, 'the second tick does not offer the skill again');
    assert.deepEqual(spoken, []);
    assert.deepEqual(errors(), []);
  });
}

test('a solo skill whose line is a stand-in backs off in pool mode', async t => {
  await station({ skill: 'solo-direct', runtime: 'direct' });
  stubModel(t);
  reply = { air: true, reason: 'tests', text: 'placeholder', sfx: null };

  await agenticTick(ctx());
  const afterFirstTick = modelCalls;
  await agenticTick(ctx());

  assert.ok(afterFirstTick > 0, 'the model did write the line');
  assert.equal(modelCalls, afterFirstTick, 'the second tick spends no model call');
  assert.deepEqual(spoken, []);
});

test('a forced run that writes a stand-in holds the director off too', async () => {
  await station({ skill: 'solo-forced' });
  forcedDirectorAgent.run = (async () => ({ object: { text: 'placeholder', sfx: null }, steps: 1, toolCalls: [], extras: undefined })) as never;
  const director = directorWrites('solo-forced', 'A real line.');

  const run = await runCapability('solo-forced', ctx());
  await agenticTick(ctx());

  assert.match(String(run.reason), /stand-in/);
  assert.equal(director.count, 0, 'the skill that just wrote a stand-in is not offered');
});

test('a co-hosted skill that writes only stand-ins backs off, through the director', async t => {
  await station({ skill: 'duo-agent', guests: true });
  stubModel(t);
  reply = discussion('placeholder', '[Insert reply here]');
  const director = directorWrites('duo-agent', 'A line.');

  await agenticTick(ctx());
  await agenticTick(ctx());

  assert.equal(director.count, 1, 'the second tick does not offer the skill again');
  assert.deepEqual(spoken, []);
  assert.deepEqual(errors(), [], 'a stand-in is a stand-down, not a render failure');
});

test('a co-hosted skill that writes only stand-ins backs off, in pool mode', async t => {
  await station({ skill: 'duo-direct', guests: true, runtime: 'direct' });
  stubModel(t);
  reply = discussion('TBD', 'placeholder');

  await agenticTick(ctx());
  const afterFirstTick = modelCalls;
  await agenticTick(ctx());

  assert.ok(afterFirstTick > 0, 'the model did write the lines');
  assert.equal(modelCalls, afterFirstTick, 'the second tick spends no model call');
  assert.deepEqual(spoken, []);
  assert.deepEqual(errors(), []);
});

test('a forced co-hosted run on stand-ins stands down instead of throwing', async t => {
  await station({ skill: 'duo-forced', guests: true });
  stubModel(t);
  reply = discussion('placeholder', 'placeholder');

  const run = await runCapability('duo-forced', ctx());

  assert.equal(run.aired, false);
  assert.equal(run.queued, false);
  assert.equal(run.text, null);
  assert.match(String(run.reason), /stand-in/);
  assert.deepEqual(spoken, []);
  assert.deepEqual(errors(), []);
});

test('the curiosity ledger and the forced run keep only what aired', async t => {
  await station({ skill: 'curiosity', guests: true });
  stubModel(t);
  reply = discussion('Octopuses have three hearts, and two stop when they swim.', 'placeholder');

  const run = await runCapability('curiosity', ctx());

  assert.deepEqual(spoken, ['Octopuses have three hearts, and two stop when they swim.']);
  assert.doesNotMatch(String(run.text), /placeholder/);
  assert.doesNotMatch(JSON.stringify(recentAiredCuriosity()), /placeholder/);
});
