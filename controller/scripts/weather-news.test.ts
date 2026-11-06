// Pins skills/weather-policy.ts: whether the weather is news (the sky or its
// outlook changed since the last aired weather segment), and what an aired
// segment counts as having said. The segment gates and the weather tool's
// flags all ask this one helper; weather-gates.test.ts drives them.
//
// Run: npm test -- weather-news

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isWeatherNews,
  outlookKey,
  recordWeatherAired,
  weatherMention,
  weatherNews,
  type WeatherMemory,
} from '../src/skills/weather-policy.js';

const memory = (lastWeatherCondition: string | null, lastWeatherOutlook: string | null): WeatherMemory =>
  ({ lastWeatherCondition, lastWeatherOutlook });

describe('weatherNews', () => {
  it('reports a change of sky and a change of outlook apart', () => {
    const last = memory('clear', 'rain-likely,cooler');
    assert.deepEqual(weatherNews({ condition: 'cloudy', kinds: ['rain-likely', 'cooler'] }, last), { skyChanged: true, outlookChanged: false });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['rain-likely'] }, last), { skyChanged: false, outlookChanged: true });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['rain-likely', 'cooler'] }, last), { skyChanged: false, outlookChanged: false });
  });

  it('compares the outlook by what its notes are about, so possible to likely is news', () => {
    const last = memory('cloudy', outlookKey(['rain-possible']));
    assert.equal(weatherNews({ condition: 'cloudy', kinds: ['rain-possible'] }, last).outlookChanged, false);
    assert.equal(weatherNews({ condition: 'cloudy', kinds: ['rain-likely'] }, last).outlookChanged, true);
    assert.equal(weatherNews({ condition: 'cloudy', kinds: [] }, last).outlookChanged, true, 'the rain no longer coming is news too');
  });

  it('before any weather segment, the sky is news and so is anything the outlook says', () => {
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['cooler'] }, memory(null, null)), { skyChanged: true, outlookChanged: true });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: [] }, memory(null, null)), { skyChanged: true, outlookChanged: false });
    // A bare state object (a tool called outside the station) reads as no memory.
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: [] }, {}), { skyChanged: true, outlookChanged: false });
  });

  it('once a tool that reports no outlook has aired, the sky alone decides', () => {
    // An older seeded tool.mjs never reports outlookKinds, so nothing is recorded for the outlook.
    const old = memory('cloudy', null);
    assert.deepEqual(weatherNews({ condition: 'cloudy', kinds: ['rain-likely'] }, old), { skyChanged: false, outlookChanged: false });
    assert.equal(isWeatherNews({ condition: 'cloudy', kinds: ['rain-likely'] }, old), false);
    assert.equal(isWeatherNews({ condition: 'rainy', kinds: [] }, old), true);
  });

  it('an unknown outlook is never news, and no reading is never news', () => {
    const last = memory('clear', 'rain-likely');
    assert.equal(weatherNews({ condition: 'clear', kinds: null }, last).outlookChanged, false);
    assert.equal(weatherNews({ condition: 'clear' }, last).outlookChanged, false);
    for (const condition of [undefined, null, '', 'unknown']) {
      assert.deepEqual(weatherNews({ condition, kinds: ['rain-likely'] }, memory(null, null)), { skyChanged: false, outlookChanged: false }, String(condition));
    }
    assert.equal(isWeatherNews(null, memory(null, null)), false);
  });
});

describe('weatherMention and recordWeatherAired', () => {
  it('reads the condition and the outlook a tool result handed over', () => {
    assert.deepEqual(
      weatherMention({ available: true, condition: 'clear', outlookKinds: ['rain-likely', 'cooler'] }),
      { condition: 'clear', outlook: 'rain-likely,cooler' },
    );
    assert.deepEqual(weatherMention({ available: true, condition: 'clear', outlookKinds: [] }), { condition: 'clear', outlook: '' });
    // An older tool: no outlookKinds, so it mentions the sky only.
    assert.deepEqual(weatherMention({ available: true, condition: 'cloudy' }), { condition: 'cloudy', outlook: null });
  });

  it('is no mention for a result without a reading', () => {
    for (const data of [null, undefined, { available: false }, { error: 'tool timed out after 8000ms' }, { available: true, condition: 'unknown' }, 'clear']) {
      assert.equal(weatherMention(data), null, JSON.stringify(data));
    }
  });

  it('records what the tool returned, and keeps the outlook when the tool gave none', () => {
    const m = memory(null, null);
    recordWeatherAired(m, 'clear', { condition: 'clear', outlook: 'rain-likely' });
    assert.deepEqual(m, memory('clear', 'rain-likely'));
    recordWeatherAired(m, 'cloudy', { condition: 'cloudy', outlook: null });
    assert.deepEqual(m, memory('cloudy', 'rain-likely'));
  });

  it('records the sky only when the run never called the tool', () => {
    const m = memory('clear', 'rain-likely');
    recordWeatherAired(m, 'cloudy', null);
    assert.deepEqual(m, memory('cloudy', 'rain-likely'));
    recordWeatherAired(m, 'unknown', null);
    assert.deepEqual(m, memory('cloudy', 'rain-likely'), 'an unknown reading records nothing');
  });
});
