// The 'inherit' persona engine sentinel: what it resolves to, and — the half
// that matters — which voice id survives the resolution.
//
// The bug this exists to stop: every seeded persona used to pin engine 'piper',
// a pinned engine beats settings.tts.defaultEngine, and the persona schema
// refuses an empty engine — so tts.defaultEngine was dead for any station with
// personas, and an operator who wired the hosted DJ Brain (which configures
// tts.cloud in one click) still heard Piper with nothing in the logs.
//
// The second half is the one with teeth: a voice on an inherit slot was chosen
// without knowing the engine, so it must NOT ride along to a cloud provider,
// where "bm_george" is either a 400 or a silently substituted voice.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolvePersonaVoiceSlot,
  personasPinningOtherEngine,
} from '../src/audio/persona-engine.js';
import { PERSONA_TTS_INHERIT, ttsVoiceSlotSchema, repairTtsVoiceSlot } from '../src/schemas/persona.js';

const INHERIT = { engine: PERSONA_TTS_INHERIT, cloudProvider: 'openai', voice: 'bm_george', gainDb: 2, speed: 1.1 };

test('inherit → piper keeps the persona voice (the seed roster stays three voices)', () => {
  const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine: 'piper' });
  assert.equal(out.engine, 'piper');
  // Byte-identical to the old pinned-piper seed: this is what keeps a fresh
  // install sounding the same after the seeds moved to 'inherit'.
  assert.equal(out.voice, 'bm_george');
  assert.equal(out.gainDb, 2);
  assert.equal(out.speed, 1.1);
});

test('inherit → the other local engines also keep the persona voice', () => {
  for (const engine of ['kokoro', 'chatterbox', 'pocket-tts']) {
    const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine: engine });
    assert.equal(out.engine, engine, engine);
    assert.equal(out.voice, 'bm_george', engine);
  }
});

test('inherit → cloud takes the STATION provider, model voice and drops the persona voice', () => {
  const out = resolvePersonaVoiceSlot(INHERIT, {
    defaultEngine: 'cloud',
    cloud: { provider: 'openai-compatible', voice: 'dj-brain-default' },
  });
  assert.equal(out.engine, 'cloud');
  assert.equal(out.cloudProvider, 'openai-compatible');
  // The whole point: a Piper voice id must never reach a cloud provider.
  assert.notEqual(out.voice, 'bm_george');
  assert.equal(out.voice, 'dj-brain-default');
});

test('inherit → cloud with no station voice sends NO voice, never the persona one', () => {
  const out = resolvePersonaVoiceSlot(INHERIT, {
    defaultEngine: 'cloud',
    cloud: { provider: 'openai-compatible' },
  });
  assert.equal(out.voice, '', 'empty lets the server pick its own default');
});

test('inherit → remote drops the persona voice too (server-specific id space)', () => {
  const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine: 'remote' });
  assert.equal(out.engine, 'remote');
  assert.equal(out.voice, '');
});

test('a PINNED engine is returned untouched — inherit changes nothing for it', () => {
  const pinned = { engine: 'cloud', cloudProvider: 'elevenlabs', voice: 'Rachel', gainDb: 0, speed: 1 };
  // Station default is piper, and the pin still wins: the pre-existing rule.
  const out = resolvePersonaVoiceSlot(pinned, { defaultEngine: 'piper', cloud: { provider: 'openai' } });
  assert.deepEqual(out, pinned);
});

test('a legacy persona (piper pin, no inherit anywhere) is byte-identical', () => {
  const legacy = { engine: 'piper', cloudProvider: 'openai', voice: 'bf_alice', gainDb: 0, speed: 1 };
  assert.deepEqual(resolvePersonaVoiceSlot(legacy, { defaultEngine: 'cloud', cloud: { provider: 'openai' } }), legacy);
});

test('null in, null out — the global-voice kinds carry no persona', () => {
  assert.equal(resolvePersonaVoiceSlot(null, { defaultEngine: 'cloud' }), null);
  assert.equal(resolvePersonaVoiceSlot(undefined, { defaultEngine: 'cloud' }), undefined);
});

test('an unreadable station default falls to the piper floor, not to nothing', () => {
  for (const station of [null, undefined, {}, { defaultEngine: '' }, { defaultEngine: 42 }]) {
    const out = resolvePersonaVoiceSlot(INHERIT, station as never);
    assert.equal(out.engine, 'piper', JSON.stringify(station));
    assert.equal(out.voice, 'bm_george', JSON.stringify(station));
  }
});

// ---- schema: the sentinel is persona-only ----------------------------------

test('the persona slot ACCEPTS inherit; the station fallback slot REFUSES it', () => {
  const raw = { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george' };
  assert.equal(ttsVoiceSlotSchema('tts', { allowInherit: true }).safeParse(raw).success, true);

  // tts.fallback: 'inherit' would name the rung below it in the rescue chain,
  // and tts.defaultEngine would inherit from itself.
  const strict = ttsVoiceSlotSchema('tts.fallback').safeParse(raw);
  assert.equal(strict.success, false);
  assert.match(strict.error!.issues[0].message, /tts\.fallback\.engine must be one of/);
  assert.doesNotMatch(strict.error!.issues[0].message, /inherit/);
});

test('an inherit slot caps the voice length but applies no per-engine rule', () => {
  const ok = ttsVoiceSlotSchema('tts', { allowInherit: true })
    .safeParse({ engine: 'inherit', cloudProvider: 'openai', voice: 'not-an-onnx-filename' });
  assert.equal(ok.success, true, 'no engine is known yet, so no engine rule can apply');

  const tooLong = ttsVoiceSlotSchema('tts', { allowInherit: true })
    .safeParse({ engine: 'inherit', cloudProvider: 'openai', voice: 'x'.repeat(101) });
  assert.equal(tooLong.success, false);
});

test('the lenient path repairs an unknown engine to piper, NEVER to inherit', () => {
  // A persona written before this value existed must land on the behaviour it
  // had — the piper floor — not be silently re-pointed at whatever the station
  // is set to today.
  assert.equal(repairTtsVoiceSlot({ engine: 'wat' }, { allowInherit: true }).engine, 'piper');
  // And a stored 'inherit' survives a load only where it is allowed.
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit' }, { allowInherit: true }).engine, 'inherit');
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit' }).engine, 'piper');
});

// ---- the admin warning list ------------------------------------------------

test('personasPinningOtherEngine lists only the personas that would not follow', () => {
  const personas = [
    { id: 'a', name: 'Marlowe', tts: { engine: 'inherit' } },
    { id: 'b', name: 'Wren', tts: { engine: 'piper' } },
    { id: 'c', name: 'Hale', tts: { engine: 'cloud' } },
    { id: 'd', name: 'Nix', tts: { engine: 'kokoro' } },
  ];
  const out = personasPinningOtherEngine(personas, 'cloud');
  assert.deepEqual(out.map((p) => p.name), ['Wren', 'Nix']);
  assert.deepEqual(out.map((p) => p.engine), ['piper', 'kokoro']);
});

test('personasPinningOtherEngine tolerates junk rather than throwing', () => {
  assert.deepEqual(personasPinningOtherEngine(null, 'cloud'), []);
  assert.deepEqual(personasPinningOtherEngine(undefined, 'cloud'), []);
  assert.deepEqual(personasPinningOtherEngine([{ id: 'x' }, { id: 'y', tts: null }], 'cloud'), []);
});
