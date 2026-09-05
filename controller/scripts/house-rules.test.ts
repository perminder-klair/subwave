// Pins the station house-rules block (settings.djHouseRules → ALL THREE prompt
// paths, issues #1182 and #1420).
//
// The operator-editable djPrompt template only renders on the scripted-talk
// path (renderDjPrompt → djSystem); the tool-loop agents (picker, requests,
// segment director) build their prompts from agentPersonaPreamble, which never
// reads the template; and the multi-voice cast prompts (banterSystem,
// exchangeSystem) hand-roll a third shape around a per-call speaker enum,
// going through neither. djHouseRules is the path-agnostic block all three
// append, so per-station correctness rules (TTS control tags, "spell out
// numbers", locale orthography) reach every spoken line. Three properties are
// load-bearing:
//
//  - Empty means OFF and byte-identical prompts. A pre-#1182 settings.json
//    (no key) or a cleared field must not change a single prompt byte, or an
//    upgrade silently reshapes every station's on-air voice.
//  - The block reaches EVERY path. The agent and cast sides bind the rules to
//    spoken fields only — structured output carries internal fields (ids,
//    reasons, kinds) that a rule like "write out numbers" must never mangle.
//  - The cast assertions run against the RENDERED system prompt, not against
//    castHouseRulesBlock() itself. #1420 was a builder that existed and was
//    never appended; a test on the builder passes on the broken code.
//
// STATE_DIR is redirected at a throwaway dir BEFORE the first import, so
// settings.load()/update() touch nothing real — hence the dynamic import.
// node:assert-via-tsx style, matching scripts/voice-policy.test.ts.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-house-'));
process.env.STATE_DIR = root;

// Seed a padded, over-long value BEFORE the first import so load()'s own
// trim+cap normalisation is exercised (update() can't reach that path — the
// cache is already loaded by then).
writeFileSync(
  join(root, 'settings.json'),
  JSON.stringify({ djHouseRules: `  ${'x'.repeat(2100)}  ` }),
);

const settings = await import('../src/settings.js');
// The two multi-voice system prompts, imported as the pure builders they
// export. Reaching into llm/internal/** for a prompt-shape assertion has
// precedent (scripts/programme-grounding.test.ts does exactly this) — the
// "call sites use the barrel" rule is about production code, not tests.
const { banterSystem } = await import('../src/llm/internal/prompts/banter.js');
const { exchangeSystem } = await import('../src/llm/internal/prompts/programme.js');

// Minimal cast — banterSystem/exchangeSystem only read id/name/soul off these.
const HOST = { id: 'p_host', name: 'Nova', soul: 'warm and dry' };
const GUESTS = [{ id: 'p_guest', name: 'Rex', soul: 'loud, fond of a tangent' }];
const SHOW = { name: 'The Late Shift' };
const castPrompts = () => [
  ['banter', banterSystem({ host: HOST, guests: GUESTS, show: SHOW })],
  ['programme exchange', exchangeSystem({
    show: SHOW, castBlock: `- ${HOST.id} — ${HOST.name}`, beatTask: 'open the show',
  })],
];

try {
  await settings.load();

  // ── load(): hand-edited file is trimmed and capped at DJ_HOUSE_RULES_MAX ──
  assert.equal(settings.get().djHouseRules.length, 2000, 'load caps at 2000 chars');
  assert.ok(!settings.get().djHouseRules.startsWith(' '), 'load trims');

  const persona = { id: 'p_test', name: 'Nova', soul: 'warm and dry' };

  // ── OFF: cleared rules leave every path without the block ────────────────
  await settings.update({ djHouseRules: '' });
  const scriptedOff = settings.renderDjPrompt(persona);
  const agentOff = settings.agentPersonaPreamble(persona);
  assert.ok(!scriptedOff.includes('Station house rules'), 'scripted path clean when off');
  assert.ok(!agentOff.includes('Station house rules'), 'agent path clean when off');
  const castOff = castPrompts();
  for (const [name, prompt] of castOff) {
    assert.ok(!prompt.includes('Station house rules'), `${name} path clean when off`);
  }

  // ── ON: the block reaches the scripted + agent paths (#1182) ─────────────
  const RULES = 'Always spell out numbers and dates in words.\nUse [laugh] sparingly.';
  await settings.update({ djHouseRules: `  ${RULES}  ` });
  assert.equal(settings.get().djHouseRules, RULES, 'update trims');
  const scripted = settings.renderDjPrompt(persona);
  const agent = settings.agentPersonaPreamble(persona);
  assert.ok(scripted.includes('Station house rules'), 'scripted path carries the block');
  assert.ok(scripted.includes(RULES), 'scripted path carries the rules text');
  assert.ok(agent.includes('Station house rules'), 'agent path carries the block');
  assert.ok(agent.includes(RULES), 'agent path carries the rules text');
  // The agent framing must scope the rules to spoken output — agent responses
  // are structured, and internal fields (ids, kinds) are exempt.
  assert.ok(agent.includes('spoken line'), 'agent framing binds rules to spoken fields');

  // ── ON: the multi-voice cast paths carry it too (#1420) ─────────────────
  // These are the prompts that write banter and guest-show open/closes. They
  // build their own system text, so nothing but an explicit append puts the
  // rules on them — and the rules must not reach the `speaker` field, which
  // has to stay an exact persona id from the cast list.
  //
  // The exemption is asserted against the BLOCK's own scope wording, not the
  // bare phrase `"speaker" field`: both cast prompts now carry an unconditional
  // exact-id rule of their own (settings.castSpeakerIdRule, #1512) that
  // contains that phrase, so the loose match passes even with the scope clause
  // deleted — the regression this line exists for.
  for (const [name, prompt] of castPrompts()) {
    assert.ok(prompt.includes('Station house rules'), `${name} path carries the block`);
    assert.ok(prompt.includes(RULES), `${name} path carries the rules text`);
    assert.ok(
      prompt.includes('they do not apply to the "speaker" field'),
      `${name} framing exempts the speaker id`,
    );
  }

  // ── The block also rides a CUSTOM template ───────────────────────────────
  // It's appended after render, so a template that predates the feature (no
  // placeholder for it) still gets the rules.
  const custom = 'You are {name}, the voice of {station}. Keep every link short and warm.';
  await settings.update({ djPrompt: custom });
  assert.ok(settings.renderDjPrompt(persona).includes(RULES), 'custom template gets the block');

  // ── Round trip: clearing restores byte-identical prompts ─────────────────
  await settings.update({ djPrompt: '', djHouseRules: '' });
  assert.equal(settings.renderDjPrompt(persona), scriptedOff, 'scripted path byte-identical after clear');
  assert.equal(settings.agentPersonaPreamble(persona), agentOff, 'agent path byte-identical after clear');
  const castCleared = castPrompts();
  for (let i = 0; i < castCleared.length; i += 1) {
    assert.equal(castCleared[i][1], castOff[i][1], `${castCleared[i][0]} path byte-identical after clear`);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  await assert.rejects(
    settings.update({ djHouseRules: 'y'.repeat(2001) }),
    /2000/,
    'over-cap update is refused',
  );
  // Non-string coerces to '' (off) rather than crashing on a hand-rolled PATCH.
  await settings.update({ djHouseRules: null });
  assert.equal(settings.get().djHouseRules, '', 'null coerces to off');

  console.log('house-rules.test.ts: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
