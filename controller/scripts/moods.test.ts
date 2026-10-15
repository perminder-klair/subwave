// Unit tests for the live mood accessors (settings.ts): moodVocab / moodEntries
// / moodPromptFor / moodScheduleFor / weatherMoodFor — the single seam every
// mood consumer reads through. These must answer from the SEED defaults before
// settings.load() (get() returns DEFAULTS), which is what keeps the standalone
// audio-moods + tagger paths working without a loaded settings.json.
// Run: `tsx scripts/moods.test.ts`.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  moodVocab,
  moodEntries,
  moodPromptFor,
  moodScheduleFor,
  weatherMoodFor,
  assertNoOrphanMoods,
  MOOD_DEFAULTS,
  PERIOD_MOOD_DEFAULTS,
  WEATHER_MOOD_DEFAULTS,
  MOOD_PERIODS,
  WEATHER_CONDITIONS,
} from '../src/settings.js';

// ── vocabulary ───────────────────────────────────────────────────────────────

test('seed vocabulary is available before settings.load', () => {
  // Pre-load, the vocabulary IS the seed defaults (get() → DEFAULTS).
  assert.deepEqual(
    moodVocab(),
    MOOD_DEFAULTS.map((m) => m.name),
    'moodVocab() returns the seed mood names before load()',
  );
  assert.equal(moodEntries().length, MOOD_DEFAULTS.length, 'moodEntries() returns every seed mood');
  assert.ok(moodVocab().includes('energetic'), 'a known default mood is present');
});

// ── per-mood CLAP prompt ─────────────────────────────────────────────────────

test('seed CLAP prompts and unknown-mood fallback', () => {
  // Every seed mood resolves to its curated description; an unknown mood falls
  // back to the bare "<name> music" form.
  for (const m of MOOD_DEFAULTS) {
    const expected = m.clapPrompt || `${m.name} music`;
    assert.equal(moodPromptFor(m.name), expected, `curated prompt for "${m.name}"`);
  }
  assert.equal(moodPromptFor('zydeco'), 'zydeco music', 'unknown mood → bare-word fallback');
});

// ── time-of-day → mood ───────────────────────────────────────────────────────

test('every daypart resolves to a seed mood', () => {
  // Every fixed period resolves to its seed mood, and each is a real vocabulary entry.
  for (const period of MOOD_PERIODS) {
    assert.equal(moodScheduleFor(period), PERIOD_MOOD_DEFAULTS[period], `schedule seed for ${period}`);
    assert.ok(moodVocab().includes(moodScheduleFor(period)), `${period} maps to a real mood`);
  }
});

// ── weather → mood ───────────────────────────────────────────────────────────

test('weather seeds keep cloudy unsteered', () => {
  // Every condition resolves to its seed; '' (cloudy) stays "no steer", and any
  // non-empty value is a real vocabulary entry.
  for (const cond of WEATHER_CONDITIONS) {
    assert.equal(weatherMoodFor(cond), WEATHER_MOOD_DEFAULTS[cond], `weather seed for ${cond}`);
    const v = weatherMoodFor(cond);
    if (v) assert.ok(moodVocab().includes(v), `${cond} maps to a real mood`);
  }
  assert.equal(weatherMoodFor('cloudy'), '', 'cloudy has no mood steer by default');
});

// ── assertNoOrphanMoods (the in-use removal guard) ───────────────────────────

const baseState = () => ({
  moods: [{ name: 'energetic', clapPrompt: '' }, { name: 'calm', clapPrompt: '' }],
  moodSchedule: { 'drive-time': 'energetic', evening: 'calm' },
  weatherMoods: { clear: 'energetic', rainy: '' },
  festivals: [{ name: 'Diwali', mood: 'calm' }],
  shows: [{ name: 'Breakfast', moods: ['energetic'] }],
});

// All references resolve → no throw.
test('consistent mood references pass the removal guard', () => {
  assert.doesNotThrow(() => assertNoOrphanMoods(baseState()));
});

// Remove 'calm' while a festival still uses it → rejected, naming the festival.
test('a festival reference blocks mood removal', () => {
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }];
  assert.throws(() => assertNoOrphanMoods(s), /festival "Diwali"/, 'festival ref blocks removal');
});
// Schedule slot still referencing the removed mood → names the slot.
test('a daypart reference blocks mood removal', () => {
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }];
  s.festivals = [];
  assert.throws(() => assertNoOrphanMoods(s), /evening time-of-day slot/, 'schedule ref blocks removal');
});
// Weather slot referencing the removed mood → names the condition.
test('a weather reference blocks mood removal', () => {
  const s = baseState();
  s.moods = [{ name: 'calm', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'calm', evening: 'calm' };
  s.festivals = [];
  s.shows = [];
  assert.throws(() => assertNoOrphanMoods(s), /clear weather slot/, 'weather ref blocks removal');
});
// Show referencing the removed mood → names the show.
test('a show reference blocks mood removal', () => {
  const s = baseState();
  s.moods = [{ name: 'calm', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'calm', evening: 'calm' };
  s.weatherMoods = { clear: 'calm', rainy: '' };
  s.festivals = [];
  assert.throws(() => assertNoOrphanMoods(s), /show "Breakfast"/, 'show ref blocks removal');
});
// A rename done in one shot (add new, repoint every referrer, drop old) passes.
test('a fully repointed mood rename passes', () => {
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }, { name: 'serene', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'energetic', evening: 'serene' };
  s.weatherMoods = { clear: 'energetic', rainy: '' };
  s.festivals = [{ name: 'Diwali', mood: 'serene' }];
  s.shows = [{ name: 'Breakfast', moods: ['energetic'] }];
  assert.doesNotThrow(() => assertNoOrphanMoods(s), 'a fully-repointed rename passes');
});
