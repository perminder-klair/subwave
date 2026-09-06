// The 'inherit' sentinel at the seams that read a persona's engine but do NOT
// go through djPersonaTts().
//
// resolvePersonaVoiceSlot() is pinned as a pure function in
// persona-engine.test.ts. What that cannot catch is a CALL SITE that forgot to
// resolve: every such site asks `engine === '<something>'`, and a raw sentinel
// answers "no" to all of them, so the miss is silent and reads as "this persona
// is pinned elsewhere". Three sites outside the dispatcher have to resolve:
//
//   - llm/internal/prompts/system.ts  djSystem()'s chatterbox tag hint
//   - llm/internal/speech/cloud-speech.ts  the three *ForPersona entry points
//   - audio/tts.ts  describeRouting(), which reproduces the dispatcher's own
//     per-engine comparisons for /debug and the nightly doctor
//
// All are exercised here against real settings rather than a stub, because the
// bug is precisely that the raw slot and the resolved one differ only once the
// STATION is configured a particular way.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import so
// settings.load()/update() touch nothing real — hence the dynamic imports.

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

// The tag block djSystem appends only for chatterbox. Matched on a fragment so a
// reword of the hint doesn't fail this test for the wrong reason.
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
  // Every other engine speaks "[laugh]" aloud as the word, which is why the
  // hint is gated at all.
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

  // Keyed off engine === 'cloud': a raw inherit slot reads as "pinned
  // elsewhere" and reports nothing, which silently drops the expression-cue
  // hints on a station whose default IS cloud.
  assert.equal(resolveCloudProviderForPersona(INHERIT_PERSONA), 'openai-compatible');
  assert.equal(resolveCloudModelForPersona(INHERIT_PERSONA), 'dj-brain-voice');
});

test('an inherit persona reports NO cloud voice when the station is local', async () => {
  await settings.update({ tts: { defaultEngine: 'piper' } });
  assert.equal(resolveCloudProviderForPersona(INHERIT_PERSONA), '');
  assert.equal(resolveCloudModelForPersona(INHERIT_PERSONA), '');
});

// ---- describeRouting: the operator-facing snapshot ---------------------------

test('describeRouting reports the RESOLVED engine and voice, and no phantom fallback', async () => {
  // piper is the universal floor and always usable, so an inherit persona
  // resolving to it falls back from nothing. Against the raw slot this reported
  // requested 'inherit' → engine 'piper' and called it a fallback, which is a
  // standing warn in /debug and in the doctor's "active routing" check for the
  // shipped default roster — noise in the one place a real silent fallback
  // would show.
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
  // The persona's own voice, not the engine's global default: piper is one of
  // the two engines an inherited voice id carries to.
  assert.equal(spoken.voice, 'bm_george');
});

test('describeRouting on an inherit persona matches the equivalent PINNED one', async () => {
  // The two configurations are the same station, described two ways. Any
  // difference in this snapshot is a reporting bug by construction.
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
