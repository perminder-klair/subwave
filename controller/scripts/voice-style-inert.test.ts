// The per-persona delivery directive must be INERT for every engine that has
// no channel for it.
//
// This is a regression guard, not a feature test. The feature test
// (persona-voice-style.test.ts) proves the directive REACHES gemini and
// cloud→openai; it cannot prove the eight other engines are unaffected, because
// "unaffected" is an absence and an absent assertion fails open. A station
// running Piper — the default, no key, no cost — must keep sounding exactly as
// it did before this field existed, and the failure mode of getting it wrong is
// silent: a directive folded into a provider body that ignores it, or a
// numeric ElevenLabs slider overwritten by the string.
//
// Every case here is driven through the REAL deliveryHint / geminiStyle the
// engines call, not through a re-implementation of them.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliveryHint } from '../src/llm/internal/speech/cloud-speech.js';
import { geminiStyle } from '../src/audio/gemini.js';

const DIRECTIVE = 'tired Australian dad, warm, unhurried';
const SOUL = 'A cheerful Tasmanian radio presenter who loves mornings.';

// The two engines that are SUPPOSED to receive it. Named explicitly so the
// inert-engine table below reads as a claim about everyone else.
test('the directive still reaches the two engines that own a channel', () => {
  assert.match(
    deliveryHint({ soul: SOUL, voiceStyle: DIRECTIVE }, 'openai', 'gpt-4o-mini-tts').instructions || '',
    new RegExp(DIRECTIVE.split(',')[0]),
    'openai gpt-4o-tts composes the directive',
  );
  assert.match(
    geminiStyle({ soul: SOUL, voiceStyle: DIRECTIVE, pronunciation: '' }, []),
    new RegExp(DIRECTIVE.split(',')[0]),
    'gemini composes the directive',
  );
});

// Every cloud provider that must NOT receive it, with the models that matter.
// openai-compatible is the sharpest case: it targets self-hosted llama.cpp /
// vLLM / LM Studio boxes whose body is the caller's, so an unexpected
// `instructions` key is one a fork might forward straight into a prompt.
test('no other cloud provider receives the directive, on any model', () => {
  const blocked: [provider: string, model: string][] = [
    ['elevenlabs', 'eleven_multilingual_v2'],
    ['elevenlabs', 'eleven_v3'],
    ['fish-audio', 'speech-1.6'],
    ['openai-compatible', 'llama3.1'],
    ['openai-compatible', 'qwen2.5'],
  ];
  for (const [provider, model] of blocked) {
    const hint = deliveryHint({ soul: SOUL, voiceStyle: DIRECTIVE }, provider, model);
    assert.equal(
      Object.prototype.hasOwnProperty.call(hint, 'instructions'),
      false,
      `${provider}/${model} must not gain an instructions key — a self-hosted box ` +
      `may forward it into its own prompt`,
    );
    assert.equal(
      JSON.stringify(hint).includes('unhurried'), false,
      `${provider}/${model} must not carry the directive text`,
    );
  }
});

// openai's own gate is MODEL-scoped, not provider-scoped: tts-1 silently drops
// the line to an English local fallback when it receives `instructions`. This is
// why the gate exists at all, so it is pinned per model rather than per
// provider.
test('openai models without an instructions channel stay ungated-safe', () => {
  for (const model of ['tts-1', 'tts-1-hd', 'whisper-1', 'gpt-4o-audio-preview']) {
    assert.deepEqual(
      deliveryHint({ soul: SOUL, voiceStyle: DIRECTIVE }, 'openai', model), {},
      `${model} must receive no instructions key at all`,
    );
  }
});

/**
 * A DEFINING occurrence of the bare `voiceStyle` token inside `cloudOverride` —
 * every way a property can be introduced there.
 *
 * The previous guard was `voiceStyle\s*(?![,}\s]*[,}])`, which is exempt for
 * shorthand `voiceStyle,` and `voiceStyle}` — the two spellings that reach
 * ElevenLabs without an explicit value. So the guard missed the shorthand while
 * its own failure message promised the directive could not be passed "under any
 * spelling". An assertion that overclaims is worse than none: it reads as
 * coverage and is not.
 *
 * The rule is narrower and does not need to enumerate spellings. Inside
 * `cloudOverride` the token may only ever appear as a MEMBER READ
 * (`opts.voiceStyle`, `cloudVoiceSettings.voiceStyle`) — pulling the numeric out
 * of an object that legitimately holds it. Any bare token is a property being
 * DEFINED there, and `cloudOverride` is composed from spreads alone.
 */
const BARE_VOICE_STYLE = /(?<![.\w$])voiceStyle\b/;

// The guard is only worth having if it fires on every spelling it claims to, so
// it is checked against the shapes themselves before it is used on real source.
// A regex that silently matches nothing reports a clean file forever.
test('the cloudOverride guard fires on every spelling it claims to', () => {
  for (const spelling of [
    'voiceStyle: opts.voiceStyle',   // the obvious regression
    'voiceStyle,',                   // shorthand among other properties
    'voiceStyle }',                  // shorthand as the last property
    '{ voiceStyle }',                // shorthand alone
    'voiceStyle: DIRECTIVE',
    'voiceStyle :style',             // whitespace before the colon
  ]) {
    assert.match(spelling, BARE_VOICE_STYLE,
      `the guard must flag a DEFINING \`voiceStyle\` in cloudOverride: ${spelling}`);
  }
  // Member reads are the legitimate case and must not be flagged: those are how
  // the numeric slider reaches ElevenLabs.
  for (const reading of [
    '...(opts.cloudVoiceSettings || {})',
    'opts.voiceStyle',
    'cloudVoiceSettings.voiceStyle',
  ]) {
    assert.doesNotMatch(reading, BARE_VOICE_STYLE,
      `a MEMBER READ of voiceStyle is how the numeric gets through: ${reading}`);
  }

  // A KNOWN false positive, pinned rather than hidden. In
  // `const { voiceStyle: n } = source` the token is a READ, but a destructuring
  // rename is textually identical to an object-literal property definition —
  // there is no way to tell them apart without knowing whether the enclosing
  // brace is a pattern. Flagging it is the safe direction: the guarded slice is
  // four lines of pure spreads, so a destructuring read there would be obvious
  // and is not a shape this codebase writes. Listed here so the limitation is a
  // recorded decision rather than a surprise for whoever hits it next.
  assert.match('const { voiceStyle: numeric } = opts.cloudVoiceSettings;',
    BARE_VOICE_STYLE, 'documented limitation: a destructuring RENAME reads as a definition');
});

// The name collision. `voiceStyle` is BOTH this station's string delivery
// directive AND ElevenLabs' numeric style slider (0–1). They are different
// fields that happen to share a name, on different objects: the number rides
// cloudOverride.voiceStyle, the string rides the top-level opts. If either
// path ever reads the other's object, an operator's slider turns into prose (or
// a directive turns into NaN) — and ElevenLabs would reject the request.
test('the ElevenLabs numeric slider and the string directive cannot collide', async () => {
  const tts = await import('../src/audio/tts.js');
  // The preview's own slider object, as the route builds it.
  const cloudVoiceSettings = { voiceStyle: 0.42 };
  const previewVoiceStyle = DIRECTIVE;

  // The numeric survives as a NUMBER in the object that reaches ElevenLabs...
  for (const key of ['voiceStability', 'voiceStyle', 'voiceSimilarityBoost'] as const) {
    const v = (cloudVoiceSettings as Record<string, unknown>)[key];
    if (typeof v === 'number') {
      assert.equal(typeof v, 'number', `${key} must stay numeric inside cloudVoiceSettings`);
    }
  }
  // ...and the string is a top-level opt, never merged into it. The source is
  // the assertion: cloudOverride is composed from the slider object alone.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/audio/tts.ts', import.meta.url), 'utf8'));
  const compose = src.slice(src.indexOf('const cloudOverride'), src.indexOf('return cloud.speak'));
  assert.match(compose, /cloudVoiceSettings/, 'cloudOverride must merge the slider object');
  assert.doesNotMatch(compose, BARE_VOICE_STYLE,
    'cloudOverride must not be handed the string directive under any spelling');

  // Both values coexist as distinct types at the speak() boundary.
  assert.equal(typeof previewVoiceStyle, 'string');
  assert.equal(typeof cloudVoiceSettings.voiceStyle, 'number');
  assert.notEqual(typeof tts.synthesizeSample, 'undefined');
});

// Local engines. They receive `{ ...opts }`, so the field RIDES on the object —
// the requirement is that none of them read it or forward it.
test('no local engine reads the directive', async () => {
  const fs = await import('node:fs');
  // Real filenames, not engine ids. `pocket-tts` and `remote` are pocketTts.ts
  // and remoteTts.ts, and a wrong name here makes the file read THROW — which
  // the first draft swallowed with `catch { continue }`, silently checking
  // three of five engines and reporting all five. A skipped engine is the
  // exact failure this file exists to prevent.
  const FILES: Record<string, string> = {
    piper: 'piper.ts', kokoro: 'kokoro.ts', chatterbox: 'chatterbox.ts',
    'pocket-tts': 'pocketTts.ts', remote: 'remoteTts.ts',
  };
  for (const [engine, file] of Object.entries(FILES)) {
    const path = new URL(`../src/audio/${file}`, import.meta.url);
    assert.ok(fs.existsSync(path), `${file} must exist — a renamed engine file would otherwise skip this check`);
    const src = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(
      src, /voiceStyle/,
      `${file} (${engine}) must not reference voiceStyle — it has no channel for it`,
    );
  }
});

// The preview is the path this guard was written for: it is the only caller that
// forwards the directive for an engine the operator has NOT saved yet.
test('the preview forwards the directive without requiring it to be saved', async () => {
  const route = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/routes/settings/tts.ts', import.meta.url), 'utf8'));
  // Bound the slice to THIS route's call. An unbounded slice runs on into the
  // voice-catalogue route below, whose settings.get() is legitimate and would
  // make this assertion fail on code that is correct — the first draft of this
  // test did exactly that.
  const start = route.indexOf('voiceStyle: typeof body.voiceStyle');
  const block = route.slice(start, route.indexOf('signal: previewAbort.signal', start));
  assert.ok(block.length > 0 && block.length < 900, `slice must cover just this call, got ${block.length} chars`);
  // It is an UNSAVED override, read from the request body — never from the
  // stored persona. Reading the stored persona here would audition a stale
  // value the operator had already edited away.
  assert.match(block, /body\.voiceStyle/,
    'the preview must take the directive from the request, not from stored settings');
  assert.doesNotMatch(block, /settings\.get\(\)/,
    'the preview must not reach into stored settings for the directive');
});

// Backward compatibility: a persona written before this field existed must
// still load, and must load with nothing invented.
test('a persona with no directive loads with none, on every engine', async () => {
  const hint = deliveryHint({ soul: SOUL, voiceStyle: undefined }, 'openai', 'gpt-4o-mini-tts');
  assert.match(hint.instructions || '', /Convey this character/);
  assert.doesNotMatch(hint.instructions || '', /unhurried|directive/i,
    'an absent directive must not leave a trace');
  assert.deepEqual(deliveryHint({ soul: '', voiceStyle: '' }, 'openai', 'gpt-4o-mini-tts'), {},
    'no soul and no directive means no hint — the pre-existing behaviour');
});