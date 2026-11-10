// Pins the exact-persona-id contract on BOTH multi-voice cast prompts
// (issue #1512).
//
// generateBanter() and generateProgrammeExchange() each validate every line
// against a per-call z.enum of the active cast's persona ids, and that enum is
// deliberately strict — a repaired speaker airs the line in the wrong voice.
// So a model answering with a display name or the bare HOST/GUEST role sinks
// the whole exchange: the Banter button surfaces the Zod error, and the
// guest-show open/close beats lose the beat with only a log line. The prompts
// must therefore tell the model to copy those ids verbatim, and they must say
// it in ONE shared wording (settings.castSpeakerIdRule) rather than a per-call
// -site paraphrase, the same norm castHouseRulesBlock follows.
//
// Renders the real system prompts only; no LLM or network call is involved.
//
// Run: `npm test -- cast-speaker-ids`.

import assert from 'node:assert/strict';
import test from 'node:test';

import * as settings from '../src/settings.js';
import { banterSystem } from '../src/llm/internal/prompts/banter.js';
import { exchangeSystem } from '../src/llm/internal/prompts/programme.js';

// The ids from the bug report, so the failing shape is the one pinned.
const HOST = { id: 'p_default1', name: 'Default Host', soul: 'warm and concise' };
const GUEST = { id: 'p_9751c3', name: 'Guest Voice', soul: 'curious and playful' };

const banter = banterSystem({ host: HOST, guests: [GUEST] });
// exchangeSystem takes the rendered cast block rather than the roster — the
// same block generateProgrammeExchange builds from host + guests.
const exchange = exchangeSystem({
  host: HOST,
  show: { name: 'The Late Shift' },
  castBlock: `- ${HOST.id} — ${HOST.name} (HOST): ${HOST.soul}\n- ${GUEST.id} — ${GUEST.name} (GUEST): ${GUEST.soul}`,
  beatTask: 'Open the show together.',
});

test('banter prompt renders the exact active cast persona ids', () => {
  assert.match(banter, /- p_default1 — Default Host \(HOST\):/);
  assert.match(banter, /- p_9751c3 — Guest Voice \(GUEST\):/);
});

test('the speaker rule requires verbatim ids and rejects every substitution', () => {
  const rule = settings.castSpeakerIdRule();
  assert.match(rule, /copy the persona id exactly and verbatim from the cast list/i);
  assert.match(rule, /structured "speaker" field/i);
  assert.match(rule, /never use a display name/i);
  assert.match(rule, /HOST or GUEST role/i);
  assert.match(rule, /altered, reformatted, or rewritten persona id/i);
});

// Both cast paths, not just the one the button presses. The programme
// open/close exchange builds the identical per-call speaker enum and fires
// autonomously, so a rejection there is a beat that never airs.
test('both cast prompts carry the rule, in the one shared wording', () => {
  const rule = settings.castSpeakerIdRule();
  assert.ok(banter.includes(rule), 'banter prompt carries the shared speaker rule');
  assert.ok(exchange.includes(rule), 'programme exchange carries the shared speaker rule');
});

// The rule must not depend on djHouseRules being set: castHouseRulesBlock's
// scope clause already says an id stays exact, but it renders '' on a default
// install — which is the install #1512 was reported from.
test('the rule renders with no station house rules configured', () => {
  assert.equal(settings.castHouseRulesBlock(), '', 'house rules are off by default');
  assert.ok(banter.includes('copy the persona id exactly'), 'banter says it anyway');
  assert.ok(exchange.includes('copy the persona id exactly'), 'programme exchange says it anyway');
});
