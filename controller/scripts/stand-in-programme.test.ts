// A programme beat the queue refused never aired, so it must not read as aired.
// `markProgrammeBeat` claims a beat BEFORE air so the hourly cron and the track
// boundary cannot both fire it, which is why the automatic path keeps its claim
// and undoes only the air stamp: that stamp is what stands the hourly check down
// for an hour, and with nothing on air there is nothing to stand down for.
//
// Run: npm test -- stand-in-programme

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';
import { listen } from './test-utils/http.js';

const root = createTempDir(join(tmpdir(), 'subwave-stand-in-programme-'));
process.env.STATE_DIR = root;
// requireAdmin is a no-op with these unset, so the dj router mounts bare.
delete process.env.ADMIN_USER;
delete process.env.ADMIN_PASS;

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const programme = await import('../src/broadcast/programme.js');
const { queue } = await import('../src/broadcast/queue.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');
const { default: express } = await import('express');
const { router: djRouter } = await import('../src/routes/dj.js');

const app = express();
app.use(express.json());
app.use(djRouter);
const http = await listen(app);

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<unknown> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '' };
const SHOW = 's_stand_in_programme';
const ctx = () => ({
  at: new Date().toISOString(), time: { period: 'day', vibe: 'day', mood: 'calm' },
  clock: {}, weather: null, festival: null, dominantMood: 'calm',
  activeShow: { id: SHOW, name: 'Stand-in', topic: 'tests' },
}) as never;

const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

let spoken: string[] = [];
let line = 'placeholder';

function stubModel(t: TestContext) {
  const leg = primaryLeg();
  for (const model of new Set([leg.model, leg.noThinkModel])) t.mock.method(model as never, 'doGenerate', (async () => ({
    content: [{ type: 'text', text: line }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    warnings: [],
  })) as never);
}

async function press(type: string) {
  const res = await fetch(`${http.url}/dj/segment`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const beats = () => session.getProgramme()?.beats ?? {};

beforeEach(async () => {
  spoken = [];
  line = 'placeholder';
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  seams._speak = async (text: string) => { spoken.push(text); return wav; };
  seams._airVoice = async () => ({ voiceId: 'v', clipMs: 1_000, aired: Promise.resolve(null) });
  await settings.update({
    personas: [HOST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Stand-in', topic: 'tests', personaId: HOST.id, energies: ['medium'], programme: true }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    llm: { provider: 'openai-compatible', compatibleMode: 'local', baseUrl: 'http://stand-in-model.invalid/v1',
      model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0 },
  } as never);
  session.start(ctx());
  session.attachProgramme({ status: 'ok', plan: { angle: 'Angle', introNote: null, outroNote: null, features: [] } as never, beats: {}, introAiredAt: null });
});

after(async () => {
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  queue.senderBusy = false;
  await http.close();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('a refused manual intro leaves the beat for the show to open with', async t => {
  stubModel(t);
  const res = await press('programme-intro');
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(beats().intro, undefined, 'the automatic intro can still air');
  assert.equal(session.getProgramme()?.introAiredAt, null, 'nothing aired to stand the hourly check down for');
});

test('a manual intro that airs spends the beat', async t => {
  stubModel(t);
  line = 'Welcome to the show, the ferries are running late.';
  const res = await press('programme-intro');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(beats().intro, true);
  assert.ok(session.getProgramme()?.introAiredAt);
  assert.equal(programme.suppressHourly(), true);
});

test('a refused manual outro leaves the beat', async t => {
  stubModel(t);
  const res = await press('programme-outro');
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(beats().outro, undefined);
});

test('a manual outro that airs spends the beat', async t => {
  stubModel(t);
  line = 'That was the show, good night from Chania.';
  const res = await press('programme-outro');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(beats().outro, true);
});

test('a refused automatic intro reports false and lets the hourly check through', async t => {
  stubModel(t);
  const aired = await programme.maybeRunIntro(queue as never, ctx());
  assert.equal(aired, false, 'scheduler.rollSessionNow reads this as "the intro aired"');
  assert.deepEqual(spoken, []);
  assert.equal(session.getProgramme()?.introAiredAt, null);
  assert.equal(programme.suppressHourly(), false);
});

test('a refused automatic intro stays claimed, so a stuck model is not asked again', async t => {
  stubModel(t);
  await programme.maybeRunIntro(queue as never, ctx());
  assert.equal(beats().intro, true);
  assert.equal(await programme.maybeRunIntro(queue as never, ctx()), false);
  assert.ok(queue.djLog.filter(entry => /dropped a stand-in line/.test(entry.message)).length === 1, 'one attempt');
});

test('an automatic intro that airs reports true and stands the hourly check down', async t => {
  stubModel(t);
  line = 'Welcome to the show, the ferries are running late.';
  assert.equal(await programme.maybeRunIntro(queue as never, ctx()), true);
  assert.deepEqual(spoken, [line]);
  assert.ok(session.getProgramme()?.introAiredAt);
  assert.equal(programme.suppressHourly(), true);
});

test('two call sites racing one intro still air it once', async t => {
  stubModel(t);
  line = 'Welcome to the show, the ferries are running late.';
  const both = await Promise.all([
    programme.maybeRunIntro(queue as never, ctx()),
    programme.maybeRunIntro(queue as never, ctx()),
  ]);
  assert.deepEqual([...both].sort(), [false, true]);
  assert.equal(spoken.length, 1, 'the claim before air is what holds this');
});
