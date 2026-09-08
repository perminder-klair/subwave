// The 'inherit' persona engine sentinel: what it resolves to, and which voice
// id survives. A voice on an inherit slot was chosen without knowing the
// engine, so it must not ride along to a cloud provider.

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
  // Byte-identical to the old pinned-piper seed.
  assert.equal(out.voice, 'bm_george');
  assert.equal(out.gainDb, 2);
  assert.equal(out.speed, 1.1);
});

test('inherit → kokoro keeps the persona voice: one id-space with piper', () => {
  // piper and kokoro are the only pair sharing an id-space (#454).
  const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine: 'kokoro' });
  assert.equal(out.engine, 'kokoro');
  assert.equal(out.voice, 'bm_george');
});

test('inherit → chatterbox / pocket-tts DROPS the persona voice', () => {
  // These read `voice` as a reference .wav filename and a built-in id, so a
  // carried piper id fails every synth. Empty means "use your own default".
  for (const engine of ['chatterbox', 'pocket-tts']) {
    const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine: engine });
    assert.equal(out.engine, engine, engine);
    assert.equal(out.voice, '', engine);
    // The per-persona dials are not per-engine and survive regardless.
    assert.equal(out.gainDb, 2, engine);
    assert.equal(out.speed, 1.1, engine);
  }
});

test('every engine an inherit slot can resolve to accepts the voice it is handed', () => {
  // The resolver's output is never re-validated, so it must not hand an engine
  // an id that engine's own schema rule refuses.
  for (const defaultEngine of ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'remote']) {
    const out = resolvePersonaVoiceSlot(INHERIT, { defaultEngine });
    const parsed = ttsVoiceSlotSchema('tts').safeParse(out);
    assert.equal(parsed.success, true, `${defaultEngine}: ${parsed.error?.issues[0]?.message}`);
  }
  const cloud = resolvePersonaVoiceSlot(INHERIT, {
    defaultEngine: 'cloud',
    cloud: { provider: 'openai', voice: 'alloy' },
  });
  assert.equal(ttsVoiceSlotSchema('tts').safeParse(cloud).success, true);
});

test('inherit → cloud takes the STATION provider, model voice and drops the persona voice', () => {
  const out = resolvePersonaVoiceSlot(INHERIT, {
    defaultEngine: 'cloud',
    cloud: { provider: 'openai-compatible', voice: 'dj-brain-default' },
  });
  assert.equal(out.engine, 'cloud');
  assert.equal(out.cloudProvider, 'openai-compatible');
  // A Piper voice id must never reach a cloud provider.
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
  // Station default is piper, and the pin still wins.
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

test('the persona slot ACCEPTS inherit; the station fallback slot REFUSES it', () => {
  const raw = { engine: 'inherit', cloudProvider: 'openai', voice: 'bm_george' };
  assert.equal(ttsVoiceSlotSchema('tts', { allowInherit: true }).safeParse(raw).success, true);

  // 'inherit' on tts.fallback would name the rung below it in the rescue
  // chain, and on tts.defaultEngine would inherit from itself.
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
  // A persona written before the sentinel existed must land on the piper
  // floor, not be re-pointed at today's station default.
  assert.equal(repairTtsVoiceSlot({ engine: 'wat' }, { allowInherit: true }).engine, 'piper');
  // A stored 'inherit' survives a load only where it is allowed.
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit' }, { allowInherit: true }).engine, 'inherit');
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit' }).engine, 'piper');
});

test('the lenient path never INVENTS a voice for an inherit slot', () => {
  // The kokoro floor must not catch 'inherit' through its engine-exclusion
  // list and stamp a Kokoro id on every voice-less persona. Empty stays empty.
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit', voice: '' }, { allowInherit: true }).voice, '');
  assert.equal(repairTtsVoiceSlot({ engine: 'inherit' }, { allowInherit: true }).voice, '');
  // A real voice round-trips; keeping or dropping it is the resolver's call.
  assert.equal(
    repairTtsVoiceSlot({ engine: 'inherit', voice: 'bm_george' }, { allowInherit: true }).voice,
    'bm_george',
  );
  // The floor still applies to the engines it was written for.
  assert.equal(repairTtsVoiceSlot({ engine: 'kokoro', voice: '' }).voice, 'bf_isabella');
});

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

test('a cloud pin to ANOTHER provider is still listed, and names the provider', () => {
  // The four cloud providers share one dispatcher but are independent targets,
  // so comparing on engine alone reports a mismatched provider as compliant.
  const personas = [
    { id: 'a', name: 'Marlowe', tts: { engine: 'cloud', cloudProvider: 'openai-compatible' } },
    { id: 'b', name: 'Wren', tts: { engine: 'cloud', cloudProvider: 'openai' } },
    { id: 'c', name: 'Hale', tts: { engine: 'inherit' } },
  ];
  const out = personasPinningOtherEngine(personas, 'cloud', 'openai-compatible');
  assert.deepEqual(out.map((p) => p.name), ['Wren']);
  assert.deepEqual(out.map((p) => p.engine), ['cloud / openai']);

  // Without a provider the comparison stays engine-only.
  assert.deepEqual(personasPinningOtherEngine(personas, 'cloud'), []);
});

test('personasPinningOtherEngine tolerates junk rather than throwing', () => {
  assert.deepEqual(personasPinningOtherEngine(null, 'cloud'), []);
  assert.deepEqual(personasPinningOtherEngine(undefined, 'cloud'), []);
  assert.deepEqual(personasPinningOtherEngine([{ id: 'x' }, { id: 'y', tts: null }], 'cloud'), []);
});
