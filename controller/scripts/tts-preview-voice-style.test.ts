// "Play sample" must audition the persona's delivery directive.
//
// An unkept promise, not a missing feature. The Gemini voice panel's own hint
// reads "The sample button auditions the saved voice plus the persona's voice
// style" — and synthesizeSample() forwarded `soul: ''` with no voiceStyle at
// all, so the button auditioned the voice and silently dropped the directive
// the sentence one line above it promised. Saving the persona then made the
// sample audibly different from the station, which is the exact moment an
// operator stops trusting the button.
//
// This asserts the WIRING, not the composition. The two engines that consume it
// have their own tests (deliveryHint's OpenAI gate, geminiStyle's budget); what
// was missing was the hop from the textarea to the engine, and that hop is four
// hand-offs deep. Each is asserted where it lives, so a dropped hand-off fails
// here with a message naming the link rather than as a silent behaviour change.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This file lives under controller/scripts/, but half the wiring it guards is
// web/. Anchor at the repo root explicitly rather than walking up by guesswork.
const root = join(import.meta.dirname, '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

// Web → the textarea's CURRENT (unsaved) value, not the saved persona's.
test('the persona card forwards its unsaved voiceStyle to the sample button', () => {
  const card = read('web/components/admin/personas/PersonaVoiceCard.tsx');
  assert.match(card, /previewVoiceStyle=\{styleValue\}/,
    'the card must pass the live textarea value, so an unsaved edit is what you hear');
});

test('EngineVoiceFields passes previewVoiceStyle to VoicePreviewButton', () => {
  const fields = read('web/components/admin/tts/EngineVoiceFields.tsx');
  // The destructure, not just the prop type. Declaring a prop and never binding
  // it is the exact shape of this bug's first draft: tsc caught it here, but
  // only because this file happens to be typechecked. Assert the binding too.
  const sig = fields.slice(
    fields.indexOf('export function EngineVoiceFields('),
    fields.indexOf('}: EngineVoiceFieldsProps'),
  );
  assert.match(sig, /previewVoiceStyle/,
    'the prop must be destructured, or the body references an undefined name');

  const at = fields.indexOf('<VoicePreviewButton');
  assert.ok(at > 0, 'EngineVoiceFields must render a VoicePreviewButton');
  const block = fields.slice(at, fields.indexOf('/>', at));
  assert.match(block, /voiceStyle=\{previewVoiceStyle\}/,
    'the prop must reach the button that fires the request');
});

test('the sample button sends voiceStyle in the preview request', () => {
  const button = read('web/components/admin/tts/VoicePreviewButton.tsx');
  const at = button.indexOf('fetchPreviewSample(');
  assert.ok(at > 0, 'the button must call the preview client');
  const block = button.slice(at, button.indexOf('ac.signal', at));
  assert.match(block, /voiceStyle/,
    'voiceStyle must be in the request body, not merely a prop on the component');
});

test('the preview API type accepts the field', () => {
  const api = read('web/components/admin/tts/previewApi.ts');
  const block = api.slice(api.indexOf('interface PreviewParams'), api.indexOf('\n}', api.indexOf('interface PreviewParams')));
  assert.match(block, /voiceStyle\?: string/,
    'PreviewParams must declare it, or the send above cannot typecheck');
});

// Server → both engines that have a free-text channel.
test('the preview route passes the request voiceStyle through to the sampler', () => {
  const route = read('controller/src/routes/settings/tts.ts');
  const block = route.slice(route.indexOf('tts.synthesizeSample({'));
  assert.match(block, /voiceStyle:/,
    'the route must forward the client value into synthesizeSample');
});

test('synthesizeSample forwards voiceStyle into speakWith', () => {
  const tts = read('controller/src/audio/tts.ts');
  const at = tts.indexOf('return speakWith(engine, sample,');
  assert.ok(at > 0, 'synthesizeSample must call speakWith');
  const line = tts.slice(at, tts.indexOf(';', at));
  assert.match(line, /voiceStyle/,
    'voiceStyle must reach speakWith; without it the directive is dropped here');
});

test('the preview clamps the directive rather than refusing the audition', () => {
  const route = read('controller/src/routes/settings/tts.ts');
  const block = route.slice(route.indexOf('voiceStyle: typeof body.voiceStyle'));
  // `text` and `speed` clamp; refusing a preview over a long directive would be
  // a worse failure than truncating one the engine was going to shorten anyway.
  assert.match(block, /PERSONA_VOICE_STYLE_MAX/,
    'clamp to the same budget the persona schema uses');
  assert.match(block, /replace\(\/\\s\+\/g/,
    'collapse whitespace, so a hand-crafted request cannot smuggle newlines into a style string');
});