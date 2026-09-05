// Deterministic schedule facts for final-quarter-hour links and station IDs.
// Run: npm test -- show-handover-facts

import assert from 'node:assert/strict';
import { showHandoverContext } from '../src/context.js';
import { linkPrompt, stationIdPrompt } from '../src/llm/internal/prompts/scripts.js';

const now = new Date('2026-09-05T10:45:00.000Z');
const boundary = new Date('2026-09-05T11:00:00.000Z');
const resolveShow = (at: Date) => at.getTime() < boundary.getTime()
  ? { id: 'current', name: 'The Scenic Route', persona: { name: 'Chris' } }
  : { id: 'next', name: 'Lunchtime Rocks', persona: { name: 'Carrie' } };

const handover = showHandoverContext(now, resolveShow);
assert.deepEqual(handover, {
  phase: 'final-quarter-hour',
  nextShow: { name: 'Lunchtime Rocks', presenter: 'Carrie', startsAt: 'eleven in the morning' },
});
assert.equal(showHandoverContext(new Date('2026-09-05T10:44:59.000Z'), resolveShow), null);

const context = {
  activeShow: { name: 'The Scenic Route' },
  showHandover: handover,
};
const link = linkPrompt({ current: { title: 'Headlong', artist: 'Queen' }, context });
assert.match(link, /Show progress: final 15 minutes/);
assert.match(link, /Following show: "Lunchtime Rocks" with Carrie/);

const stationId = stationIdPrompt({ context, persona: { name: 'Chris', scriptLength: 'concise' } });
assert.match(stationId, /The next scheduled show is "Lunchtime Rocks" with Carrie/);
assert.match(stationId, /one brief nod/);
assert.doesNotMatch(
  stationIdPrompt({ context: { activeShow: { name: 'The Scenic Route' } }, persona: { name: 'Chris' } }),
  /The next scheduled show is/,
);

console.log('show handover facts: all tests passed');
