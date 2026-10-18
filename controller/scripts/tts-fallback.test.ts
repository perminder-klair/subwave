// Unit tests for the TTS runtime rescue ordering (audio/tts-fallback.ts):
// orderedFallbacks builds speak()'s fallback chain — the operator's configured
// fallback (engine AND voice) first, then the configured default engine, then
// Piper, then Kokoro — dropping the failed primary, duplicates, and anything
// the availability gate rejects. configuredSlot decides what counts as a
// configured fallback in the first place.
// Run: `tsx scripts/tts-fallback.test.ts`.
//
// node:assert-via-tsx style, matching scripts/programme.test.ts.

import assert from 'node:assert/strict';
import {
  configuredSlot, fallbackTextFor, orderedFallbacks, sameTtsTarget, type RescueSlot,
} from '../src/audio/tts-fallback.js';

const allUsable = () => true;

// Expressive primaries keep cues for their own render but remove them from the
// rescue text that Piper/Kokoro/Remote would otherwise read literally.
assert.equal(
  fallbackTextFor('cloud', 'fish-s21', '[soft and warm] Back to the music.'),
  'Back to the music.',
  'Fish S2.1 rescue strips natural-language cues',
);
assert.equal(
  fallbackTextFor('cloud', 'elevenlabs-v3', 'And now [whispers] the deep cut.'),
  'And now the deep cut.',
  'ElevenLabs v3 rescue strips audio tags',
);
assert.equal(
  fallbackTextFor('chatterbox', '', '[laugh] That was inevitable.'),
  'That was inevitable.',
  'Chatterbox rescue strips paralinguistic tags',
);
assert.equal(
  fallbackTextFor('cloud', '', 'The [live] version stays labelled.'),
  'The [live] version stays labelled.',
  'non-expressive cloud rescue leaves brackets untouched',
);
assert.equal(
  fallbackTextFor('cloud', 'fish-s21', '[whispers]'),
  '',
  'cue-only fallback never restores a tag for local speech',
);
assert.equal(
  fallbackTextFor('cloud', 'fish-other', 'The [live] version stays labelled.'),
  'The [live] version stays labelled.',
  'non-S2.1 Fish models do not trigger cue stripping',
);
// ---------------------------------------------------------------------------
// Chain ordering. The chain is a list of SLOTS (engine + optional voice
// override), not engine ids: only the operator's configured fallback carries a
// voice. `engines()` keeps the ordering assertions readable; the override
// assertions below check personaTts explicitly.
// ---------------------------------------------------------------------------
const engines = (slots: RescueSlot[]) => slots.map((s) => s.engine);

// ---- Fallback disabled: today's chain, byte-for-byte -----------------------

// No configured default: Piper floor, then Kokoro.
assert.deepEqual(
  engines(orderedFallbacks('cloud', null, undefined, allUsable)),
  ['piper', 'kokoro'],
  'no default → piper then kokoro',
);

// Configured default leads the chain.
assert.deepEqual(
  engines(orderedFallbacks('cloud', null, 'kokoro', allUsable)),
  ['kokoro', 'piper'],
  'default engine comes first, then deduped against the piper/kokoro tail',
);

// The failed primary never re-appears — even when it IS the default.
assert.deepEqual(
  engines(orderedFallbacks('kokoro', null, 'kokoro', allUsable)),
  ['piper'],
  'default === primary → dropped',
);

// Piper as primary: the chain still ends in a local engine (Kokoro).
assert.deepEqual(
  engines(orderedFallbacks('piper', null, undefined, allUsable)),
  ['kokoro'],
  'piper primary → kokoro backstop',
);
assert.deepEqual(
  engines(orderedFallbacks('piper', null, 'chatterbox', allUsable)),
  ['chatterbox', 'kokoro'],
  'piper primary with a default → default then kokoro, no piper',
);

// A default of piper dedupes against the floor slot instead of doubling.
assert.deepEqual(
  engines(orderedFallbacks('cloud', null, 'piper', allUsable)),
  ['piper', 'kokoro'],
  'default piper appears once',
);

// The usable gate filters: an unavailable default is skipped, not attempted.
assert.deepEqual(
  engines(orderedFallbacks('cloud', null, 'remote', (e) => e !== 'remote')),
  ['piper', 'kokoro'],
  'unusable default filtered',
);

// Kokoro missing (model files absent) with Piper as primary: empty chain —
// speak() records the failure and rethrows.
assert.deepEqual(
  engines(orderedFallbacks('piper', null, undefined, (e) => e !== 'kokoro')),
  [],
  'no usable rescue → empty chain',
);

// Nothing usable at all: empty chain regardless of configuration.
assert.deepEqual(
  engines(orderedFallbacks('cloud', null, 'kokoro', () => false)),
  [],
  'gate rejects everything → empty chain',
);

// Every rung of a fallback-disabled chain carries a null override, so a cloud
// rescue speaks with the station default's credentials rather than the
// persona's — the pre-fallback invariant.
assert.ok(
  orderedFallbacks('chatterbox', null, 'cloud', allUsable).every((s) => s.personaTts === null),
  'hardcoded rungs carry no voice override',
);

// ---- configuredSlot(): what counts as a configured fallback ----------------

const ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'];
const KOKORO_FB = { enabled: true, engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' };

assert.equal(configuredSlot(undefined, ENGINES), null, 'absent block → no slot');
assert.equal(configuredSlot({}, ENGINES), null, 'empty block → no slot');
assert.equal(
  configuredSlot({ ...KOKORO_FB, enabled: false }, ENGINES),
  null,
  'disabled block → no slot, whatever else it holds',
);
assert.equal(
  configuredSlot({ enabled: true, engine: 'bogus', voice: 'x' }, ENGINES),
  null,
  'unknown engine → no slot (a build that dropped an engine cannot rescue onto it)',
);
assert.deepEqual(
  configuredSlot(KOKORO_FB, ENGINES),
  { engine: 'kokoro', personaTts: { engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' } },
  'enabled block → slot carrying engine + voice',
);

// ---- Fallback enabled ------------------------------------------------------

const kokoroSlot = configuredSlot(KOKORO_FB, ENGINES);

// The configured fallback leads, ahead of the operator's default engine.
assert.deepEqual(
  engines(orderedFallbacks('cloud', kokoroSlot, 'chatterbox', allUsable)),
  ['kokoro', 'chatterbox', 'piper'],
  'configured fallback comes first, then the default engine, then the floor',
);

// ...and it is the ONLY rung carrying a voice.
const withFallback = orderedFallbacks('cloud', kokoroSlot, 'chatterbox', allUsable);
assert.deepEqual(
  withFallback[0].personaTts,
  { engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' },
  'configured rung carries the operator voice',
);
assert.ok(
  withFallback.slice(1).every((s) => s.personaTts === null),
  'rungs behind the configured fallback stay voiceless',
);

// Dedup is by engine, FIRST-WINS: a default naming the same engine must not
// displace the configured slot, or the operator's chosen voice would silently
// revert to that engine's global default.
const sameEngine = orderedFallbacks('cloud', kokoroSlot, 'kokoro', allUsable);
assert.deepEqual(engines(sameEngine), ['kokoro', 'piper'], 'same engine appears once');
assert.deepEqual(
  sameEngine[0].personaTts,
  { engine: 'kokoro', voice: 'bf_isabella', cloudProvider: 'openai' },
  'configured slot survives dedup against an identical default engine',
);

// The failed primary is never re-attempted, even when the operator configured
// it as the fallback.
assert.deepEqual(
  engines(orderedFallbacks('kokoro', kokoroSlot, 'chatterbox', allUsable)),
  ['chatterbox', 'piper'],
  'configured fallback === primary → dropped',
);

// An unusable configured fallback (sidecar down, no cloud key) is skipped and
// the chain falls through to the local floor rather than going silent.
assert.deepEqual(
  engines(orderedFallbacks('chatterbox', kokoroSlot, undefined, (e) => e !== 'kokoro')),
  ['piper'],
  'unusable configured fallback filtered, floor still reached',
);

// The gate sees the configured slot's OWN cloud provider, and null for the
// hardcoded rungs — probe and call must use the same credentials.
const cloudFb = configuredSlot(
  { enabled: true, engine: 'cloud', voice: 'nova', cloudProvider: 'elevenlabs' },
  ENGINES,
);

// A failed Cloud provider must not blacklist the whole Cloud engine. This is
// the live #1345 shape: a local OpenAI-compatible/Fish service fails, while the
// operator's configured ElevenLabs rescue is healthy and should be attempted
// before Piper.
const crossProviderCloud = orderedFallbacks(
  { engine: 'cloud', cloudProvider: 'openai-compatible' },
  cloudFb,
  'piper',
  allUsable,
  'openai-compatible',
);
assert.deepEqual(
  engines(crossProviderCloud),
  ['cloud', 'piper', 'kokoro'],
  'a different Cloud provider remains a valid rescue target',
);
assert.equal(
  crossProviderCloud[0]?.personaTts?.cloudProvider,
  'elevenlabs',
  'the first rescue carries the configured ElevenLabs provider',
);
assert.equal(
  sameTtsTarget(
    { engine: 'cloud', cloudProvider: 'elevenlabs' },
    { engine: 'cloud', cloudProvider: 'elevenlabs' },
    'openai-compatible',
  ),
  true,
  'the same Cloud provider is still the same failed target',
);
assert.deepEqual(
  engines(orderedFallbacks(
    { engine: 'cloud', cloudProvider: 'elevenlabs' },
    cloudFb,
    'piper',
    allUsable,
    'openai-compatible',
  )),
  ['piper', 'kokoro'],
  'the failed Cloud provider is not immediately retried',
);

// The HARDCODED default-engine rung is provider-scoped too, and it is the rung
// an operator who never configured a fallback actually gets. It carries no
// override, so it speaks with the station default's credentials — which is
// exactly why it survives a cloud primary on some OTHER provider.
const defaultCloudRung = orderedFallbacks(
  { engine: 'cloud', cloudProvider: 'fish-audio' },
  null,
  'cloud',
  allUsable,
  'elevenlabs',
);
assert.deepEqual(
  engines(defaultCloudRung),
  ['cloud', 'piper', 'kokoro'],
  'the station default Cloud provider rescues a failed persona provider',
);
assert.equal(
  defaultCloudRung[0]?.personaTts,
  null,
  'the default-engine rung carries no override, so it speaks with station credentials',
);
// The same rung against a primary that WAS the station default resolves to the
// same provider on both sides and drops out — no retrying what just threw.
assert.deepEqual(
  engines(orderedFallbacks(
    { engine: 'cloud', cloudProvider: 'elevenlabs' },
    null,
    'cloud',
    allUsable,
    'elevenlabs',
  )),
  ['piper', 'kokoro'],
  'a cloud primary already on the station provider skips the default rung',
);
// An unspecified provider on BOTH sides is the pre-#1345 station: no cloud
// rung, byte-for-byte the old chain.
assert.deepEqual(
  engines(orderedFallbacks({ engine: 'cloud' }, null, 'cloud', allUsable)),
  ['piper', 'kokoro'],
  'with no provider known anywhere, cloud is still one target',
);
assert.equal(
  sameTtsTarget({ engine: 'piper' }, { engine: 'piper', cloudProvider: 'elevenlabs' }, 'openai'),
  true,
  'provider is ignored for every engine but cloud',
);

const seen: Array<[string, string | null | undefined]> = [];
orderedFallbacks('piper', cloudFb, 'cloud', (e, p) => { seen.push([e, p]); return true; });
assert.deepEqual(
  seen,
  [['cloud', 'elevenlabs'], ['kokoro', null]],
  'configured rung probed with its own provider; hardcoded rungs with null',
);

console.log('tts-fallback.test.ts: all assertions passed');
