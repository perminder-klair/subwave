import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGeminiSaveBlock } from '../components/admin/settings/geminiSavePayload';

// `libraryLanguage` shipped on this screen looking entirely functional: the
// control rendered, hydrated from the saved value, and the schema accepted it
// on the way back. It was inert because `save()` REBUILDS the gemini block and
// never named the field — so every save silently discarded the operator's
// choice. These tests pin the payload, and the last one exists so the next
// field added to the schema cannot repeat it.

test('the save block carries every gemini field the form holds', () => {
  const block = buildGeminiSaveBlock({
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    pronunciation: 'Subwave',
    libraryLanguage: 'en-AU',
  });

  // Each key is asserted individually rather than by deepEqual against a literal:
  // deepEqual would pass just as happily with a key REMOVED from the builder, as
  // long as both sides drifted together. Naming each one makes a drop visible.
  assert.equal(block.model, 'gemini-3.8-flash-tts');
  assert.equal(block.voice, 'Kore');
  assert.equal(block.pronunciation, 'Subwave');
  assert.equal(
    block.libraryLanguage, 'en-AU',
    'libraryLanguage must reach the wire — this field was silently dropped on save',
  );
});

test('absent fields fall back to the server defaults rather than vanishing', () => {
  const block = buildGeminiSaveBlock(undefined);
  assert.equal(block.model, '', "'' means 'walk the fallback chain', not 'server decides'");
  assert.equal(block.voice, 'Puck');
  assert.equal(block.pronunciation, '');
  // '' here means "no station-wide default" → every language in the browser.
  // Sending undefined would make the route keep applying the saved value, so an
  // operator clearing the field would see it reappear.
  assert.equal(block.libraryLanguage, '');
});

test('a partially filled form does not lose the fields it did fill', () => {
  const block = buildGeminiSaveBlock({ libraryLanguage: 'en-GB' });
  assert.equal(block.libraryLanguage, 'en-GB');
  assert.equal(block.voice, 'Puck');
  assert.equal(block.model, '');
});

// NOTE ON THE OMISSION GUARD
// The obvious companion test — "the schema's gemini keys and the save keys
// agree" — is NOT written here, and that is deliberate. `libraryLanguage` is
// not a zod field: it is validated by a hand-rolled predicate in
// `controller/src/settings.ts`, so the generated mirror
// (`web/lib/schemas.generated.ts`) exports only the predicate and the length
// bound, never a gemini shape to compare against. A test written against
// something that does not exist either gets deleted or, worse, is written to
// pass against a stand-in that drifts.
//
// So the guard lives on the controller side instead, where BOTH halves of the
// claim are in one package: `scripts/gemini-save-contract.test.ts` pins
// `DEFAULTS.tts.gemini` against the fields the update chokepoint accepts, and
// names the web save block's key list as the set that has to be sent. What this
// file owns is the half only the browser can check: that the wire payload
// actually carries every one of them.