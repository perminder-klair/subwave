// The 'inherit' sentinel at the three seams that read a persona's engine
// without going through djPersonaTts(): djSystem()'s chatterbox tag hint, the
// *ForPersona entry points in cloud-speech.ts, and tts.describeRouting().
// Each asks `engine === '<something>'`, and a raw sentinel answers no to all
// of them, so a missed resolve reads as "pinned elsewhere".
//
// Driven against real settings, since the raw and resolved slots differ only
// once the STATION is configured a particular way. STATE_DIR is redirected
// before the first import, hence the dynamic imports.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'subwave-persona-seams-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { djSystem } = await import('../src/llm/internal/prompts/system.js');
const tts = await import('../src/audio/tts.js');
const { resolveCloudProviderForPersona, resolveCloudModelForPersona } = await import(
  '../src/llm/internal/speech/cloud-speech.js'
);

const INHERIT_PERSONA = {
  id: 'p_seam',
  name: 'Seam',
  soul: 'A test persona.',
  tts: { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 },
};

// Matched on a fragment so a reword of the hint doesn't fail this test.
const CHATTERBOX_MARKER = '[laugh]';

test.after(() => rmSync(root, { recursive: true, force: true }));

test('djSystem gives an inherit persona the chatterbox hint when the STATION is on chatterbox', async () => {
  await settings.update({ tts: { defaultEngine: 'chatterbox' } });
  const prompt = djSystem(INHERIT_PERSONA);
  assert.ok(
    prompt.includes(CHATTERBOX_MARKER),
    'a persona following a chatterbox station is voiced by chatterbox, so it must be told about the tags',
  );
});

test('djSystem withholds the chatterbox hint when the station is on something else', async () => {
  // Every other engine speaks "[laugh]" aloud as the word.
  await settings.update({ tts: { defaultEngine: 'piper' } });
  assert.ok(!djSystem(INHERIT_PERSONA).includes(CHATTERBOX_MARKER));

  await settings.update({ tts: { defaultEngine: 'kokoro' } });
  assert.ok(!djSystem(INHERIT_PERSONA).includes(CHATTERBOX_MARKER));
});

test('a PINNED chatterbox persona still gets the hint whatever the station is', async () => {
  await settings.update({ tts: { defaultEngine: 'piper' } });
  const pinned = { ...INHERIT_PERSONA, tts: { ...INHERIT_PERSONA.tts, engine: 'chatterbox', voice: '' } };
  assert.ok(djSystem(pinned).includes(CHATTERBOX_MARKER));
});

test('the cloud *ForPersona entry points resolve inherit against the station', async () => {
  await settings.update({
    tts: {
      defaultEngine: 'cloud',
      cloud: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: 'https://brain.example/v1',
        model: 'dj-brain-voice',
        voice: 'alloy',
        compatApiKey: 'test-token',
      },
    },
  });

  // Keyed off engine === 'cloud', so a raw inherit slot drops the
  // expression-cue hints on a station whose default IS cloud.
  assert.equal(resolveCloudProviderForPersona(INHERIT_PERSONA), 'openai-compatible');
  assert.equal(resolveCloudModelForPersona(INHERIT_PERSONA), 'dj-brain-voice');
});

test('an inherit persona reports NO cloud voice when the station is local', async () => {
  await settings.update({ tts: { defaultEngine: 'piper' } });
  assert.equal(resolveCloudProviderForPersona(INHERIT_PERSONA), '');
  assert.equal(resolveCloudModelForPersona(INHERIT_PERSONA), '');
});


test('describeRouting reports the RESOLVED engine and voice, and no phantom fallback', async () => {
  // piper is always usable, so an inherit persona resolving to it falls back
  // from nothing. Against the raw slot this read as a standing fallback warn
  // in /debug and the doctor for the shipped default roster.
  await settings.update({
    tts: { defaultEngine: 'piper' },
    personas: settings.get().personas.map((p: any, i: number) =>
      i === 0
        ? { ...p, tts: { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 } }
        : p,
    ),
    activePersonaId: settings.get().personas[0].id,
  });

  const { spoken } = tts.describeRouting();
  assert.equal(spoken.requested, 'piper', 'the sentinel is not an engine an operator can act on');
  assert.equal(spoken.engine, 'piper');
  assert.equal(spoken.fellBack, false, 'nothing fell back — piper is what the station asked for');
  // piper is one of the two engines an inherited voice id carries to.
  assert.equal(spoken.voice, 'bm_george');
});

test('describeRouting on an inherit persona matches the equivalent PINNED one', async () => {
  // The same station described two ways: any difference is a reporting bug.
  const base = settings.get().personas;
  const withEngine = (engine: string) =>
    base.map((p: any, i: number) =>
      i === 0
        ? { ...p, tts: { engine, cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 } }
        : p,
    );

  await settings.update({ tts: { defaultEngine: 'piper' }, personas: withEngine('inherit') });
  const inherited = tts.describeRouting().spoken;

  await settings.update({ tts: { defaultEngine: 'piper' }, personas: withEngine('piper') });
  const pinned = tts.describeRouting().spoken;

  assert.deepEqual(inherited, pinned);
});
