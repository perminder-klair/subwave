// Pins the split between session-DJ selection and listener-facing speech.
// Run: npm test -- agent-say-boundary

import assert from 'node:assert/strict';
import { PICK_SCHEMA } from '../src/broadcast/dj-agent/schemas.js';

assert.equal('say' in PICK_SCHEMA.shape, false,
  'the selection response must not offer a listener-facing speech field');

const picked = PICK_SCHEMA.parse({
  id: 'selected-track',
  reason: 'fresh artist',
  transition: null,
  say: 'this must be ignored as an unknown field',
});
assert.equal('say' in picked, false,
  'a model cannot smuggle speech through the selection response');

assert.ok('reason' in PICK_SCHEMA.shape,
  'selection keeps its internal rationale field');
assert.ok('transition' in PICK_SCHEMA.shape,
  'selection keeps its transition decision field');

console.log('agent say boundary: all tests passed');
