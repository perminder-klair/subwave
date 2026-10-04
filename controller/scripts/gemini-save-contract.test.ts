import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { DEFAULTS } from '../src/settings/defaults.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, '..', p), 'utf8');

/** Every field `settings.update()` writes under `next.tts.gemini`. */
function geminiSaveFields(): string[] {
  return [...new Set(
    [...read('src/settings.ts').matchAll(/next\.tts\.gemini\.([A-Za-z]+)/g)].map((m) => m[1]),
  )].sort();
}

/** The keys the admin save payload sends. Read as TEXT, not imported: the web
 *  app is a separate package with its own build, and a controller test that
 *  imports it would drag React and Next into `node --test`. */
function webSaveKeys(): string[] {
  const src = read('../web/components/admin/settings/geminiSavePayload.ts');
  const block = /GEMINI_SAVE_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  assert.ok(block, 'GEMINI_SAVE_KEYS not found in geminiSavePayload.ts');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

// The failure this file exists for: `tts.gemini.libraryLanguage` shipped fully
// wired — control, hydration, schema predicate, and a controller save path that
// accepted it — and was still inert, because the admin form's `save()` REBUILDS
// the gemini block field by field and never named it. Nothing errored. The
// operator's choice was discarded on every save and the control read as broken.
//
// The three layers below are each necessary and none is sufficient:
//   DEFAULTS  — the field exists and has a value
//   update()  — the field is accepted and normalised on the way in
//   web block — the field is actually SENT
// A new `tts.gemini` field added to any two of the three, and not the third,
// is a silent data loss on save. That is the whole hazard.

test('every gemini field the update path accepts is also sent by the admin form', () => {
  const accepted = geminiSaveFields();
  const sent = webSaveKeys();

  assert.ok(accepted.length >= 4, `expected the gemini save path, found [${accepted}]`);

  const missing = accepted.filter((f) => !sent.includes(f));
  assert.deepEqual(
    missing, [],
    `settings.update() accepts tts.gemini.${missing.join(', tts.gemini.')} but the admin `
      + 'save block omits it. It would render and hydrate and then be discarded on every '
      + 'save — add it to GEMINI_SAVE_KEYS and to buildGeminiSaveBlock.',
  );
});

test('the admin form sends no gemini field the update path would reject', () => {
  // The other direction: an unknown key is dropped by the lenient load path but
  // is a shape the update chokepoint never writes, so it is either ignored or a
  // 400 depending on which validator sees it. Either way it is a typo.
  const accepted = geminiSaveFields();
  const extra = webSaveKeys().filter((f) => !accepted.includes(f));
  assert.deepEqual(
    extra, [],
    `the admin save block sends tts.gemini.${extra.join(', tts.gemini.')} but the update `
      + 'path has no handler for it.',
  );
});

test('DEFAULTS carries every gemini field the update path accepts', () => {
  // A field with no default hydrates as undefined on a station that never set
  // it, which is how the form's `?? ''` chain quietly becomes load-bearing.
  const defaults = Object.keys(DEFAULTS.tts.gemini).sort();
  const accepted = geminiSaveFields();
  const missing = accepted.filter((f) => !defaults.includes(f as never));
  assert.deepEqual(
    missing, [],
    `tts.gemini.${missing.join(', tts.gemini.')} is accepted on save but has no DEFAULTS entry, `
      + 'so it hydrates as undefined and reads as blank.',
  );
});

test('libraryLanguage is reachable end to end', () => {
  // The specific regression, named rather than left to the generic guards above,
  // because it shipped once already and the generic guards are new.
  const accepted = geminiSaveFields();
  const sent = webSaveKeys();
  const defaults = Object.keys(DEFAULTS.tts.gemini);
  assert.ok(accepted.includes('libraryLanguage'), 'update() no longer accepts libraryLanguage');
  assert.ok(sent.includes('libraryLanguage'), 'the admin save block no longer sends it');
  assert.ok(defaults.includes('libraryLanguage'), 'DEFAULTS lost libraryLanguage');
  assert.equal(DEFAULTS.tts.gemini.libraryLanguage, '',
    'the default must be blank — a non-blank default would silently filter every browse');
});