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
import ts from 'typescript';
import { GEMINI_CLOUD_PROVIDER } from './engineMeta';

const here = join(process.cwd(), 'components/admin/tts');
const fields = readFileSync(join(here, 'EngineVoiceFields.tsx'), 'utf8');

// WHAT THIS FILE DOES, PRECISELY
// --------------------------------
// It does NOT render anything. `web/` has no DOM test environment — no
// testing-library, no jsdom — so this parses EngineVoiceFields.tsx with the
// TypeScript compiler, lifts the two expressions out of the AST, and evaluates
// them. An earlier version of this comment claimed it "renders the whole
// component", which it never did, and a reviewer was right to call that out: a
// comment overstating what a test does is the same defect as an assertion that
// cannot fail.
//
// What this therefore proves, and what it does not:
//   PROVES    the value the caller hands the selector, and the condition under
//             which the selector is rendered at all. Both are the whole bug —
//             the selector highlights whatever it is HANDED, so the defect lives
//             entirely in its caller, and a test of CloudProviderSelector alone
//             passes against broken code.
//   DOES NOT  prove anything about React's rendering, the card's DOM, or the
//             click handler. That needs a DOM harness, and until one exists this
//             file must not claim it.
//
// The AST is used rather than a regex because the previous guard locator was
// positional: it took the FIRST `{(...) && (` in the file, which is not
// necessarily the selector's parent. An unrelated conditional earlier in the
// component would have silently supplied the answer.
const sf: ts.SourceFile = ts.createSourceFile(
  'EngineVoiceFields.tsx', fields, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
);

const SELECTOR_TAG = 'CloudProviderSelector';

/** The JSX element for the provider selector, located structurally.
 *
 *  Both node kinds are checked because the call site is SELF-CLOSING
 *  (`<CloudProviderSelector ... />`), which TypeScript models as
 *  `JsxSelfClosingElement` and NOT `JsxOpeningElement`. Matching only the
 *  opening-element kind finds nothing and reports a missing selector. */
function selectorElement(): ts.JsxOpeningElement | ts.JsxSelfClosingElement {
  let found: ts.JsxOpeningElement | ts.JsxSelfClosingElement | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      && node.tagName.getText(sf) === SELECTOR_TAG) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.ok(found, `EngineVoiceFields must render a ${SELECTOR_TAG}`);
  return found!;
}

/** The `value={...}` expression handed to the selector. */
function providerSelectorValue(): string {
  const attr = selectorElement().attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p)
      && ts.isIdentifier(p.name) && p.name.text === 'value',
  );
  assert.ok(attr?.initializer, 'the selector must be given an explicit value');
  return attr.initializer.getText(sf).replace(/^\{|\}$/g, '');
}

/**
 * The CONDITION under which the selector is rendered, found by walking up from
 * the element rather than by searching the file.
 */
function providerSelectorGuard(): string {
  let node: ts.Node | undefined = selectorElement();
  let guard: ts.BinaryExpression | undefined;
  while (node && !guard) {
    // The call site is `{cond && (() => { ... })}`, which TypeScript models as a
    // BinaryExpression with an AmpersandAmpersandToken — NOT a
    // ConditionalExpression. Searching for the ternary type finds no ancestor at
    // all and reports "no guard" for a selector that plainly has one.
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      guard = node;
    }
    node = node.parent;
  }
  assert.ok(guard,
    'expected the selector to be rendered behind a condition, e.g. '
      + '{cond && (() => { ... <CloudProviderSelector /> })()}');
  return guard.left.getText(sf);
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

/** Whether the provider cards render at all, for a given slot.
 *
 *  This replaces the case that asserted the opposite of its own name.
 *  `selectedCard('inherit', 'openai')` returned 'openai', and the test was named
 *  "does not light up any provider card" — which is the opposite of what returning
 *  'openai' means. It passed while checking a value the component never produces:
 *  the selector is not rendered for an inheriting persona at all, so there is no
 *  card to light up. An assertion whose name contradicts its own expectation
 *  reads as coverage of a regression it does not cover. */
function selectorIsRendered(engine: string, geminiSelected: boolean): boolean {
  const expr = providerSelectorGuard()
    .replace(/value\.engine/g, JSON.stringify(engine))
    .replace(/geminiSelected/g, String(geminiSelected));
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