// Contract tests for the post-selection PersonaLink fact packet.
// Run: npm test -- verified-facts

import assert from 'node:assert/strict';
import { sleeveNotesFor, contextSleeveNotesFor, stationHistoryNoteFor } from '../src/llm/internal/prompts/sleeve-notes.js';
import { linkPrompt } from '../src/llm/internal/prompts/scripts.js';

const track = (over: Record<string, unknown> = {}) => ({
  title: 'After Laughter (Comes Tears)', artist: 'Wendy Rene',
  album: 'After Laughter Comes Tears', year: 2012, originalYear: 1964,
  yearUntrusted: false, ...over,
});

assert.deepEqual(sleeveNotesFor(track(), 3), [
  'Album: After Laughter Comes Tears.', 'Release year: 1964.', 'Station plays before today: 3.',
]);
assert.deepEqual(contextSleeveNotesFor(track(), {
  date: { season: 'summer' }, weather: { condition: 'cloudy', location: 'The Ribble Valley' },
}), ['Album: After Laughter Comes Tears.', 'Release year: 1964.', 'Season: summer.', 'Weather in The Ribble Valley: cloudy.']);

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
assert.match(prompt, /Approximate air time: around half past 8pm/);
assert.match(prompt, /Current show: "Night Drive"/);
assert.match(prompt, /Track on air:\n- After Laughter \(Comes Tears\) by Wendy Rene/);
assert.doesNotMatch(prompt, /sustained energy|euphoric/);
console.log('verified facts: all tests passed');
