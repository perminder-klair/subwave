// Pins the WMO-code mapping (condition + describe), the outlook builder's
// window/rounding, and every branch of the plain-English notes the DJ reads.
// Run: npm test -- weather-codes

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  conditionForCode,
  describeCode,
  buildOutlook,
  outlookNotes,
  type HourlyForecast,
  type OutlookHour,
} from '../src/weather-codes.js';

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
      'down to 14 degrees in about 6 hours',
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
