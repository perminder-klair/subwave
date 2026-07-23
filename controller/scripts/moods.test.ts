// Unit tests for the live mood accessors (settings.ts): moodVocab / moodEntries
// / moodPromptFor / moodScheduleFor / weatherMoodFor — the single seam every
// mood consumer reads through. These must answer from the SEED defaults before
// settings.load() (get() returns DEFAULTS), which is what keeps the standalone
// audio-moods + tagger paths working without a loaded settings.json.
// Run: `tsx scripts/moods.test.ts`.

import assert from 'node:assert/strict';
import {
  moodVocab,
  moodEntries,
  moodPromptFor,
  moodScheduleFor,
  weatherMoodFor,
  MOOD_DEFAULTS,
  PERIOD_MOOD_DEFAULTS,
  WEATHER_MOOD_DEFAULTS,
  MOOD_PERIODS,
  WEATHER_CONDITIONS,
} from '../src/settings.js';

// ── vocabulary ───────────────────────────────────────────────────────────────

// Pre-load, the vocabulary IS the seed defaults (get() → DEFAULTS).
assert.deepEqual(
  moodVocab(),
  MOOD_DEFAULTS.map((m) => m.name),
  'moodVocab() returns the seed mood names before load()',
);
assert.equal(moodEntries().length, MOOD_DEFAULTS.length, 'moodEntries() returns every seed mood');
assert.ok(moodVocab().includes('energetic'), 'a known default mood is present');

// ── per-mood CLAP prompt ─────────────────────────────────────────────────────

// Every seed mood resolves to its curated description; an unknown mood falls
// back to the bare "<name> music" form.
for (const m of MOOD_DEFAULTS) {
  const expected = m.clapPrompt || `${m.name} music`;
  assert.equal(moodPromptFor(m.name), expected, `curated prompt for "${m.name}"`);
}
assert.equal(moodPromptFor('zydeco'), 'zydeco music', 'unknown mood → bare-word fallback');

// ── time-of-day → mood ───────────────────────────────────────────────────────

// Every fixed period resolves to its seed mood, and each is a real vocabulary entry.
for (const period of MOOD_PERIODS) {
  assert.equal(moodScheduleFor(period), PERIOD_MOOD_DEFAULTS[period], `schedule seed for ${period}`);
  assert.ok(moodVocab().includes(moodScheduleFor(period)), `${period} maps to a real mood`);
}

// ── weather → mood ───────────────────────────────────────────────────────────

// Every condition resolves to its seed; '' (cloudy) stays "no steer", and any
// non-empty value is a real vocabulary entry.
for (const cond of WEATHER_CONDITIONS) {
  assert.equal(weatherMoodFor(cond), WEATHER_MOOD_DEFAULTS[cond], `weather seed for ${cond}`);
  const v = weatherMoodFor(cond);
  if (v) assert.ok(moodVocab().includes(v), `${cond} maps to a real mood`);
}
assert.equal(weatherMoodFor('cloudy'), '', 'cloudy has no mood steer by default');

console.log('moods: all assertions passed');
