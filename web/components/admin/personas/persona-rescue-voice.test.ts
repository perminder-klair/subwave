// A persona's own rescue voice (#2029) as the admin form reads it. Every load,
// community install and Discard goes through personaFromSettings, so what it
// makes of `fallbackVoice` is what the Rescue voice control shows and what the
// next save sends back. The server's strict schema and lenient load path are
// pinned controller-side by scripts/persona-schema.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personaFromSettings } from './helpers';
import type { Persona } from './types';

const read = (fallbackVoice: unknown) =>
  personaFromSettings({ id: 'p_emma', name: 'Emma', fallbackVoice } as unknown as Partial<Persona>, []).fallbackVoice;

test('a stored rescue voice round-trips into the form unchanged', () => {
  const kore = { engine: 'gemini', cloudProvider: 'openai', voice: 'Kore' };
  assert.deepEqual(read(kore), kore);
  const eleven = { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Rachel' };
  assert.deepEqual(read(eleven), eleven);
});

test('absent, null and malformed values read as no rescue voice', () => {
  assert.equal(personaFromSettings({ id: 'p_emma', name: 'Emma' }, []).fallbackVoice, null);
  assert.equal(personaFromSettings(undefined, []).fallbackVoice, null);
  for (const bogus of [null, 'gemini', 7, true, [], {}, { voice: 'Kore' }, { engine: 5, voice: 'Kore' }]) {
    assert.equal(read(bogus), null, JSON.stringify(bogus));
  }
});

test('a missing provider or voice fills in, and nothing else rides along', () => {
  assert.deepEqual(read({ engine: 'kokoro' }), { engine: 'kokoro', cloudProvider: 'openai', voice: '' });
  assert.deepEqual(
    read({ engine: 'piper', cloudProvider: 3, voice: null, gainDb: 6, speed: 2 }),
    { engine: 'piper', cloudProvider: 'openai', voice: '' },
  );
});
