// Pins the split between session-DJ selection and listener-facing speech.
// Run: npm test -- agent-say-boundary

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PICK_SCHEMA, pickSystem } from '../src/broadcast/dj-agent/schemas.js';

assert.equal('say' in PICK_SCHEMA.shape, false,
  'the selection response must not offer a listener-facing speech field');

const picked = PICK_SCHEMA.parse({
  id: 'selected-track',
  reason: 'fresh artist',
  usedMusicalLeanings: false,
  leaningsTieBreak: null,
  transition: null,
  say: 'this must be ignored as an unknown field',
});
assert.equal('say' in picked, false,
  'a model cannot smuggle speech through the selection response');

assert.ok('reason' in PICK_SCHEMA.shape,
  'selection keeps its internal rationale field');
assert.ok('transition' in PICK_SCHEMA.shape,
  'selection keeps its transition decision field');

assert.doesNotMatch(pickSystem(), /the "say" link/,
  'the selection prompt must not instruct the removed listener-facing field');

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(resolve(here, '../src/broadcast/dj-agent.ts'), 'utf8');
const agentStart = agentSource.indexOf('async function pickViaSelectionRoute');
const agentEnd = agentSource.indexOf('\nasync function ', agentStart + 1);
const pickViaSelectionRouteSource = agentSource.slice(agentStart, agentEnd < 0 ? undefined : agentEnd);
const timingAt = pickViaSelectionRouteSource.indexOf('const linkAirAt = clockAllowed ? linkClockAt(showAt, Date.now()) : null;');
const writerAt = pickViaSelectionRouteSource.indexOf('const generated = await generatePickLink');
const finalGuardAt = pickViaSelectionRouteSource.indexOf('const albumHours =');
assert.ok(timingAt > finalGuardAt && timingAt < writerAt,
  'the writer clock must be recomputed after selection guards and immediately before link generation');
assert.doesNotMatch(
  pickViaSelectionRouteSource.slice(0, pickViaSelectionRouteSource.indexOf('{\n', pickViaSelectionRouteSource.indexOf('async function'))),
  /linkAirAt/,
  'pickViaSelectionRoute must not accept a cycle-level clock estimate',
);

console.log('agent say boundary: all tests passed');
