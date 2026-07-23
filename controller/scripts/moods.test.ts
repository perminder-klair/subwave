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
  validateMoodsStrict,
  validateMoodScheduleStrict,
  validateWeatherMoodsStrict,
  assertNoOrphanMoods,
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

// ── validateMoodsStrict ──────────────────────────────────────────────────────

// Valid list round-trips, normalising the id (lowercase, spaces/punct → dashes)
// and keeping the CLAP prompt.
assert.deepEqual(
  validateMoodsStrict([{ name: 'Chill Vibes!', clapPrompt: 'soft downtempo' }]),
  [{ name: 'chill-vibes', clapPrompt: 'soft downtempo' }],
  'name normalises to a kebab id; prompt preserved',
);
// A missing/blank prompt is allowed (falls back to `${name} music` at read time).
assert.deepEqual(
  validateMoodsStrict([{ name: 'mellow' }]),
  [{ name: 'mellow', clapPrompt: '' }],
  'clapPrompt is optional',
);
// Unknown keys are stripped (rebuilt objects).
assert.deepEqual(
  validateMoodsStrict([{ name: 'x', clapPrompt: 'y', bogus: 1 }]),
  [{ name: 'x', clapPrompt: 'y' }],
  'unknown keys stripped',
);
assert.throws(() => validateMoodsStrict([]), /at least one/, 'empty vocabulary rejected');
assert.throws(() => validateMoodsStrict('nope' as any), /must be an array/, 'non-array rejected');
assert.throws(
  () => validateMoodsStrict([{ name: 'a' }, { name: 'A' }]),
  /duplicate/,
  'duplicate names (after normalise) rejected',
);
assert.throws(
  () => validateMoodsStrict([{ name: '' }]),
  /must be 1-/,
  'empty name rejected',
);
assert.throws(
  () => validateMoodsStrict(Array.from({ length: 41 }, (_, i) => ({ name: `m${i}` }))),
  /at most/,
  'over the 40-entry cap rejected',
);

// ── validateMoodScheduleStrict ───────────────────────────────────────────────

const NAMES = ['energetic', 'calm', 'focus', 'evening', 'night', 'morning', 'driving', 'reflective'];
const fullSchedule = Object.fromEntries(MOOD_PERIODS.map((p) => [p, PERIOD_MOOD_DEFAULTS[p]]));
assert.deepEqual(
  validateMoodScheduleStrict(fullSchedule, NAMES),
  fullSchedule,
  'a complete schedule of known moods round-trips',
);
assert.throws(
  () => validateMoodScheduleStrict({ ...fullSchedule, 'drive-time': 'banana' }, NAMES),
  /moodSchedule\.drive-time/,
  'a slot pointing at an unknown mood is rejected, naming the slot',
);
assert.throws(
  () => validateMoodScheduleStrict([] as any, NAMES),
  /must be an object/,
  'non-object schedule rejected',
);

// ── validateWeatherMoodsStrict ───────────────────────────────────────────────

// '' (no steer) is allowed; missing conditions default to '' — so a partial map fills out.
const weatherOut = validateWeatherMoodsStrict({ clear: 'energetic', rainy: '' }, NAMES);
assert.equal(weatherOut.clear, 'energetic', 'known mood kept');
assert.equal(weatherOut.rainy, '', 'blank = no steer kept');
assert.equal(weatherOut.stormy, '', 'omitted condition defaults to no steer');
assert.equal(Object.keys(weatherOut).length, WEATHER_CONDITIONS.length, 'all conditions present');
assert.throws(
  () => validateWeatherMoodsStrict({ clear: 'banana' }, NAMES),
  /weatherMoods\.clear/,
  'a condition pointing at an unknown mood is rejected',
);

// ── assertNoOrphanMoods (the in-use removal guard) ───────────────────────────

const baseState = () => ({
  moods: [{ name: 'energetic', clapPrompt: '' }, { name: 'calm', clapPrompt: '' }],
  moodSchedule: { 'drive-time': 'energetic', evening: 'calm' },
  weatherMoods: { clear: 'energetic', rainy: '' },
  festivals: [{ name: 'Diwali', mood: 'calm' }],
  shows: [{ name: 'Breakfast', moods: ['energetic'] }],
});

// All references resolve → no throw.
assert.doesNotThrow(() => assertNoOrphanMoods(baseState()), 'consistent state passes');

// Remove 'calm' while a festival still uses it → rejected, naming the festival.
{
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }];
  assert.throws(() => assertNoOrphanMoods(s), /festival "Diwali"/, 'festival ref blocks removal');
}
// Schedule slot still referencing the removed mood → names the slot.
{
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }];
  s.festivals = [];
  assert.throws(() => assertNoOrphanMoods(s), /evening time-of-day slot/, 'schedule ref blocks removal');
}
// Weather slot referencing the removed mood → names the condition.
{
  const s = baseState();
  s.moods = [{ name: 'calm', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'calm', evening: 'calm' };
  s.festivals = [];
  s.shows = [];
  assert.throws(() => assertNoOrphanMoods(s), /clear weather slot/, 'weather ref blocks removal');
}
// Show referencing the removed mood → names the show.
{
  const s = baseState();
  s.moods = [{ name: 'calm', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'calm', evening: 'calm' };
  s.weatherMoods = { clear: 'calm', rainy: '' };
  s.festivals = [];
  assert.throws(() => assertNoOrphanMoods(s), /show "Breakfast"/, 'show ref blocks removal');
}
// A rename done in one shot (add new, repoint every referrer, drop old) passes.
{
  const s = baseState();
  s.moods = [{ name: 'energetic', clapPrompt: '' }, { name: 'serene', clapPrompt: '' }];
  s.moodSchedule = { 'drive-time': 'energetic', evening: 'serene' };
  s.weatherMoods = { clear: 'energetic', rainy: '' };
  s.festivals = [{ name: 'Diwali', mood: 'serene' }];
  s.shows = [{ name: 'Breakfast', moods: ['energetic'] }];
  assert.doesNotThrow(() => assertNoOrphanMoods(s), 'a fully-repointed rename passes');
}

console.log('moods: all assertions passed');
