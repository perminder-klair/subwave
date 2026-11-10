// DJ Doc's face on the doctor page and on the top-bar badge is decided by these
// rules; the sprite only draws what they pick.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countsOverall, doctorPageMood, stationBuddy, type DoctorPageState, type StationSignals } from './doctor-mood';
import type { DoctorReport, DoctorReview, DoctorSummary } from './doctor-queries';

const counts = (fail = 0, warn = 0): DoctorReport['counts'] => ({ ok: 10, warn, fail, skip: 0 });
const report = (fail = 0, warn = 0): DoctorReport => ({ t: '2026-10-21T12:00:00.000Z', sections: [], counts: counts(fail, warn) });
const review = (overall: DoctorReview['overall']): DoctorReview => ({ available: true, overall, summary: 'ok' });

const page = (over: Partial<DoctorPageState> = {}): DoctorPageState => ({
  running: false,
  reviewing: false,
  fixing: false,
  failed: false,
  report: null,
  review: null,
  ...over,
});

test('countsOverall matches the controller: any fail is critical, any warn is attention', () => {
  assert.equal(countsOverall(counts(1, 3)), 'critical');
  assert.equal(countsOverall(counts(0, 2)), 'attention');
  assert.equal(countsOverall(counts()), 'healthy');
});

test('the doctor page is curious before any check, and at work while one runs', () => {
  assert.equal(doctorPageMood(page()), 'curious');
  assert.equal(doctorPageMood(page({ running: true, report: report(2) })), 'listening');
  assert.equal(doctorPageMood(page({ reviewing: true, report: report() })), 'thinking');
  assert.equal(doctorPageMood(page({ fixing: true, report: report(1) })), 'thinking');
});

test('a run in flight outranks a failed one, and a failure outranks the old verdict', () => {
  assert.equal(doctorPageMood(page({ running: true, failed: true })), 'listening');
  assert.equal(doctorPageMood(page({ failed: true, report: report(), review: review('healthy') })), 'dizzy');
});

test('the review verdict decides, and the counts stand in when no review is available', () => {
  assert.equal(doctorPageMood(page({ report: report(1), review: review('healthy') })), 'happy');
  assert.equal(doctorPageMood(page({ report: report(), review: review('attention') })), 'worried');
  assert.equal(doctorPageMood(page({ report: report(), review: review('critical') })), 'spooked');
  assert.equal(doctorPageMood(page({ report: report(2) })), 'spooked');
  assert.equal(doctorPageMood(page({ report: report(0, 1) })), 'worried');
  assert.equal(doctorPageMood(page({ report: report() })), 'happy');
  // The LLM being offline doesn't hide what the report found.
  const offline: DoctorReview = { available: false, reason: 'LLM offline' };
  assert.equal(doctorPageMood(page({ report: report(1), review: offline })), 'spooked');
});

const summary = (overall: DoctorSummary['overall'], c = counts()): DoctorSummary => ({ t: '2026-10-21T12:00:00.000Z', counts: c, overall });
const live = (over: Partial<StationSignals> = {}): StationSignals => ({
  musicStarved: false,
  navidromeOk: true,
  streamOnline: true,
  talking: false,
  summary: null,
  ...over,
});

test('the badge puts live trouble first: starved, then Navidrome, then off air', () => {
  const all = live({ musicStarved: true, navidromeOk: false, streamOnline: false, talking: true, summary: summary('healthy') });
  assert.deepEqual(stationBuddy(all), { mood: 'spooked', note: 'no music to play' });
  assert.equal(stationBuddy({ ...all, musicStarved: false }).mood, 'dizzy');
  assert.deepEqual(stationBuddy({ ...all, musicStarved: false, navidromeOk: true }), { mood: 'sleepy', note: 'off air' });
});

test('an unknown stream state is not off air', () => {
  assert.equal(stationBuddy(live({ streamOnline: null })).mood, 'curious');
});

test('a critical last check outranks the DJ talking; a softer verdict does not', () => {
  const critical = summary('critical', counts(2));
  assert.deepEqual(stationBuddy(live({ talking: true, summary: critical })), { mood: 'spooked', note: 'last check: 2 fail' });
  assert.equal(stationBuddy(live({ talking: true, summary: summary('attention', counts(0, 1)) })).mood, 'onair');
  assert.equal(stationBuddy(live({ talking: true })).mood, 'onair');
});

test('the badge rests on a healthy check and asks for one when none has run', () => {
  assert.deepEqual(stationBuddy(live({ summary: summary('attention', counts(0, 3)) })), { mood: 'worried', note: 'last check: 3 warn' });
  assert.deepEqual(stationBuddy(live({ summary: summary('healthy') })), { mood: 'content', note: 'last check: all clear' });
  assert.deepEqual(stationBuddy(live()), { mood: 'curious', note: 'no check run yet' });
  assert.deepEqual(stationBuddy(live({ summary: { t: null, counts: null, overall: null } })), { mood: 'curious', note: 'no check run yet' });
});
