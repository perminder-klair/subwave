// Contract tests for the post-selection PersonaLink fact packet.
// Run: npm test -- verified-facts

import assert from 'node:assert/strict';
import {
  sleeveNotesFor, contextSleeveNotesFor, releaseYearMentionEligible, selectSleeveNotes, stationHistoryNoteFor,
} from '../src/llm/internal/prompts/sleeve-notes.js';
import { linkPrompt } from '../src/llm/internal/prompts/scripts.js';

const track = (over: Record<string, unknown> = {}) => ({
  title: 'After Laughter (Comes Tears)', artist: 'Wendy Rene',
  album: 'After Laughter Comes Tears', year: 2012, originalYear: 1964,
  yearUntrusted: false, ...over,
});

assert.deepEqual(sleeveNotesFor(track(), 3), [
  'Album: After Laughter Comes Tears.', 'Release year: 1964.', 'Lifetime station plays: 3.',
]);
assert.deepEqual(contextSleeveNotesFor(track(), {
  date: { season: 'summer' }, weather: { condition: 'cloudy', location: 'The Ribble Valley' },
}), ['Album: After Laughter Comes Tears.', 'Release year: 1964.']);
assert.deepEqual(contextSleeveNotesFor(track({ album: '', year: null, originalYear: null }), {
  activeShow: { topic: 'songs for the long way home', episodeAngle: 'late-night departures' },
  festival: { name: 'Solstice' },
}, null, 'First station play.'), ['First station play.'],
'sparse metadata must not let show or festival steering leak into Sleeve Notes');
assert.deepEqual(selectSleeveNotes(sleeveNotesFor(track(), 3)), [
  'Album: After Laughter Comes Tears.', 'Release year: 1964.',
]);
assert.deepEqual(selectSleeveNotes(sleeveNotesFor(track(), 3), Math.random, false), [
  'Album: After Laughter Comes Tears.', 'Lifetime station plays: 3.',
]);

const yearGateContext = { date: { iso: '2026-09-08' }, clock: { hhmm: '11:30' } };
assert.equal(releaseYearMentionEligible(track(), yearGateContext, 'regular'), true);
assert.equal(
  releaseYearMentionEligible(track({ id: 'stable-gate' }), yearGateContext, 'occasional'),
  releaseYearMentionEligible(track({ id: 'stable-gate' }), yearGateContext, 'occasional'),
);
for (const frequency of ['occasional', 'rare'] as const) {
  const results = Array.from({ length: 48 }, (_, i) => releaseYearMentionEligible(
    track({ id: `gate-${i}` }), yearGateContext, frequency,
  ));
  assert.ok(results.some(Boolean), `${frequency} should leave some links eligible`);
  assert.ok(results.some((eligible) => !eligible), `${frequency} should withhold some links`);
}

const airingIndex = {
  byId: new Map([
    ['other-track', Date.now()],
    ['rare-track', Date.now() - 91 * 86_400_000],
    ['recent-track', Date.now() - 29 * 86_400_000],
  ]),
  byKey: new Map(),
};
assert.equal(stationHistoryNoteFor({ id: 'first-track' }, null, airingIndex), 'First station play.');
assert.equal(
  stationHistoryNoteFor({ id: 'rare-track' }, { count: 1, lastPlayedAtMs: Date.now() - 91 * 86_400_000 }, airingIndex),
  'Played here only once before; last heard 91 days ago.',
);
assert.equal(
  stationHistoryNoteFor({ id: 'recent-track' }, { count: 1, lastPlayedAtMs: Date.now() - 29 * 86_400_000 }, airingIndex),
  null,
);

const prompt = linkPrompt({
  current: track(), clockIsAirTime: true,
  context: {
    date: { dayLabel: 'Friday', season: 'summer' },
    clock: { display: '8:30 pm', hhmm: '20:30' },
    time: { vibe: 'sustained energy' },
    activeShow: { name: 'Night Drive', moods: ['euphoric'] },
  },
});
assert.match(prompt, /Task: Give a brief spoken introduction to the track now playing/);
assert.match(prompt, /Music facts are limited to the exact entries in Verified facts/);
assert.match(prompt, /day of week is for accuracy, not generic atmosphere/);
assert.match(prompt, /First station play” is not a premiere or a world premiere/);
assert.match(prompt, /Prefer a plain, accurate introduction to invented atmosphere/);
assert.match(prompt, /must never be a closing or end-of-segment tag/);
assert.match(prompt, /Approximate air time: around half past 8pm/);
assert.match(prompt, /Current show: "Night Drive"/);
assert.match(prompt, /Track on air:\n- After Laughter \(Comes Tears\) by Wendy Rene/);
assert.doesNotMatch(prompt, /sustained energy|euphoric/);
console.log('verified facts: all tests passed');
