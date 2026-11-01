// A manual press must not claim a line that never aired. The dash toast prints
// `spoken` as "on air: …" and MCP's tools say "On-air now", so a dropped line
// used to come back as a success in the words of the line itself, and a styled
// /dj/say played its sound effect under no voice at all. The operator gets an
// error instead, which the Say box answers by keeping the text for a retry.
//
// Run: npm test -- stand-in-dj-routes

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';
import { listen } from './test-utils/http.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-routes-'));
process.env.STATE_DIR = root;
// requireAdmin is a no-op with these unset, so the dj router mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const SFX = 'test-zap';
mkdirSync(join(root, 'sfx'), { recursive: true });
writeFileSync(join(root, 'sfx', `${SFX}.wav`), 'RIFF');
writeFileSync(join(root, 'sfx.json'), JSON.stringify({ items: { [SFX]: { name: SFX, file: `${SFX}.wav`, description: 'tests' } } }));

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { default: express } = await import('express');
const { router: djRouter } = await import('../src/routes/dj.js');

const app = express();
app.use(express.json());
app.use(djRouter);
const http = await listen(app);

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<unknown>; playSfx: (name: string) => Promise<unknown> };
const seams = queue as unknown as Seams;
const real = { speak: seams._speak, airVoice: seams._airVoice, playSfx: seams.playSfx };

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const GUEST = { ...template, id: 'p_guest', name: 'Niki', language: '' };
const SHOW = 's_stand_in_routes';
const ctx = () => ({
  at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
  clock: {}, weather: null, festival: null, dominantMood: 'calm',
  activeShow: { id: SHOW, name: 'Stand-in', topic: 'tests' },
}) as never;

const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

let spoken: string[] = [];
let effects: string[] = [];
let reply: unknown = 'placeholder';

function stubModel(t: TestContext) {
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as never, 'doGenerate', (async (options: { tools?: { name: string }[] }) => {
    const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
    const finish = options.tools?.find(tool => tool.name === 'emit' || tool.name === 'done');
    return {
      content: finish ? [{ type: 'tool-call', toolCallId: 'finish', toolName: finish.name, input: text }] : [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    };
  }) as never);
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${http.url}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  spoken = [];
  effects = [];
  reply = 'placeholder';
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => ({ voiceId: 'v', clipMs: 1_000, aired: Promise.resolve(null) });
  seams.playSfx = async (name: string) => { effects.push(name); };
  await settings.update({
    personas: [HOST, GUEST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, guestPersonaIds: [GUEST.id], energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    llm: { provider: 'openai-compatible', compatibleMode: 'local', baseUrl: 'http://stand-in-model.invalid/v1',
      model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0 },
  } as never);
  session.start(ctx());
});

after(async () => {
  seams._speak = real.speak;
  seams._airVoice = real.airVoice;
  seams.playSfx = real.playSfx;
  queue.senderBusy = false;
  await http.close();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('a styled say that comes back a stand-in is an error, with no sound effect', async t => {
  stubModel(t);
  const res = await post('/dj/say', { text: 'say something nice', mode: 'styled', sfx: SFX });
  assert.equal(res.status, 502);
  assert.match(String(res.body.error), /stand-in/);
  assert.equal(res.body.ok, undefined);
  assert.deepEqual(spoken, []);
  assert.deepEqual(effects, [], 'no effect under a voice that never came');
});

test('a styled say that airs keeps its sound effect and its ok', async t => {
  stubModel(t);
  reply = 'A real line from the desk.';
  const res = await post('/dj/say', { text: 'say something nice', mode: 'styled', sfx: SFX });
  assert.equal(res.status, 200);
  assert.equal(res.body.spoken, 'A real line from the desk.');
  assert.deepEqual(effects, [SFX]);
});

test('a raw say is the operator\'s own text, whatever it says', async () => {
  const res = await post('/dj/say', { text: 'Placeholder', mode: 'raw', sfx: SFX });
  assert.equal(res.status, 200);
  assert.equal(res.body.spoken, 'Placeholder');
  assert.deepEqual(spoken, ['Placeholder']);
  assert.deepEqual(effects, [SFX]);
});

for (const type of ['hourly', 'station-id']) {
  test(`a ${type} press that writes a stand-in reports that nothing aired`, async t => {
    stubModel(t);
    const res = await post('/dj/segment', { type });
    assert.equal(res.status, 502);
    assert.match(String(res.body.error), /nothing aired/);
    assert.equal(res.body.spoken, undefined, 'the toast must not print the dropped line as on air');
    assert.deepEqual(spoken, []);
  });

  test(`a ${type} press that airs still reports its words`, async t => {
    stubModel(t);
    reply = 'A real line from the desk.';
    const res = await post('/dj/segment', { type });
    assert.equal(res.status, 200);
    assert.equal(res.body.spoken, 'A real line from the desk.');
  });
}

test('a press whose voice fails to render reports that nothing aired', async t => {
  stubModel(t);
  reply = 'A real line from the desk.';
  seams._speak = async () => { throw new Error('no voice'); };
  const res = await post('/dj/segment', { type: 'hourly' });
  assert.equal(res.status, 502);
  assert.equal(res.body.spoken, undefined);
});

test('a banter press whose every line is a stand-in reports that nothing aired', async t => {
  stubModel(t);
  reply = { lines: [
    { speaker: HOST.id, text: 'placeholder' },
    { speaker: GUEST.id, text: 'TBD' },
    { speaker: HOST.id, text: '<p>TBD</p>' },
  ] };
  const res = await post('/dj/segment', { type: 'banter' });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.match(String(res.body.error), /nothing aired/);
  assert.deepEqual(spoken, []);
});

test('a banter press whose voice fails is still a render failure', async t => {
  stubModel(t);
  reply = { lines: [
    { speaker: HOST.id, text: 'Storms over Crete tonight.' },
    { speaker: GUEST.id, text: 'The ferries are docked in Chania.' },
    { speaker: HOST.id, text: 'And the wind is not done yet.' },
  ] };
  seams._speak = async () => { throw new Error('no voice'); };
  const res = await post('/dj/segment', { type: 'banter' });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.match(String(res.body.error), /failed to render/);
});

test('a banter press reports the lines that aired, not the one that was dropped', async t => {
  stubModel(t);
  reply = { lines: [
    { speaker: HOST.id, text: 'Storms over Crete tonight.' },
    { speaker: GUEST.id, text: 'placeholder' },
    { speaker: HOST.id, text: 'The ferries are docked in Chania.' },
  ] };
  const res = await post('/dj/segment', { type: 'banter' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(spoken, ['Storms over Crete tonight.', 'The ferries are docked in Chania.']);
  assert.doesNotMatch(String(res.body.spoken), /placeholder/);
  assert.match(String(res.body.spoken), /Storms over Crete/);
});
