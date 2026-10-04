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

/** The condition under which EngineVoiceFields renders the provider selector at
 *  all, evaluated against an engine + gemini-selected pair.
 *
 *  This exists because the case it replaces asserted the WRONG THING. For a
 *  persona on the station default, `selectedCard('inherit', 'openai')` returned
 *  'openai' — and the test was named "does not light up any provider card",
 *  which is the opposite of what returning 'openai' means. It passed, and it was
 *  checking a value the component never produces: the selector is rendered only
 *  when the engine is `cloud` or Gemini is selected, so for `inherit` there is
 *  no card to light up at all. An assertion whose name contradicts its own
 *  expectation is worse than a missing one — it reads as coverage of a
 *  regression that it does not cover. */
function selectorIsRendered(engine: string, geminiSelected: boolean): boolean {
  const at = fields.indexOf('<CloudProviderSelector');
  assert.ok(at > 0, 'EngineVoiceFields must render a CloudProviderSelector');
  const block = fields.slice(at, fields.indexOf('/>', at));
  const guard = /\{\(([^)]*?)\)\s*&&\s*\(/.exec(fields.slice(0, at));
  assert.ok(guard?.[1],
    'expected the selector to be rendered behind a guard, e.g. '
      + '{(cond) && (() => { ... <CloudProviderSelector ... /> })()}');
  const expr = guard[1]
    .replace(/value\.engine/g, JSON.stringify(engine))
    .replace(/geminiSelected/g, String(geminiSelected));
  assert.ok(block.length > 0, 'the selector must exist in the guarded branch');
  return Boolean(new Function(`return (${expr});`)());
}

test('the provider cards only exist for the engines that own a provider', () => {
  // The real invariant, and the one the operator can see: a persona on the
  // station default has no provider card to select, so there is nothing to light
  // up and nothing to click. The cards belong to the two engines that carry a
  // cloudProvider — `cloud`, and Gemini, which presents as a card while writing
  // its own engine id.
  assert.equal(selectorIsRendered('inherit', false), false,
    'a persona on the station default must not render provider cards');
  assert.equal(selectorIsRendered('cloud', false), true,
    'the cloud engine owns the provider choice');
  assert.equal(selectorIsRendered(GEMINI_CLOUD_PROVIDER, true), true,
    'Gemini is an engine that presents as a provider card');
  assert.equal(selectorIsRendered(GEMINI_CLOUD_PROVIDER, false), false,
    'geminiSelected is what admits the card, not the engine id alone');
});