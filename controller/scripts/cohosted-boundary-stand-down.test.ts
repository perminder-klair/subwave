// A co-hosted exchange that loses its boundary stands down; it is not a render
// failure (#2259). With djTalkOnlyBetweenTracks on, a scheduled exchange held
// for the next track meets a clip already waiting there and the queue declines
// it (holdForNextTrack's one-boundary rule). Both co-hosted callers in
// skills/_agent.ts used to read that `false` as "failed to render" and throw,
// so the booth log carried a red error for a segment that rendered fine and was
// simply out-placed. These drive the real runners with the model stubbed.
//
// Run: npm test -- cohosted-boundary-stand-down

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-cohosted-boundary-'));
process.env.STATE_DIR = root;

const SKILLS = ['duo-forced', 'duo-director'];
for (const slug of SKILLS) {
  const dir = join(root, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ncooldown: 60\ncohosts: true\n---\nSay something.\n`);
}

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { withTalkAir } = await import('../src/broadcast/talk-air.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { agenticTick, directorAgent, runCapability } = await import('../src/skills/_agent.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<unknown> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
const realDirectorRun = directorAgent.run;

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '', frequency: 'aggressive' };
const GUEST = { ...template, id: 'p_guest', name: 'Niki', language: '', frequency: 'aggressive' };
const SHOW = 's_cohosted_boundary';
const ctx = () => ({
  at: new Date().toISOString(),
  time: { period: 'day', vibe: 'day', mood: 'calm' },
  clock: {}, weather: null, festival: null, dominantMood: 'calm',
  activeShow: { id: SHOW, name: 'Boundary', topic: 'tests' },
}) as never;

const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

async function station(skill: string) {
  await settings.update({
    personas: [{ ...HOST, skills: [skill] }, { ...GUEST, skills: [skill] }], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Boundary', topic: 'tests', personaId: HOST.id, guestPersonaIds: [GUEST.id], energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    djTalkOnlyBetweenTracks: true,
    tts: { enabled: true },
    sfx: { enabled: false },
    skills: { enabled: { [skill]: true } },
    llm: {
      provider: 'openai-compatible', compatibleMode: 'local', baseUrl: 'http://cohosted-boundary.invalid/v1',
      model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0, segmentRuntime: 'agent',
    },
  } as never);
  session.start(ctx());
  await loadSkills();
}

// Answers every call with a real two-line discussion.
function stubModel(t: TestContext) {
  const reply = {
    reason: 'tests', air: true,
    lines: [{ speaker: HOST.id, text: 'A real opening line.' }, { speaker: GUEST.id, text: 'A real reply.' }],
  };
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) {
    t.mock.method(model as never, 'doGenerate', (async (options: { tools?: { name: string }[] }) => {
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

// A scheduled ident already waiting for the boundary the exchange wants.
async function identWaiting() {
  await withTalkAir('next-track', async () =>
    queue.holdForNextTrack('station-id', [{ text: 'ident', wavPath: wav, persona: null, meta: {} }]));
  assert.equal(queue.pendingVoiceTalk()?.kind, 'station-id');
}

const errors = () => queue.djLog.filter(entry => entry.kind === 'error').map(entry => entry.message);
const scheduler = () => queue.djLog.filter(entry => entry.kind === 'scheduler').map(entry => entry.message);

beforeEach(() => {
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  queue._pendingVoice = null;
  seams._speak = async () => wav;
  seams._airVoice = async () => ({ voiceId: 'v', clipMs: 1_000, aired: Promise.resolve(null) });
  directorAgent.run = realDirectorRun;
});

after(async () => {
  queue._pendingVoice = null;
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  directorAgent.run = realDirectorRun;
  queue.senderBusy = false;
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('a forced co-hosted run that loses the boundary stands down instead of throwing', async t => {
  await station('duo-forced');
  stubModel(t);
  await identWaiting();

  // The path a cron fire takes with the switch on: the next-track scope.
  const run = await withTalkAir('next-track', () => runCapability('duo-forced', ctx(), { automaticHostSpeech: true }));

  assert.equal(run.aired, false);
  assert.equal(run.queued, false);
  assert.match(String(run.reason), /boundary is already taken/);
  assert.deepEqual(errors(), [], 'a lost boundary is a stand-down, not a render failure');
  assert.equal(queue.pendingVoiceTalk()?.kind, 'station-id', 'the waiting ident keeps the boundary');
});

test('the segment director stands down when its exchange loses the boundary', async t => {
  await station('duo-director');
  stubModel(t);
  directorAgent.run = (async () => ({
    object: { air: true, reason: 'tests', segment: { kind: 'duo-director', text: 'A line.', sfx: null } },
    steps: 1, toolCalls: [], extras: undefined,
  })) as never;
  await identWaiting();

  await withTalkAir('next-track', () => agenticTick(ctx()));

  assert.deepEqual(errors(), [], 'a lost boundary is a stand-down, not a render failure');
  assert.ok(scheduler().some(line => /duo-director stood down — the next track boundary is already taken/.test(line)),
    'and the booth log says why');
  assert.equal(queue.pendingVoiceTalk()?.kind, 'station-id');
});
