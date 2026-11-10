// The schedule drawer's lookups (#1848, the app's port of web #1621). They
// read only what /schedule already publishes.

import assert from 'node:assert/strict';
import test from 'node:test';
import { onNowShow, personaBlurbs, personaById } from '../src/lib/schedule.ts';
import type { SchedulePersona, ScheduleShow } from '../src/lib/types.ts';

const show = (id: string, name: string, topic = ''): ScheduleShow => ({
  id, name, topic, mood: 'calm', personaId: 'p_a',
});
const deepNight = show('s_deep', 'Deep Night', 'Ambient textures for the sleepless.');
const rush = show('s_rush', 'Workout Rush', 'High-tempo gym fuel.');
const shows = [deepNight, rush];

test('a persona says only what the station published', () => {
  const base: SchedulePersona = { id: 'p_a', name: 'Indigo', avatar: '/persona-avatar/p_a' };
  assert.deepEqual(personaBlurbs({ ...base, tagline: 'Late-night company.' }), ['Late-night company.']);
  assert.deepEqual(
    personaBlurbs({ ...base, tagline: ' Late-night company. ', soul: 'You are Indigo.\nSpeak softly.' }),
    ['Late-night company.', 'You are Indigo.\nSpeak softly.'],
  );
  assert.deepEqual(personaBlurbs({ ...base, tagline: '' }), [], 'an empty tagline is not a blurb');
  assert.deepEqual(personaBlurbs({ ...base, tagline: '   ', soul: '' }), []);
  assert.deepEqual(personaBlurbs(base), [], 'an older controller omits tagline');
  assert.deepEqual(personaBlurbs(null), []);
});

test('the on-air show is the grid slot when the names agree', () => {
  assert.equal(onNowShow({ name: 'Deep Night' }, deepNight, shows), deepNight);
});

test('a takeover off the grid is found in the roster by name', () => {
  assert.equal(onNowShow({ name: 'Workout Rush' }, deepNight, shows), rush);
  assert.equal(onNowShow({ name: 'Workout Rush' }, null, shows), rush);
});

test('no live show, or one the roster does not know, has no entry', () => {
  assert.equal(onNowShow(null, deepNight, shows), null);
  assert.equal(onNowShow({}, deepNight, shows), null);
  assert.equal(onNowShow({ name: 'Pop-up Special' }, deepNight, shows), null);
  assert.equal(onNowShow({ name: 'Deep Night' }, null, undefined), null);
});

test('the host is found by id', () => {
  const personas: SchedulePersona[] = [
    { id: 'p_a', name: 'Indigo', avatar: '' },
    { id: 'p_b', name: 'Rex', avatar: '' },
  ];
  assert.equal(personaById(personas, 'p_b')?.name, 'Rex');
  assert.equal(personaById(personas, 'p_missing'), null);
  assert.equal(personaById(personas, undefined), null);
  assert.equal(personaById(undefined, 'p_a'), null);
});
