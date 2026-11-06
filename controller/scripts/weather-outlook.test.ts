// The station's weather, from the forecast fetch to what the DJ is given.
//
// 1. Open-Meteo's code 1 ("mainly clear") reads as clear, not cloudy, and the
//    forecast's own wording rides along as `detail`, which the spoken context
//    line uses. The public reading gains no forecast rows.
// 2. The next hours come from the same call (no second fetch) and reach only
//    the weather skill, through services.weatherOutlook(), which never fetches.
// 3. The built-in weather tool returns the conditions and the outlook, and a
//    call without services (an older custom copy) still answers.
// 4. A high local-colour dial no longer invites weather the prompt doesn't
//    carry (links, idents and handoffs get none, #471).
// 5. The outlook is aged to the moment it is read, and the tool tells a
//    standing note from a new one (outlookChangedSinceLastMention).
//
// Run: npm test -- weather-outlook
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, type TestContext } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateRoot = createTempDir(join(tmpdir(), 'subwave-weather-outlook-'));
process.env.STATE_DIR = stateRoot;

const settings = await import('../src/settings.js');
const { getWeather, getWeatherOutlook, invalidateWeatherCache } = await import('../src/context.js');
const { buildContextLines } = await import('../src/llm/dj.js');
const { fetchSegmentData } = await import('../src/llm/segment-tools.js');
const weatherTool = await import('../src/skills/builtins/weather/tool.mjs');
const { personaToneDirectives } = await import('../src/settings/vocab.js');
const { weatherNews } = await import('../src/skills/weather-policy.js');

await settings.load();
after(async () => { await removeTempDir(stateRoot); });

// A mainly-clear night with showers three hours out.
const reply = {
  current: { time: '2026-10-31T00:15', temperature_2m: 17.2, weather_code: 1, is_day: 0 },
  hourly: {
    time: ['2026-10-31T00:00', '2026-10-31T01:00', '2026-10-31T02:00', '2026-10-31T03:00',
      '2026-10-31T04:00', '2026-10-31T05:00', '2026-10-31T06:00', '2026-10-31T07:00'],
    temperature_2m: [17.2, 16.6, 16.1, 15.4, 14.9, 14.2, 13.8, 13.5],
    weather_code: [1, 2, 3, 80, 61, 3, 2, 1],
    precipitation_probability: [0, 5, 20, 70, 85, 40, 10, 0],
  },
};

function stubForecast(t: TestContext) {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('api.open-meteo.com')) throw new Error(`unexpected fetch ${url}`);
    urls.push(url);
    return new Response(JSON.stringify(reply));
  });
  return urls;
}

test('code 1 is clear, its wording rides along, and the public reading carries no forecast rows', async (t) => {
  invalidateWeatherCache();
  const urls = stubForecast(t);
  const w = await getWeather();
  assert.equal(w.condition, 'clear');
  assert.equal(w.detail, 'mainly clear');
  assert.equal(w.temp, 17);
  assert.ok(!('outlook' in w) && !('nextHours' in w), JSON.stringify(w));
  assert.equal(urls.length, 1);
  assert.match(urls[0], /hourly=temperature_2m,weather_code,precipitation_probability/);
  assert.match(urls[0], /timezone=auto/);
});

test('the outlook comes from the same fetch, and never fetches on its own', async (t) => {
  invalidateWeatherCache();
  const urls = stubForecast(t);
  assert.deepEqual(getWeatherOutlook(), { nextHours: [], notes: [], kinds: [] }, 'a cold cache is no outlook');
  assert.equal(urls.length, 0, 'no fetch from the outlook');
  await getWeather();
  const o = getWeatherOutlook();
  assert.equal(urls.length, 1);
  assert.equal(o.nextHours.length, 6);
  assert.deepEqual(o.notes, ['rain likely in about 3 hours (70% chance)', 'down to 14 degrees Celsius in about 6 hours']);
});

test('the outlook is aged to when it is read, and names its kinds', async (t) => {
  invalidateWeatherCache();
  stubForecast(t);
  await getWeather();
  const fresh = getWeatherOutlook();
  assert.deepEqual(fresh.kinds, ['rain-likely', 'cooler']);
  // 50 minutes after the fetch: the showers are two hours off, not three.
  const later = getWeatherOutlook(Date.now() + 50 * 60_000);
  assert.deepEqual(later.notes, ['rain likely in about 2 hours (70% chance)', 'down to 14 degrees Celsius in about 6 hours']);
  assert.deepEqual(later.kinds, fresh.kinds);
});

test('a standing outlook is not news to the tool; a new one is', async (t) => {
  invalidateWeatherCache();
  stubForecast(t);
  const weather = await getWeather();
  // The two services the tool reads, as buildStationServices wires them.
  const services = { weatherOutlook: getWeatherOutlook, weatherNews };
  const first = await weatherTool.default({ weather }, { lastWeatherCondition: null, lastWeatherOutlook: null }, services);
  assert.equal(first.outlookChangedSinceLastMention, true);
  assert.deepEqual(first.outlookKinds, ['rain-likely', 'cooler'], 'the tool names the outlook it handed over');
  const standing = await weatherTool.default({ weather }, { lastWeatherCondition: 'clear', lastWeatherOutlook: 'rain-likely,cooler' }, services);
  assert.equal(standing.changedSinceLastMention, false);
  assert.equal(standing.outlookChangedSinceLastMention, false);
  const moved = await weatherTool.default({ weather }, { lastWeatherCondition: 'clear', lastWeatherOutlook: 'cooler' }, services);
  assert.equal(moved.outlookChangedSinceLastMention, true);
  // After a weather segment from a tool that gave no outlook, the sky alone decides.
  const oldTool = await weatherTool.default({ weather }, { lastWeatherCondition: 'clear', lastWeatherOutlook: null }, services);
  assert.equal(oldTool.outlookChangedSinceLastMention, false);
});

test('the weather tool returns the conditions and the outlook; without services it still answers', async (t) => {
  invalidateWeatherCache();
  stubForecast(t);
  const weather = await getWeather();
  const cap = { kind: 'weather', toolName: 'weather_tool', toolDesc: weatherTool.description, toolFn: weatherTool.default, config: {} };
  const data = await fetchSegmentData(cap, { weather }, {});
  assert.equal(data.available, true);
  assert.equal(data.condition, 'clear');
  assert.equal(data.conditions, 'mainly clear');
  assert.equal(data.temp, 17);
  assert.deepEqual(data.outlook, ['rain likely in about 3 hours (70% chance)', 'down to 14 degrees Celsius in about 6 hours']);
  assert.equal(data.nextHours.length, 6);

  assert.deepEqual(data.outlookKinds, ['rain-likely', 'cooler']);

  const bare = await weatherTool.default({ weather }, {});
  assert.equal(bare.available, true);
  assert.deepEqual(bare.outlook, []);
  assert.deepEqual(bare.nextHours, []);
  assert.equal(bare.outlookKinds, null, 'no outlook was handed over, so none is named');
  assert.equal(bare.changedSinceLastMention, true);
  assert.equal(bare.outlookChangedSinceLastMention, false);
});

test('the spoken context line uses the forecast wording, and falls back to the condition', () => {
  const lines = (w: object) => buildContextLines({ weather: w }, { contextFields: ['weather'] }).join('\n');
  assert.match(lines({ condition: 'clear', detail: 'mainly clear', temp: 17, tempUnit: 'C' }), /Weather: mainly clear, 17 degrees Celsius/);
  assert.match(lines({ condition: 'cloudy', temp: 12, tempUnit: 'C' }), /Weather: cloudy, 12 degrees Celsius/);
});

test('a high local-colour dial invites the town and the hour, never the weather', () => {
  const high = personaToneDirectives({ humour: 5, localColour: 9, warmth: 5 });
  assert.match(high, /Lean on the local setting/);
  assert.doesNotMatch(high, /weather/i);
});
