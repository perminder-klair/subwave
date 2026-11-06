// Pins skills/weather-policy.ts: whether the weather is news (the sky changed,
// or the outlook says something the last aired weather segment didn't), and
// what an aired segment counts as having said. The segment gates and the
// weather tool's flags all ask this one helper; weather-gates.test.ts drives
// them.
//
// The outlook is judged by news class: no timing, no temperature, and possible
// and likely as one. Only an added class is news, except precipitation the
// aired outlook promised that is no longer coming, which brings its own note,
// so a changed outlook is never an empty one (the last test checks that over
// many generated forecasts).
//
// Run: npm test -- weather-news

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildOutlook, conditionForCode, outlookEvents, type OutlookNoteKind, type WeatherCondition } from '../src/weather-codes.js';
import {
  isWeatherNews,
  outlookKey,
  recordWeatherAired,
  weatherMention,
  weatherNews,
  type WeatherMemory,
} from '../src/skills/weather-policy.js';

const memory = (lastWeatherCondition: WeatherCondition | null, lastWeatherOutlook: string | null): WeatherMemory =>
  ({ lastWeatherCondition, lastWeatherOutlook });
// The memory a segment that aired these kinds leaves behind.
const aired = (sky: WeatherCondition, kinds: OutlookNoteKind[]) => memory(sky, outlookKey(kinds));
const changed = (sky: string, kinds: OutlookNoteKind[], last: WeatherMemory) => weatherNews({ condition: sky, kinds }, last).outlookChanged;

describe('weatherNews', () => {
  it('reports a change of sky and a change of outlook apart', () => {
    const last = aired('clear', ['clouding', 'cooler']);
    assert.deepEqual(weatherNews({ condition: 'cloudy', kinds: ['clouding', 'cooler'] }, last), { skyChanged: true, outlookChanged: false, withdrawn: [] });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['rain-likely', 'clouding'] }, last), { skyChanged: false, outlookChanged: true, withdrawn: [] });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['clouding', 'cooler'] }, last), { skyChanged: false, outlookChanged: false, withdrawn: [] });
  });

  it('never counts a temperature note, coming or going', () => {
    const quiet = aired('clear', []);
    assert.equal(changed('clear', ['cooler'], quiet), false, 'a cooler night appearing is not news');
    assert.equal(changed('clear', ['warmer'], quiet), false);
    assert.equal(changed('clear', [], aired('clear', ['cooler'])), false, 'the cooler note going is not news');
    assert.equal(changed('clear', ['warmer'], aired('clear', ['cooler'])), false, 'cooler turning warmer is not news');
  });

  it('treats possible and likely as one class, so a chance hovering at 50% is not news', () => {
    assert.equal(changed('cloudy', ['rain-likely'], aired('cloudy', ['rain-possible'])), false);
    assert.equal(changed('cloudy', ['rain-possible'], aired('cloudy', ['rain-likely'])), false);
    assert.equal(changed('cloudy', ['rain-possible'], aired('cloudy', ['precip-likely'])), false, 'a high chance on a dry-code row is rain too');
    assert.equal(changed('clear', ['snow-likely'], aired('clear', ['snow-possible'])), false);
    assert.equal(changed('clear', ['storm-likely'], aired('clear', ['storm-possible'])), false);
    assert.equal(changed('cloudy', ['storm-likely'], aired('cloudy', ['rain-likely'])), true, 'thunderstorms where rain was said is news');
    assert.equal(changed('clear', ['snow-likely'], aired('clear', ['rain-likely'])), true, 'snow where rain was said is news');
  });

  it('counts only something added, never a note that has gone, besides precipitation', () => {
    assert.equal(changed('cloudy', ['clearing'], aired('cloudy', [])), true, 'clearing, newly in the window');
    assert.equal(changed('cloudy', [], aired('cloudy', ['clearing'])), false, 'clearing no longer in the window');
    assert.equal(changed('rainy', [], aired('rainy', ['drying'])), false, 'drying out no longer in the window');
    assert.equal(changed('clear', ['clouding'], aired('clear', ['clouding', 'rain-likely'])), true, 'the rain went: the exception');
  });

  it('says so when precipitation it promised is no longer coming, under a dry sky', () => {
    assert.deepEqual(
      weatherNews({ condition: 'cloudy', kinds: [] }, aired('cloudy', ['rain-likely', 'cooler'])),
      { skyChanged: false, outlookChanged: true, withdrawn: [{ kind: 'rain-withdrawn', text: 'rain no longer expected in the next 6 hours' }] },
    );
    assert.deepEqual(
      weatherNews({ condition: 'clear', kinds: ['cooler'] }, aired('clear', ['storm-possible'])).withdrawn,
      [{ kind: 'storm-withdrawn', text: 'thunderstorms no longer expected in the next 6 hours' }],
    );
    assert.deepEqual(
      weatherNews({ condition: 'clear', kinds: [] }, aired('clear', ['snow-likely'])).withdrawn.map(n => n.kind),
      ['snow-withdrawn'],
    );
  });

  it('withdraws nothing while it is falling, or while other precipitation is coming', () => {
    // The rain arrived: the sky is the news, and "no longer expected" would be false.
    assert.deepEqual(weatherNews({ condition: 'rainy', kinds: ['drying'] }, aired('cloudy', ['rain-likely'])), { skyChanged: true, outlookChanged: true, withdrawn: [] });
    assert.deepEqual(weatherNews({ condition: 'snowy', kinds: [] }, aired('cloudy', ['snow-likely'])), { skyChanged: true, outlookChanged: false, withdrawn: [] });
    // Rain became snow: the snow is the news, without a note that rain is off.
    assert.deepEqual(weatherNews({ condition: 'cloudy', kinds: ['snow-likely'] }, aired('cloudy', ['rain-likely'])), { skyChanged: false, outlookChanged: true, withdrawn: [] });
  });

  it('before any weather segment, the sky is news and so is anything the outlook says', () => {
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['clouding'] }, memory(null, null)), { skyChanged: true, outlookChanged: true, withdrawn: [] });
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: ['cooler'] }, memory(null, null)), { skyChanged: true, outlookChanged: false, withdrawn: [] }, 'a temperature note alone says nothing new');
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: [] }, memory(null, null)), { skyChanged: true, outlookChanged: false, withdrawn: [] });
    // A bare state object (a tool called outside the station) reads as no memory.
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: [] }, {}), { skyChanged: true, outlookChanged: false, withdrawn: [] });
  });

  it('once a tool that reports no outlook has aired, the sky alone decides', () => {
    // An older seeded tool.mjs never reports outlookKinds, so nothing is recorded for the outlook.
    const old = memory('cloudy', null);
    assert.deepEqual(weatherNews({ condition: 'cloudy', kinds: ['rain-likely'] }, old), { skyChanged: false, outlookChanged: false, withdrawn: [] });
    assert.equal(isWeatherNews({ condition: 'cloudy', kinds: ['rain-likely'] }, old), false);
    assert.equal(isWeatherNews({ condition: 'rainy', kinds: [] }, old), true);
  });

  it('an unknown outlook is never news, and no reading is never news', () => {
    const last = aired('clear', ['rain-likely']);
    assert.deepEqual(weatherNews({ condition: 'clear', kinds: null }, last), { skyChanged: false, outlookChanged: false, withdrawn: [] }, 'a stale or missing forecast withdraws nothing');
    assert.equal(weatherNews({ condition: 'clear' }, last).outlookChanged, false);
    for (const condition of [undefined, null, '', 'unknown', 'windy']) {
      assert.deepEqual(weatherNews({ condition, kinds: ['rain-likely'] }, memory(null, null)), { skyChanged: false, outlookChanged: false, withdrawn: [] }, String(condition));
    }
    assert.equal(isWeatherNews(null, memory(null, null)), false);
  });
});

describe('outlookKey', () => {
  it('is the news classes, sorted, whatever order or confidence the notes came in', () => {
    assert.equal(outlookKey(['rain-likely', 'cooler', 'clouding']), 'clouding,rain');
    assert.equal(outlookKey(['clouding', 'rain-possible', 'warmer']), 'clouding,rain');
    assert.equal(outlookKey(['cooler', 'rain-withdrawn']), '', 'temperature and withdrawn notes carry no class');
    assert.equal(outlookKey(['not-a-kind']), '');
  });

  it('reads a key of raw kinds as the same outlook', () => {
    assert.equal(changed('clear', ['rain-possible', 'warmer'], memory('clear', 'rain-likely,cooler')), false);
  });
});

describe('weatherMention and recordWeatherAired', () => {
  it('reads the condition and the outlook a tool result handed over', () => {
    assert.deepEqual(
      weatherMention({ available: true, condition: 'clear', outlookKinds: ['rain-likely', 'cooler'] }),
      { condition: 'clear', outlook: 'rain' },
    );
    assert.deepEqual(weatherMention({ available: true, condition: 'clear', outlookKinds: [] }), { condition: 'clear', outlook: '' });
    assert.deepEqual(weatherMention({ available: true, condition: 'clear', outlookKinds: ['cooler', 'rain-withdrawn'] }), { condition: 'clear', outlook: '' });
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
    recordWeatherAired(m, 'clear', { condition: 'clear', outlook: 'rain' });
    assert.deepEqual(m, memory('clear', 'rain'));
    recordWeatherAired(m, 'cloudy', { condition: 'cloudy', outlook: null });
    assert.deepEqual(m, memory('cloudy', 'rain'));
  });

  it('records the sky only when the run never called the tool', () => {
    const m = memory('clear', 'rain');
    recordWeatherAired(m, 'cloudy', null);
    assert.deepEqual(m, memory('cloudy', 'rain'));
    recordWeatherAired(m, 'unknown', null);
    assert.deepEqual(m, memory('cloudy', 'rain'), 'an unknown reading records nothing');
  });
});

// A small seeded generator, so a failure names a forecast that reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const CODES = [0, 1, 2, 3, 45, 51, 53, 61, 63, 65, 71, 73, 80, 81, 85, 95];
const HOURS = Array.from({ length: 9 }, (_, i) => `2026-11-01T${String(10 + i).padStart(2, '0')}:00`);

function randomForecast(next: () => number) {
  const code = CODES[Math.floor(next() * CODES.length)];
  const base = Math.round(next() * 30) - 5;
  const hourly = {
    time: HOURS,
    weather_code: HOURS.map(() => CODES[Math.floor(next() * CODES.length)]),
    temperature_2m: HOURS.map(() => base + Math.round(next() * 12) - 6),
    precipitation_probability: HOURS.map(() => (next() < 0.1 ? null : Math.round(next() * 100))),
  };
  const condition = conditionForCode(code);
  const rows = buildOutlook(hourly, '2026-11-01T10:15');
  return { condition, kinds: outlookEvents({ condition, temp: base, tempUnit: 'C' }, rows) };
}

describe('a changed outlook always has something to say', () => {
  it('holds over many generated forecasts and memories', () => {
    const next = rng(2211);
    for (let i = 0; i < 5_000; i++) {
      const before = randomForecast(next);
      const now = randomForecast(next);
      const last = aired(before.condition, before.kinds.map(n => n.kind));
      const news = weatherNews({ condition: now.condition, kinds: now.kinds.map(n => n.kind) }, last);
      if (!news.outlookChanged) continue;
      // What the tool hands the DJ: the forecast's notes plus any withdrawn one.
      const said = [...now.kinds, ...news.withdrawn];
      assert.ok(said.length > 0, `forecast ${i}: outlook changed with nothing to say (${JSON.stringify({ before, now })})`);
      assert.ok(said.some(n => n.kind !== 'cooler' && n.kind !== 'warmer'), `forecast ${i}: only a temperature note behind a change`);
    }
  });
});
