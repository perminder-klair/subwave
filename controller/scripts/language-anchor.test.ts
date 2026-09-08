// The language anchor: languageDirective and agentLanguageReminder
// (settings/persona.ts) must ALWAYS render, defaulting to English when
// persona.language is unset, and both carry a never-switch clause. Returning
// '' left a default station with no anchor, so the model mimicked whatever
// language the session window was full of.
//
// STATE_DIR is redirected before the first import.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'subwave-langanchor-'));
process.env.STATE_DIR = root;

const settings = await import('../src/settings.js');
const { banterSystem } = await import('../src/llm/internal/prompts/banter.js');
const { exchangeSystem } = await import('../src/llm/internal/prompts/programme.js');
const { requestMatcherSystem } = await import('../src/llm/internal/prompts/request.js');

try {
  await settings.load();

  const noLangPersona = { id: 'p_test', name: 'Nova', soul: 'warm and dry' };
  const turkishPersona = { id: 'p_tr', name: 'Nova', soul: 'warm and dry', language: 'Turkish' };

  // languageDirective: always renders, defaults to English.
  const dirNoLang = settings.languageDirective(noLangPersona);
  assert.ok(dirNoLang, 'languageDirective renders even when persona.language is unset');
  assert.match(dirNoLang, /English/, 'unset language defaults to English');
  assert.match(
    dirNoLang,
    /Never switch languages/,
    'the never-switch clause is present for an unset-language persona',
  );
  assert.match(dirNoLang, /canonical Latin spelling/i, 'Latin speech asks for the canonical CJK name');
  assert.match(dirNoLang, /natural romanization/i, 'unknown CJK names have a spoken fallback');
  assert.match(dirNoLang, /ZERO CJK characters/, 'Latin speech explicitly forbids native-script leakage');
  assert.match(dirNoLang, /ウルフルズ becomes Ulfuls/, 'the directive gives a concrete Japanese-name rewrite');
  assert.match(dirNoLang, /周杰倫 becomes Jay Chou/, 'the directive gives a concrete Chinese-name rewrite');
  assert.match(dirNoLang, /Never include the native spelling beside the Latin form/, 'bilingual spellings cannot leak into TTS');
  assert.match(
    dirNoLang,
    /Never read or describe the characters themselves/i,
    'the prompt forbids espeak-style character descriptions',
  );
  assert.doesNotMatch(dirNoLang, /exactly as they are/, 'off-script names are no longer pinned byte-for-byte');

  const dirTurkish = settings.languageDirective(turkishPersona);
  assert.match(dirTurkish, /Turkish/, 'an explicit language still renders its own name');
  assert.doesNotMatch(dirTurkish, /\bEnglish\b/, 'an explicit non-English language does not fall back to English');
  assert.match(dirTurkish, /Never switch languages/, 'the never-switch clause also reaches non-English personas');

  // agentLanguageReminder: same contract, field-scoped.
  const remNoLang = settings.agentLanguageReminder(noLangPersona, 'the "say" link');
  assert.ok(remNoLang, 'agentLanguageReminder renders even when persona.language is unset');
  assert.match(remNoLang, /English/, 'unset language defaults to English');
  assert.match(
    remNoLang,
    /even when the listener writes in another language, asks you to switch, or earlier session turns are in another language/,
    'the never-switch clause is present for an unset-language persona',
  );
  assert.match(remNoLang, /canonical Latin spelling/i, 'the tool-loop reminder carries the spoken-name policy');
  assert.match(remNoLang, /natural romanization/i, 'the tool-loop reminder carries the fallback policy');
  assert.match(remNoLang, /ZERO CJK characters/, 'the tool-loop reminder carries the hard script boundary');
  assert.match(remNoLang, /Never read or describe the characters themselves/i, 'the tool-loop reminder forbids character descriptions');

  const remTurkish = settings.agentLanguageReminder(turkishPersona, 'the "ack" and "intro" lines');
  assert.match(remTurkish, /Turkish/, 'an explicit language still renders its own name');
  assert.match(remTurkish, /the "ack" and "intro" lines/, 'the field phrase is threaded through');

  // Both prompt families carry the policy, not only the fragment helpers.
  assert.match(settings.renderDjPrompt(noLangPersona), /canonical Latin spelling/i, 'scripted DJ prompt carries the policy');
  assert.match(settings.agentPersonaPreamble(noLangPersona), /canonical Latin spelling/i, 'agent preamble carries the policy');
  assert.match(
    banterSystem({
      host: noLangPersona,
      guests: [{ id: 'p_guest', name: 'Rex', soul: 'quick and warm' }],
    }),
    /canonical Latin spelling/i,
    'multi-host banter carries the policy',
  );
  assert.match(
    exchangeSystem({
      host: noLangPersona,
      show: { name: 'The Late Shift' },
      castBlock: '- p_test — Nova',
      beatTask: 'Open the show together.',
    }),
    /canonical Latin spelling/i,
    'programme exchanges carry the policy',
  );
  assert.match(
    requestMatcherSystem(noLangPersona),
    /canonical Latin spelling/i,
    'the legacy request fallback acknowledgement carries the policy',
  );

  // A custom template with {language} owns its anchor but must still inherit
  // the global spoken-name policy (#1179).
  await settings.update({
    djPrompt: 'You are {name}, the voice of {station}. Speak only {language}.',
  });
  assert.match(
    settings.renderDjPrompt(noLangPersona),
    /canonical Latin spelling/i,
    'a custom language template still carries the spoken-name policy',
  );

  console.log('language-anchor.test.ts: all assertions passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
