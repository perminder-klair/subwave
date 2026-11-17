// Pins the WMO-code mapping (condition + describe), the outlook builder's
// window/rounding, and every branch of the plain-English notes the DJ reads.
// Run: npm test -- weather-codes

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  conditionForCode,
  describeCode,
  buildOutlook,
  outlookEvents,
  outlookNotes,
  withdrawnNote,
  isWeatherCondition,
  OUTLOOK_HOURS,
  WEATHER_CONDITIONS,
  type HourlyForecast,
  type OutlookHour,
} from '../src/weather-codes.js';

describe('the outlook window and the six conditions', () => {
  it('buildOutlook defaults to OUTLOOK_HOURS, the one six-hour window', () => {
    assert.equal(OUTLOOK_HOURS, 6);
    const hourly: HourlyForecast = {
      time: Array.from({ length: 12 }, (_, i) => `2026-11-01T${String(10 + i).padStart(2, '0')}:00`),
      weather_code: Array(12).fill(3),
    };
    assert.equal(Math.max(...buildOutlook(hourly, '2026-11-01T10:00').map(r => r.inHours)), OUTLOOK_HOURS);
  });

  it('isWeatherCondition accepts the six conditions and nothing else', () => {
    for (const c of WEATHER_CONDITIONS) assert.equal(isWeatherCondition(c), true, c);
    for (const v of ['unknown', 'windy', '', null, undefined, 3]) assert.equal(isWeatherCondition(v), false, String(v));
  });
});

describe('withdrawnNote', () => {
  it('names what is no longer coming, over the one outlook window', () => {
    assert.deepEqual(withdrawnNote('rain'), { kind: 'rain-withdrawn', text: 'rain no longer expected in the next 6 hours' });
    assert.deepEqual(withdrawnNote('snow'), { kind: 'snow-withdrawn', text: 'snow no longer expected in the next 6 hours' });
    assert.deepEqual(withdrawnNote('storm'), { kind: 'storm-withdrawn', text: 'thunderstorms no longer expected in the next 6 hours' });
  });
});

describe('conditionForCode', () => {
  it('maps known WMO codes', () => {
    assert.equal(conditionForCode(0), 'clear');
    assert.equal(conditionForCode(1), 'clear');
    assert.equal(conditionForCode(2), 'cloudy');
    assert.equal(conditionForCode(3), 'cloudy');
    assert.equal(conditionForCode(45), 'foggy');
    assert.equal(conditionForCode(53), 'rainy');
    assert.equal(conditionForCode(61), 'rainy');
    assert.equal(conditionForCode(80), 'rainy');
    assert.equal(conditionForCode(82), 'rainy');
    assert.equal(conditionForCode(73), 'snowy');
    assert.equal(conditionForCode(86), 'snowy');
    assert.equal(conditionForCode(95), 'stormy');
    assert.equal(conditionForCode(99), 'stormy');
  });

  it('returns cloudy for unknown or invalid input', () => {
    assert.equal(conditionForCode(4), 'cloudy');
    assert.equal(conditionForCode(undefined), 'cloudy');
    assert.equal(conditionForCode('3'), 'cloudy');
    assert.equal(conditionForCode(1.5), 'cloudy');
  });
});

describe('describeCode', () => {
  it('returns the WMO description', () => {
    assert.equal(describeCode(1), 'mainly clear');
    assert.equal(describeCode(2), 'partly cloudy');
    assert.equal(describeCode(80), 'light rain showers');
    assert.equal(describeCode(96), 'thunderstorm with hail');
  });

  it('returns null for unknown codes and non-integers', () => {
    assert.equal(describeCode(4), null);
    assert.equal(describeCode(null), null);
  });
});

describe('buildOutlook', () => {
  const hourly: HourlyForecast = {
    time: [
      '2026-10-31T00:00', '2026-10-31T01:00', '2026-10-31T02:00',
      '2026-10-31T03:00', '2026-10-31T04:00', '2026-10-31T05:00',
      '2026-10-31T06:00', '2026-10-31T07:00',
    ],
    temperature_2m: [17.2, 16.6, 16.1, 15.4, 14.9, 14.2, 13.8, 13.5],
    weather_code: [1, 2, 3, 80, 61, 3, 2, 1],
    precipitation_probability: [0, 5, 20, 70, 85, 40, 10, 0],
  };

  it('returns 6 rows after currentTime with correct rounding', () => {
    const rows = buildOutlook(hourly, '2026-10-31T00:15');
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[0], {
      inHours: 1, condition: 'cloudy', conditions: 'partly cloudy',
      temp: 17, rainChancePct: 5,
    });
    assert.deepEqual(rows[1], {
      inHours: 2, condition: 'cloudy', conditions: 'overcast',
      temp: 16, rainChancePct: 20,
    });
    assert.deepEqual(rows[2], {
      inHours: 3, condition: 'rainy', conditions: 'light rain showers',
      temp: 15, rainChancePct: 70,
    });
    assert.deepEqual(rows[3], {
      inHours: 4, condition: 'rainy', conditions: 'light rain',
      temp: 15, rainChancePct: 85,
    });
    assert.deepEqual(rows[4], {
      inHours: 5, condition: 'cloudy', conditions: 'overcast',
      temp: 14, rainChancePct: 40,
    });
    assert.deepEqual(rows[5], {
      inHours: 6, condition: 'cloudy', conditions: 'partly cloudy',
      temp: 14, rainChancePct: 10,
    });
  });

  it('respects the hours parameter', () => {
    const rows = buildOutlook(hourly, '2026-10-31T00:15', 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].inHours, 1);
    assert.equal(rows[1].inHours, 2);
  });

  // current.time moves in 15-minute steps: at :45 the first row is 15 minutes
  // out. Six rows by count covered only ~5¼ hours; by distance it is 0..6.
  it('covers six hours from a reading at :45, the first row within the hour', () => {
    const rows = buildOutlook(hourly, '2026-10-30T23:45');
    assert.deepEqual(rows.map(r => r.inHours), [0, 1, 2, 3, 4, 5, 6]);
  });

  it('ages a cached forecast: rows move closer and passed ones drop out', () => {
    const fresh = buildOutlook(hourly, '2026-10-31T00:15');
    const aged = buildOutlook(hourly, '2026-10-31T00:15', 6, 50 * 60_000);
    assert.equal(fresh[0].conditions, 'partly cloudy');
    assert.deepEqual(fresh.map(r => r.inHours), [1, 2, 3, 4, 5, 6]);
    // 01:05 now: 01:00 has passed, 02:00 is an hour away.
    assert.equal(aged[0].conditions, 'overcast');
    assert.deepEqual(aged.map(r => r.inHours), [1, 2, 3, 4, 5, 6]);
  });

  it('returns [] for null hourly', () => {
    assert.deepEqual(buildOutlook(null, '2026-10-31T00:15'), []);
  });

  it('returns [] for unparseable currentTime', () => {
    assert.deepEqual(buildOutlook(hourly, 'garbage'), []);
  });

  it('gives rainChancePct null when precipitation_probability is absent', () => {
    const noRain: HourlyForecast = {
      time: ['2026-10-31T01:00', '2026-10-31T02:00'],
      temperature_2m: [20, 19],
      weather_code: [0, 1],
    };
    const rows = buildOutlook(noRain, '2026-10-31T00:00');
    assert.equal(rows[0].rainChancePct, null);
    assert.equal(rows[1].rainChancePct, null);
  });
});

describe('outlookNotes', () => {
  const hourly: HourlyForecast = {
    time: [
      '2026-10-31T00:00', '2026-10-31T01:00', '2026-10-31T02:00',
      '2026-10-31T03:00', '2026-10-31T04:00', '2026-10-31T05:00',
      '2026-10-31T06:00', '2026-10-31T07:00',
    ],
    temperature_2m: [17.2, 16.6, 16.1, 15.4, 14.9, 14.2, 13.8, 13.5],
    weather_code: [1, 2, 3, 80, 61, 3, 2, 1],
    precipitation_probability: [0, 5, 20, 70, 85, 40, 10, 0],
  };

  it('produces rain and temperature notes', () => {
    const rows = buildOutlook(hourly, '2026-10-31T00:15');
    const notes = outlookNotes({ condition: 'clear', temp: 17 }, rows);
    assert.deepEqual(notes, [
      'rain likely in about 3 hours (70% chance)',
      'down to 14 degrees Celsius in about 6 hours',
    ]);
  });

  // Today's Open-Meteo reply for London at review time: overcast now, light
  // drizzle in the last rows at a 5-8% chance. "rain likely (5% chance)"
  // contradicted itself on air.
  it('calls a wet row with a low chance possible, in its own wording, with no percentage', () => {
    const london: HourlyForecast = {
      time: ['2026-11-05T10:00', '2026-11-05T11:00', '2026-11-05T12:00', '2026-11-05T13:00',
        '2026-11-05T14:00', '2026-11-05T15:00', '2026-11-05T16:00', '2026-11-05T17:00'],
      temperature_2m: [11, 11, 11, 11, 11, 11, 11, 11],
      weather_code: [3, 3, 3, 3, 3, 3, 51, 51],
      precipitation_probability: [0, 0, 0, 0, 1, 2, 5, 8],
    };
    const rows = buildOutlook(london, '2026-11-05T10:45');
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 11 }, rows), [
      'light drizzle possible in about 5 hours',
    ]);
    assert.deepEqual(outlookEvents({ condition: 'cloudy', temp: 11 }, rows).map(e => e.kind), ['rain-possible']);
  });

  it('says likely, with the chance, only at 50% or more', () => {
    const at = (pct: number | null): OutlookHour[] => [
      { inHours: 2, condition: 'rainy', conditions: 'light rain', temp: 12, rainChancePct: pct },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 12 }, at(49)), ['light rain possible in about 2 hours']);
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 12 }, at(null)), ['light rain possible in about 2 hours']);
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 12 }, at(50)), ['rain likely in about 2 hours (50% chance)']);
  });

  // A low-chance drizzle row first must not hide a likely downpour behind it:
  // the note names the first likely row, and falls back to the first wet one.
  it('names the first likely row before the first merely wet one', () => {
    const rows: OutlookHour[] = [
      { inHours: 1, condition: 'rainy', conditions: 'light drizzle', temp: 12, rainChancePct: 10 },
      { inHours: 2, condition: 'cloudy', conditions: 'overcast', temp: 12, rainChancePct: 30 },
      { inHours: 3, condition: 'rainy', conditions: 'heavy rain', temp: 12, rainChancePct: 90 },
    ];
    assert.deepEqual(outlookEvents({ condition: 'cloudy', temp: 12 }, rows), [
      { kind: 'rain-likely', text: 'rain likely in about 3 hours (90% chance)' },
    ]);
    // A likely thunderstorm behind a possible shower is the thunderstorm.
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 20 }, [
      { inHours: 1, condition: 'rainy', conditions: 'light rain showers', temp: 20, rainChancePct: 20 },
      { inHours: 4, condition: 'stormy', conditions: 'thunderstorm', temp: 20, rainChancePct: 70 },
    ]), ['thunderstorms likely in about 4 hours (70% chance)']);
    // Nothing likely anywhere: the first wet row, as a possibility.
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 12 }, [
      { inHours: 1, condition: 'cloudy', conditions: 'overcast', temp: 12, rainChancePct: 40 },
      { inHours: 2, condition: 'rainy', conditions: 'light drizzle', temp: 12, rainChancePct: 10 },
      { inHours: 5, condition: 'rainy', conditions: 'rain', temp: 12, rainChancePct: 45 },
    ]), ['light drizzle possible in about 2 hours']);
  });

  it('names a likely snow row snow, and is silent about snow while it snows', () => {
    const rows: OutlookHour[] = [
      { inHours: 2, condition: 'snowy', conditions: 'light snow', temp: -1, rainChancePct: 80 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: -1 }, rows), ['snow likely in about 2 hours (80% chance)']);
    assert.deepEqual(outlookNotes({ condition: 'snowy', temp: -1 }, rows), []);
  });

  it('says likely thunderstorms only with a high chance', () => {
    const rows: OutlookHour[] = [
      { inHours: 4, condition: 'stormy', conditions: 'thunderstorm', temp: 22, rainChancePct: 75 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 22 }, rows), [
      'thunderstorms likely in about 4 hours (75% chance)',
    ]);
  });

  it('says within the hour for a row less than half an hour away', () => {
    const rows: OutlookHour[] = [
      { inHours: 0, condition: 'rainy', conditions: 'rain', temp: 12, rainChancePct: 90 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 12 }, rows), ['rain likely within the hour (90% chance)']);
  });

  it('names the unit, and needs a 5-degree swing in Fahrenheit', () => {
    const rows = (t: number): OutlookHour[] => [
      { inHours: 6, condition: 'clear', conditions: 'clear sky', temp: t, rainChancePct: 0 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 60, tempUnit: 'F' }, rows(56)), []);
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 60, tempUnit: 'F' }, rows(55)), [
      'down to 55 degrees Fahrenheit in about 6 hours',
    ]);
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 10, tempUnit: 'C' }, rows(13)), [
      'up to 13 degrees Celsius in about 6 hours',
    ]);
  });

  it('detects drying out', () => {
    const rows: OutlookHour[] = [
      { inHours: 1, condition: 'rainy', conditions: 'rain', temp: 15, rainChancePct: 80 },
      { inHours: 2, condition: 'cloudy', conditions: 'overcast', temp: 15, rainChancePct: 20 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'rainy', temp: 15 }, rows), [
      'drying out in about 2 hours',
    ]);
  });

  it('uses thunderstorms wording for stormy with no chance suffix', () => {
    const rows: OutlookHour[] = [
      { inHours: 1, condition: 'stormy', conditions: 'thunderstorm', temp: 20, rainChancePct: null },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 20 }, rows), [
      'thunderstorms possible in about 1 hour',
    ]);
  });

  it('detects clearing', () => {
    const rows: OutlookHour[] = [
      { inHours: 1, condition: 'cloudy', conditions: 'overcast', temp: 18, rainChancePct: 0 },
      { inHours: 2, condition: 'clear', conditions: 'mainly clear', temp: 17, rainChancePct: 0 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 18 }, rows), [
      'clearing in about 2 hours',
    ]);
  });

  it('detects clouding over', () => {
    const rows: OutlookHour[] = [
      { inHours: 3, condition: 'cloudy', conditions: 'partly cloudy', temp: 19, rainChancePct: 10 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 18 }, rows), [
      'clouding over in about 3 hours',
    ]);
  });

  it('returns [] when nothing applies', () => {
    const rows: OutlookHour[] = [
      { inHours: 1, condition: 'cloudy', conditions: 'overcast', temp: 18, rainChancePct: 10 },
    ];
    assert.deepEqual(outlookNotes({ condition: 'cloudy', temp: 18 }, rows), []);
  });

  it('returns [] for empty outlook', () => {
    assert.deepEqual(outlookNotes({ condition: 'clear', temp: 20 }, []), []);
  });
});

describe('outlookEvents: rows the code calls dry, and snow', () => {
  const row = (r: Partial<OutlookHour>): OutlookHour =>
    ({ inHours: 1, condition: 'cloudy', conditions: 'overcast', temp: 8, rainChancePct: 0, ...r });

  it('never calls a row rain when its code is dry: it keeps its own wording', () => {
    // The review's probe: clear sky at 60% used to read "rain likely in about 1 hour (60% chance)".
    const clear = outlookEvents({ condition: 'cloudy', temp: 5 },
      [row({ condition: 'clear', conditions: 'clear sky', temp: 5, rainChancePct: 60 })]);
    assert.deepEqual(clear, [{ kind: 'precip-likely', text: 'clear sky in about 1 hour, with a 60% chance of precipitation' }]);
    const overcast = outlookEvents({ condition: 'clear', temp: 8 }, [row({ rainChancePct: 55 })]);
    assert.deepEqual(overcast, [{ kind: 'precip-likely', text: 'overcast in about 1 hour, with a 55% chance of precipitation' }]);
    for (const note of [...clear, ...overcast]) assert.doesNotMatch(note.text, /rain/);
  });

  it('calls that precipitation snow at or below freezing, in the reading\'s unit', () => {
    // The review's second probe: -2 °C used to read "rain likely … (70% chance)".
    const at = (temp: number, tempUnit?: string) =>
      outlookEvents({ condition: 'cloudy', temp, tempUnit }, [row({ temp, rainChancePct: 70 })]).map(n => n.text);
    assert.deepEqual(at(-2), ['overcast in about 1 hour, with a 70% chance of snow']);
    assert.deepEqual(at(0), ['overcast in about 1 hour, with a 70% chance of snow']);
    assert.deepEqual(at(1), ['overcast in about 1 hour, with a 70% chance of precipitation']);
    assert.deepEqual(at(32, 'F'), ['overcast in about 1 hour, with a 70% chance of snow']);
    assert.deepEqual(at(33, 'F'), ['overcast in about 1 hour, with a 70% chance of precipitation']);
    assert.equal(outlookEvents({ condition: 'cloudy', temp: -2 }, [row({ temp: -2, rainChancePct: 70 })])[0].kind, 'snow-likely');
  });

  it('gives a snow row with a low or unknown chance a "possible" note, as drizzle gets one', () => {
    assert.deepEqual(
      outlookEvents({ condition: 'cloudy', temp: 0 }, [row({ condition: 'snowy', conditions: 'snow', temp: 0, rainChancePct: 30 })]),
      [{ kind: 'snow-possible', text: 'snow possible in about 1 hour' }],
    );
    assert.deepEqual(
      outlookEvents({ condition: 'cloudy', temp: 0 }, [row({ condition: 'snowy', conditions: 'light snow', temp: 0, rainChancePct: null })]),
      [{ kind: 'snow-possible', text: 'light snow possible in about 1 hour' }],
    );
  });

  it('says rain turning to snow, never "drying out"', () => {
    // The review's probe: rain now, light snow next with no chance data read "drying out in about 1 hour".
    const snowNext = [1, 2, 3].map(h => row({ inHours: h, condition: 'snowy', conditions: 'light snow', temp: 1, rainChancePct: null }));
    const notes = outlookEvents({ condition: 'rainy', temp: 1 }, snowNext);
    assert.deepEqual(notes, [{ kind: 'turning-snow', text: 'possibly turning to snow in about 1 hour' }]);
    assert.ok(notes.every(n => !/drying/.test(n.text)));
    assert.deepEqual(
      outlookNotes({ condition: 'rainy', temp: 1 }, [row({ condition: 'snowy', conditions: 'snow', temp: 0, rainChancePct: 80 })]),
      ['turning to snow in about 1 hour (80% chance)'],
    );
  });

  it('while it snows: rain on the way is a turn, a dry spell is the snow stopping', () => {
    assert.deepEqual(
      outlookEvents({ condition: 'snowy', temp: 1 }, [row({ condition: 'rainy', conditions: 'light rain', temp: 2, rainChancePct: 65 })]),
      [{ kind: 'turning-rain', text: 'turning to rain in about 1 hour (65% chance)' }],
    );
    assert.deepEqual(
      outlookEvents({ condition: 'snowy', temp: -1 }, [
        row({ inHours: 1, condition: 'snowy', conditions: 'snow', temp: -1, rainChancePct: 90 }),
        row({ inHours: 2, condition: 'cloudy', conditions: 'overcast', temp: -1, rainChancePct: 10 }),
      ]),
      [{ kind: 'drying', text: 'the snow stopping in about 2 hours' }],
    );
  });

  it('keeps rain and thunderstorms one kind of wet: no turn between them', () => {
    assert.deepEqual(
      outlookNotes({ condition: 'stormy', temp: 20 }, [
        row({ inHours: 1, condition: 'rainy', conditions: 'rain', temp: 20, rainChancePct: 80 }),
        row({ inHours: 2, condition: 'cloudy', conditions: 'overcast', temp: 20, rainChancePct: 10 }),
      ]),
      ['drying out in about 2 hours'],
    );
  });
});
