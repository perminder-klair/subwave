// The weather segment's gates and its bookkeeping, through the real runners
// with the model, TTS and Open-Meteo stubbed.
//
// 1. Both gates ask weather-policy.ts: the simple path's chooseCapability and
//    the agentic tick's "weather alone and nothing new" skip open on a new
//    outlook under an unchanged sky, and stay shut on a standing one. They used
//    to look at the sky only, so a rain warning never aired on its own.
// 2. An aired weather segment records what its tool returned, not a forecast
//    re-read after the model call and TTS: here the cache refreshes during TTS,
//    and the station must still remember the outlook that went on air.
// 3. A temperature note coming and going with the hour never wakes them: it
//    drove most of the extra weather segments on real forecasts.
// 4. Nor does a forecast aged past use during an outage, whose rows run out
//    and would otherwise read as the rain no longer coming.
//
// Run: npm test -- weather-gates

import assert from 'node:assert/strict';
import { after, beforeEach, test, type TestContext } from 'node:test';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';
import { weekFor as fullScheduleWeek } from './test-utils/fixtures.js';

const root = createTempDir(join(tmpdir(), 'subwave-weather-gates-'));
process.env.STATE_DIR = root;

// The built-in weather skill as a station runs it, with no cooldown, so one
// test can air it and then ask again.
const builtin = fileURLToPath(new URL('../src/skills/builtins/weather/', import.meta.url));
const skillDir = join(root, 'skills', 'weather');
mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), readFileSync(join(builtin, 'SKILL.md'), 'utf8').replace(/^cooldown: .*$/m, 'cooldown: 0s'));
copyFileSync(join(builtin, 'tool.mjs'), join(skillDir, 'tool.mjs'));

const settings = await import('../src/settings.js');
const session = await import('../src/broadcast/session.js');
const { queue } = await import('../src/broadcast/queue.js');
const { loadSkills } = await import('../src/skills/loader.js');
const { agenticTick, chooseCapability, directorAgent, runCapability } = await import('../src/skills/_agent.js');
const { getWeather, getWeatherOutlook, invalidateWeatherCache } = await import('../src/context.js');
const { primaryLeg } = await import('../src/llm/internal/provider/legs.js');
const { writeSilentWav } = await import('../src/audio/wav-silence.js');

type Seams = { _speak: (text: string) => Promise<string>; _airVoice: () => Promise<unknown> };
const seams = queue as unknown as Seams;
const realSpeak = seams._speak;
const realAirVoice = seams._airVoice;
const realDirectorRun = directorAgent.run;

const template = settings.get().personas[0];
const HOST = { ...template, id: 'p_host', name: 'Manolo X', language: '', frequency: 'aggressive', skills: ['weather'] };
const SHOW = 's_weather_gates';

const wav = join(root, 'test.wav');
await writeSilentWav(wav, 100);

// Two forecasts under the same mainly-clear sky (code 1): one with nothing
// coming, one with showers three hours out and a cooler night.
const hours = ['2026-10-31T00:00', '2026-10-31T01:00', '2026-10-31T02:00', '2026-10-31T03:00',
  '2026-10-31T04:00', '2026-10-31T05:00', '2026-10-31T06:00', '2026-10-31T07:00'];
const current = { time: '2026-10-31T00:15', temperature_2m: 17.2, weather_code: 1, is_day: 0 };
const QUIET = {
  current,
  hourly: { time: hours, temperature_2m: Array(8).fill(17), weather_code: Array(8).fill(1), precipitation_probability: Array(8).fill(0) },
};
const RAIN = {
  current,
  hourly: {
    time: hours,
    temperature_2m: [17.2, 16.6, 16.1, 15.4, 14.9, 14.2, 13.8, 13.5],
    weather_code: [1, 2, 3, 80, 61, 3, 2, 1],
    precipitation_probability: [0, 5, 20, 70, 85, 40, 10, 0],
  },
};

// The same sky with a cooler night ahead (17 down to 13): a temperature note only.
const COOLER = {
  current,
  hourly: { ...QUIET.hourly, temperature_2m: [17, 16.5, 16, 15, 14.5, 14, 13.4, 13] },
};

let forecast: object = QUIET;
let spoken: string[] = [];
let duringTts: (() => Promise<void>) | null = null;

function stubForecast(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('api.open-meteo.com')) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(forecast));
  });
}

// Fetch `next` into the weather cache and return the context a tick would get.
async function weatherIs(next: object) {
  forecast = next;
  invalidateWeatherCache();
  const weather = await getWeather();
  return {
    at: new Date().toISOString(),
    time: { period: 'night', vibe: 'night', mood: 'calm' },
    clock: {}, weather, festival: null, dominantMood: 'calm',
    activeShow: { id: SHOW, name: 'Weather', topic: 'tests' },
  } as never;
}

// Answers every model call with an aired line, as a finishing tool call when one
// is offered. Call it after station(): a settings change builds a new client.
function stubModel(t: TestContext) {
  const reply = { reason: 'tests', air: true, text: 'A mainly clear night out there.', sfx: null };
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

// Counts director runs and stays silent, so a tick only shows whether the gate let it through.
function countDirectorRuns() {
  const runs = { count: 0 };
  directorAgent.run = (async () => {
    runs.count += 1;
    return { object: { air: false, reason: 'tests', segment: null }, steps: 1, toolCalls: [], extras: undefined };
  }) as never;
  return runs;
}

async function station(runtime: 'agentic' | 'direct') {
  await settings.update({
    personas: [HOST], activePersonaId: HOST.id,
    shows: [{ id: SHOW, name: 'Weather', topic: 'tests', personaId: HOST.id, guestPersonaIds: [], energies: ['medium'] }],
    schedule: fullScheduleWeek(SHOW), scheduleOverride: null,
    tts: { enabled: true },
    sfx: { enabled: false },
    skills: { enabled: { weather: true } },
    llm: {
      provider: 'openai-compatible', compatibleMode: 'local', baseUrl: 'http://weather-gates-model.invalid/v1',
      model: 'stub', fallback: { enabled: false }, dailyTokenCap: 0, segmentRuntime: runtime,
    },
  } as never);
  session.start(await weatherIs(forecast));
  const caps = await loadSkills();
  const weather = caps.find(c => c.kind === 'weather');
  assert.ok(weather, 'the weather skill loads');
  return weather;
}

// Air one forced weather segment from the current forecast, through the
// direct path: the real tool runs, then the model, then TTS.
async function airWeather(ctx: never) {
  const run = await runCapability('weather', ctx);
  assert.equal(run.queued, true, JSON.stringify(run));
}

beforeEach(() => {
  spoken = [];
  duringTts = null;
  queue.senderBusy = true;
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  queue.djLog = [];
  seams._speak = async (text: string) => {
    spoken.push(text);
    if (duringTts) await duringTts();
    return wav;
  };
  seams._airVoice = async () => ({ voiceId: 'v', clipMs: 1_000, aired: Promise.resolve(null) });
  directorAgent.run = realDirectorRun;
});

after(async () => {
  seams._speak = realSpeak;
  seams._airVoice = realAirVoice;
  directorAgent.run = realDirectorRun;
  queue.senderBusy = false;
  invalidateWeatherCache();
  await new Promise(resolve => setTimeout(resolve, 1_100));
  await removeTempDir(root);
});

test('the simple path picks weather for a new outlook under the same sky, and not for a standing one', async (t) => {
  stubForecast(t);
  forecast = QUIET;
  const cap = await station('direct');
  stubModel(t);
  await airWeather(await weatherIs(QUIET));
  assert.equal(spoken.length, 1, 'one weather segment aired');

  assert.equal(chooseCapability([cap], await weatherIs(QUIET)), null, 'same sky, same outlook: nothing new');
  assert.equal(chooseCapability([cap], await weatherIs(RAIN))?.kind, 'weather', 'same sky, rain now likely: news');
});

test('the agentic tick asks the model about weather alone only when the sky or the outlook changed', async (t) => {
  stubForecast(t);
  forecast = QUIET;
  // Aired through the direct path, so the real tool's result is what is recorded.
  await station('direct');
  stubModel(t);
  await airWeather(await weatherIs(QUIET));
  await station('agentic');

  const runs = countDirectorRuns();
  await agenticTick(await weatherIs(QUIET));
  assert.equal(runs.count, 0, 'a standing outlook under the same sky is skipped before the model');
  await agenticTick(await weatherIs(RAIN));
  assert.equal(runs.count, 1, 'a new outlook under the same sky reaches the model');
});

test('an aired segment records the outlook its tool returned, not one re-read after TTS', async (t) => {
  stubForecast(t);
  forecast = RAIN;
  const cap = await station('direct');
  stubModel(t);
  const ctx = await weatherIs(RAIN);
  assert.deepEqual(getWeatherOutlook().kinds, ['rain-likely', 'cooler']);
  // The cache refreshes while the line is being rendered: the forecast that
  // aired is RAIN, the one in the cache when the segment is recorded is QUIET.
  duringTts = async () => {
    duringTts = null;
    await weatherIs(QUIET);
  };
  await airWeather(ctx);
  assert.equal(spoken.length, 1);
  assert.deepEqual(getWeatherOutlook().kinds, [], 'the cache moved on during TTS');

  // The station remembers RAIN's outlook as said: QUIET is news (the rain is
  // no longer coming) and RAIN is not. Re-reading the cache at record time
  // would have stored QUIET's and answered the other way round.
  assert.equal(chooseCapability([cap], await weatherIs(QUIET))?.kind, 'weather');
  assert.equal(chooseCapability([cap], await weatherIs(RAIN)), null);
});

test('a temperature note coming or going never wakes either gate', async (t) => {
  stubForecast(t);
  forecast = COOLER;
  const cap = await station('direct');
  stubModel(t);
  const ctx = await weatherIs(COOLER);
  assert.deepEqual(getWeatherOutlook().kinds, ['cooler']);
  await airWeather(ctx);
  assert.equal(spoken.length, 1);

  assert.equal(chooseCapability([cap], await weatherIs(QUIET)), null, 'the cooler note went: nothing new');
  assert.equal(chooseCapability([cap], await weatherIs(COOLER)), null, 'and came back: still nothing new');

  await station('agentic');
  const runs = countDirectorRuns();
  await agenticTick(await weatherIs(QUIET));
  await agenticTick(await weatherIs(COOLER));
  assert.equal(runs.count, 0, 'the agentic skip holds too');
});

test('a forecast aged past use in an outage never reads as the rain no longer coming', async (t) => {
  stubForecast(t);
  forecast = RAIN;
  const cap = await station('direct');
  stubModel(t);
  const ctx = await weatherIs(RAIN);
  await airWeather(ctx);
  assert.equal(chooseCapability([cap], ctx), null, 'fresh: the rain aired is still coming');

  // Six hours on with every fetch failing: the cached rows have nearly run
  // out and the showers have passed. Read as a live forecast they would say
  // the rain is off; read as what they are, they are no outlook at all.
  const realNow = Date.now();
  t.mock.method(Date, 'now', () => realNow + 6 * 3_600_000);
  assert.equal(getWeatherOutlook().kinds, null);
  assert.equal(chooseCapability([cap], ctx), null);
});
