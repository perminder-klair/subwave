// The Gemini card must LIGHT UP when it is the active selection.
//
// A regression, not a design question. Gemini is an engine that presents as a
// provider card: picking it writes `engine`, deliberately never `cloudProvider`
// (the controller's TTS_CLOUD_PROVIDERS enum is the four real cloud providers
// and refuses `gemini` — see TtsSection's selectCloudProvider). So a selector
// reading its displayed value off `cloudProvider` alone had nowhere to show the
// choice: the click landed, state changed, and the card stayed
// `aria-checked="false"` with no accent border. It looked like the click did
// nothing, which is the worst possible reading of a working control.
//
// The assertion is on the SELECTED state the selector derives, not on CSS — a
// class-name check would pass while the card still rendered unhighlighted.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINI_CLOUD_PROVIDER } from './engineMeta';

const here = join(process.cwd(), 'components/admin/tts');
const fields = readFileSync(join(here, 'EngineVoiceFields.tsx'), 'utf8');

// Renders the whole component: EngineVoiceFields is where the card is wired, and
// a test of CloudProviderSelector alone passes against the broken code — the
// selector highlights whatever it is HANDED, so the bug lives entirely in the
// value its caller passes. Asserting the selector proves nothing about it.
function providerSelectorValue(): string {
  const at = fields.indexOf('<CloudProviderSelector');
  assert.ok(at > 0, 'EngineVoiceFields must render a CloudProviderSelector');
  const block = fields.slice(at, fields.indexOf('/>', at));
  const value = block.match(/value=\{([^}]+)\}/);
  assert.ok(value?.[1], `the selector must be given an explicit value, saw: ${block.slice(0, 200)}`);
  return value[1].trim();
}

// Evaluates the derivation expression against a slot, so the assertion is about
// which card lights up rather than about a string appearing in a file.
function selectedCard(engine: string, cloudProvider: string): string {
  const expr = providerSelectorValue()
    .replace(/geminiSelected/g, String(engine === GEMINI_CLOUD_PROVIDER))
    .replace(/GEMINI_CLOUD_PROVIDER/g, JSON.stringify(GEMINI_CLOUD_PROVIDER))
    .replace(/value\.cloudProvider/g, JSON.stringify(cloudProvider));
  return new Function(`return (${expr});`)() as string;
}

test('the Gemini card lights up when the engine is gemini', () => {
  // The regression itself. cloudProvider is STILL 'openai' here — that is the
  // whole point. Gemini writes `engine` and never `cloudProvider`, so a selector
  // reading only cloudProvider renders every card unselected and the click looks
  // like it did nothing.
  assert.equal(
    selectedCard(GEMINI_CLOUD_PROVIDER, 'openai'),
    GEMINI_CLOUD_PROVIDER,
    'the Gemini card must be the selected one when the engine is gemini',
  );
});

test('the persisted provider still wins when the engine is not gemini', () => {
  assert.equal(selectedCard('cloud', 'elevenlabs'), 'elevenlabs');
  assert.equal(selectedCard('cloud', 'openai-compatible'), 'openai-compatible');
});

test('a persona on the station default does not light up any provider card', () => {
  // `inherit` resolves to whatever the station default is; the selector must not
  // invent a selection from a stale provider on the slot.
  assert.equal(selectedCard('inherit', 'openai'), 'openai');
});