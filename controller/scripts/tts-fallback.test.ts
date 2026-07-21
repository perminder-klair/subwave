// Unit tests for the TTS runtime rescue ordering (audio/tts-fallback.ts):
// orderedFallbacks builds speak()'s mid-render fallback chain — configured
// default engine first, then Piper, then Kokoro — dropping the failed primary,
// duplicates, and anything the availability gate rejects.
// Run: `tsx scripts/tts-fallback.test.ts`.
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import { orderedFallbacks } from '../src/audio/tts-fallback.js';

const allUsable = () => true;

// No configured default: Piper floor, then Kokoro.
assert.deepEqual(
  orderedFallbacks('cloud', undefined, allUsable),
  ['piper', 'kokoro'],
  'no default → piper then kokoro',
);

// Configured default leads the chain.
assert.deepEqual(
  orderedFallbacks('cloud', 'kokoro', allUsable),
  ['kokoro', 'piper'],
  'default engine comes first, then deduped against the piper/kokoro tail',
);

// The failed primary never re-appears — even when it IS the default.
assert.deepEqual(
  orderedFallbacks('kokoro', 'kokoro', allUsable),
  ['piper'],
  'default === primary → dropped',
);

// Piper as primary: the chain still ends in a local engine (Kokoro).
assert.deepEqual(
  orderedFallbacks('piper', undefined, allUsable),
  ['kokoro'],
  'piper primary → kokoro backstop',
);
assert.deepEqual(
  orderedFallbacks('piper', 'chatterbox', allUsable),
  ['chatterbox', 'kokoro'],
  'piper primary with a default → default then kokoro, no piper',
);

// A default of piper dedupes against the floor slot instead of doubling.
assert.deepEqual(
  orderedFallbacks('cloud', 'piper', allUsable),
  ['piper', 'kokoro'],
  'default piper appears once',
);

// The usable gate filters: an unavailable default is skipped, not attempted.
assert.deepEqual(
  orderedFallbacks('cloud', 'remote', (e) => e !== 'remote'),
  ['piper', 'kokoro'],
  'unusable default filtered',
);

// Unknown engine ids in settings are rejected by the gate (in prod,
// engineUsable() returns false for anything outside ENGINES).
assert.deepEqual(
  orderedFallbacks('cloud', 'bogus', (e) => e !== 'bogus'),
  ['piper', 'kokoro'],
  'invalid default filtered by the gate',
);

// Kokoro missing (model files absent) with Piper as primary: empty chain —
// speak() records the failure and rethrows.
assert.deepEqual(
  orderedFallbacks('piper', undefined, (e) => e !== 'kokoro'),
  [],
  'no usable rescue → empty chain',
);

// Nothing usable at all: empty chain regardless of configuration.
assert.deepEqual(
  orderedFallbacks('cloud', 'kokoro', () => false),
  [],
  'gate rejects everything → empty chain',
);

console.log('tts-fallback.test.ts: all assertions passed');
