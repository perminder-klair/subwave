// DJ Doc's co-host rescue-voice finding (#2029). A host whose engine fails
// mid-render is rescued in the station fallback voice unless the persona has a
// rescue voice of its own; on a co-hosted show that one voice can make one
// host sound like the other. The check is static. A host counts as covered
// only by a rescue voice the chain would actually reach: not one on the same
// target as the host's own voice (sameTtsTarget drops it), and not one that
// can't speak (the chain's probe skips it). Two hosts on one show with the
// same rescue target and voice warn too, since that is the original bug again,
// as does a rescue voice that is a co-host's own voice.
// Run: npm test -- doctor-cohost-rescue

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTempDir } from './test-utils/temp-dir.js';

process.env.STATE_DIR = createTempDir(join(tmpdir(), 'subwave-doctor-cohost-'));
const { checkTts, coHostRescueFinding } = await import('../src/doctor/checks-services.js');

const remote = { engine: 'remote', voice: 'emma-v2' };
const tom = { id: 'p_tom', name: 'Tom', tts: remote, fallbackVoice: null };
const emma = { id: 'p_emma', name: 'Emma', tts: remote, fallbackVoice: null };
const kai = { id: 'p_kai', name: 'Kai', tts: remote, fallbackVoice: { engine: 'kokoro', cloudProvider: 'openai', voice: 'am_adam' } };
const KORE = { engine: 'gemini', cloudProvider: 'openai', voice: 'Kore' };
const CHARON = { engine: 'gemini', cloudProvider: 'openai', voice: 'Charon' };
const show = (guests: string[], name = 'The Late Shift') => ({ name, personaId: 'p_emma', guestPersonaIds: guests });

test('a co-hosted show with hosts lacking a rescue voice warns and names them', () => {
  const f = coHostRescueFinding({ personas: [tom, emma, kai], shows: [show(['p_tom', 'p_kai'])] });
  assert.equal(f?.label, 'co-host rescue voices');
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, 'The Late Shift: Emma (no rescue voice); The Late Shift: Tom (no rescue voice)');
  assert.match(f?.hint || '', /Personas → Voice/);
});

test('every host with a distinct, usable rescue voice of their own is ok', () => {
  const f = coHostRescueFinding({
    personas: [{ ...tom, fallbackVoice: CHARON }, { ...emma, fallbackVoice: KORE }],
    shows: [show(['p_tom'])],
  });
  assert.equal(f?.status, 'ok');
  assert.equal(f?.hint, undefined);
});

test('two hosts sharing one rescue target and voice warn, the default Piper voice included', () => {
  const sameGemini = coHostRescueFinding({
    personas: [{ ...tom, fallbackVoice: KORE }, { ...emma, fallbackVoice: KORE }],
    shows: [show(['p_tom'])],
  });
  assert.equal(sameGemini?.status, 'warn');
  assert.equal(sameGemini?.detail, 'The Late Shift: Emma, Tom share one rescue voice (gemini Kore)');
  // What switching the rescue voice On starts from, twice: one built-in voice.
  const piper = { engine: 'piper', cloudProvider: 'openai', voice: '' };
  const samePiper = coHostRescueFinding({
    personas: [{ ...tom, fallbackVoice: piper }, { ...emma, fallbackVoice: { ...piper, voice: '  ' } }],
    shows: [show(['p_tom'])],
  });
  assert.equal(samePiper?.status, 'warn');
  assert.equal(samePiper?.detail, 'The Late Shift: Emma, Tom share one rescue voice (piper)');
  // The provider is unused off cloud, so it never makes two rescues differ.
  const providerOnly = coHostRescueFinding({
    personas: [{ ...tom, fallbackVoice: piper }, { ...emma, fallbackVoice: { ...piper, cloudProvider: 'elevenlabs' } }],
    shows: [show(['p_tom'])],
  });
  assert.equal(providerOnly?.status, 'warn');
  // Same cloud voice name on two providers is two voices.
  const twoProviders = coHostRescueFinding({
    personas: [
      { ...tom, fallbackVoice: { engine: 'cloud', cloudProvider: 'openai', voice: 'nova' } },
      { ...emma, fallbackVoice: { engine: 'cloud', cloudProvider: 'fish-audio', voice: 'nova' } },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(twoProviders?.status, 'ok');
});

test('a rescue voice on the same target as the host\'s own voice does not count', () => {
  const f = coHostRescueFinding({
    personas: [
      { ...tom, fallbackVoice: { engine: 'remote', cloudProvider: 'openai', voice: 'tom-backup' } },
      { ...emma, fallbackVoice: KORE },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, 'The Late Shift: Tom (rescue on their own engine, remote)');
  // An `inherit` voice is the station default engine, so a rescue on it is too.
  const inherit = coHostRescueFinding({
    tts: { defaultEngine: 'kokoro' },
    personas: [
      { ...tom, tts: { engine: 'inherit', voice: '' }, fallbackVoice: { engine: 'kokoro', cloudProvider: 'openai', voice: 'am_adam' } },
      { ...emma, fallbackVoice: KORE },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(inherit?.detail, 'The Late Shift: Tom (rescue on their own engine, kokoro)');
  // Cloud is engine + provider: another provider is another failure domain.
  const cloudVoice = { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Rachel' };
  const otherProvider = coHostRescueFinding({
    personas: [
      { ...tom, tts: cloudVoice, fallbackVoice: { engine: 'cloud', cloudProvider: 'openai', voice: 'nova' } },
      { ...emma, fallbackVoice: KORE },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(otherProvider?.status, 'ok');
  const sameProvider = coHostRescueFinding({
    personas: [
      { ...tom, tts: cloudVoice, fallbackVoice: { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Adam' } },
      { ...emma, fallbackVoice: KORE },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(sameProvider?.status, 'warn');
});

test("a rescue voice that is a co-host's own voice warns: the #2029 symptom again", () => {
  const bella = { engine: 'kokoro', cloudProvider: 'openai', voice: 'af_bella' };
  const f = coHostRescueFinding({
    personas: [
      { ...tom, tts: { engine: 'kokoro', voice: 'af_bella' }, fallbackVoice: CHARON },
      { ...emma, fallbackVoice: bella },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, "The Late Shift: Emma (rescue voice is Tom's own voice)");
  // The co-host's `inherit` voice is resolved first: the station's Kokoro voice.
  const inherit = coHostRescueFinding({
    tts: { defaultEngine: 'kokoro' },
    personas: [
      { ...tom, tts: { engine: 'inherit', voice: 'af_bella' }, fallbackVoice: CHARON },
      { ...emma, fallbackVoice: bella },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(inherit?.detail, "The Late Shift: Emma (rescue voice is Tom's own voice)");
  // Same engine, another voice: a distinct voice.
  const other = coHostRescueFinding({
    personas: [
      { ...tom, tts: { engine: 'kokoro', voice: 'am_adam' }, fallbackVoice: CHARON },
      { ...emma, fallbackVoice: bella },
    ],
    shows: [show(['p_tom'])],
  });
  assert.equal(other?.status, 'ok');
});

test('a rescue voice that cannot speak does not count, probed with its own provider', () => {
  const probed: Array<[string, string | null]> = [];
  const noElevenLabsKey = (engine: string, provider: string | null) => {
    probed.push([engine, provider]);
    return !(engine === 'cloud' && provider === 'elevenlabs');
  };
  const f = coHostRescueFinding({
    personas: [
      { ...tom, fallbackVoice: { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Adam' } },
      { ...emma, fallbackVoice: KORE },
    ],
    shows: [show(['p_tom'])],
  }, noElevenLabsKey);
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, "The Late Shift: Tom (rescue cloud/elevenlabs can't speak)");
  assert.deepEqual(probed, [['gemini', null], ['cloud', 'elevenlabs']]); // the show's host first
});

test('solo shows, deleted guests and a station with no shows add no finding', () => {
  assert.equal(coHostRescueFinding({ personas: [tom, emma], shows: [{ name: 'Solo', personaId: 'p_tom', guestPersonaIds: [] }] }), null);
  assert.equal(coHostRescueFinding({ personas: [tom], shows: [{ name: 'Gone', personaId: 'p_tom', guestPersonaIds: ['p_deleted'] }] }), null);
  assert.equal(coHostRescueFinding({ personas: [tom, emma] }), null);
  assert.equal(coHostRescueFinding(null), null);
});

test('checkTts carries the finding into the Voice (TTS) section, probing with the chain\'s own check', async () => {
  const findings = await checkTts({
    tts: { defaultEngine: 'piper' },
    personas: [tom, emma],
    shows: [{ name: 'Drive', personaId: 'p_tom', guestPersonaIds: ['p_emma'] }],
  });
  const f = findings.find((x) => x.label === 'co-host rescue voices');
  assert.equal(f?.status, 'warn');
  assert.equal(f?.detail, 'Drive: Tom (no rescue voice); Drive: Emma (no rescue voice)');
  // No ElevenLabs key in the test env: tts.engineUsable says the cloud rescue
  // can't speak, and the Doctor agrees with it.
  const unkeyed = await checkTts({
    tts: { defaultEngine: 'piper' },
    personas: [
      { ...tom, fallbackVoice: { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Adam' } },
      { ...emma, fallbackVoice: { engine: 'piper', cloudProvider: 'openai', voice: '' } },
    ],
    shows: [{ name: 'Drive', personaId: 'p_tom', guestPersonaIds: ['p_emma'] }],
  });
  assert.equal(unkeyed.find((x) => x.label === 'co-host rescue voices')?.detail, "Drive: Tom (rescue cloud/elevenlabs can't speak)");
});
