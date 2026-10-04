// The `tts.gemini` block sent by `TtsSection`'s save.
//
// WHY THIS IS A MODULE AND NOT AN INLINE OBJECT
// ---------------------------------------------
// `save()` REBUILDS the gemini block field by field rather than spreading the
// form. That shape is deliberate — it drops keys the schema does not accept and
// pins the "no value means blank, not inherit" choices — but it has one sharp
// edge: a field that is not named here is not merely unsaved, it is SILENTLY
// DROPPED, while still hydrating and rendering perfectly. That is exactly how
// `libraryLanguage` shipped inert (editable, round-tripped through the schema,
// never sent) and how `voiceStyle` was once wiped on every persona save.
//
// Naming every field in a component is not a testable claim. Naming it here is,
// so the omissions are enumerable: `GEMINI_SAVE_KEYS` is the list, and the
// round-trip test below fails if the schema grows a field this omits.

export interface GeminiSaveInput {
  model?: string;
  voice?: string;
  pronunciation?: string;
  libraryLanguage?: string;
}

export interface GeminiSaveBlock {
  model: string;
  voice: string;
  pronunciation: string;
  libraryLanguage: string;
}

/** Every key this block sends. The save-payload test asserts the schema's
 *  gemini keys and this list agree, so a new schema field cannot ship unsaved. */
export const GEMINI_SAVE_KEYS = [
  'model', 'voice', 'pronunciation', 'libraryLanguage',
] as const;

/**
 * Build the save block from the hydrated form.
 *
 * The `?? ''` defaults are load-bearing, and each one is a DIFFERENT choice:
 *  - `model: ''` is the "walk the fallback chain" option, not a blank field for
 *    the server to fill in. Sending `undefined` would make the server default it
 *    and the operator could never turn the fallback off.
 *  - `voice: 'Puck'` matches the server's own default, so a station that never
 *    touched the field saves back what it was already using.
 *  - `pronunciation: ''` is no pronunciation notes, which IS the default for
 *    every station, and must survive rather than be dropped as absent.
 *  - `libraryLanguage: ''` means "no station-wide default" — every language in
 *    the browser. Omitting it would make the route keep applying whatever is
 *    already saved, so the operator's clear button would read as broken.
 */
export function buildGeminiSaveBlock(input: GeminiSaveInput | undefined): GeminiSaveBlock {
  return {
    model: input?.model ?? '',
    voice: input?.voice ?? 'Puck',
    pronunciation: input?.pronunciation ?? '',
    libraryLanguage: input?.libraryLanguage ?? '',
  };
}