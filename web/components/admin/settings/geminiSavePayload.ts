// Explicit Gemini save keys omit unsupported fields. The round-trip test checks that every schema field is sent.

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

/** Explicit blanks select the model fallback chain, clear pronunciation notes, and clear the
 * library-language default. Omitting them would preserve saved values. Puck matches the server
 * voice default. */
export function buildGeminiSaveBlock(input: GeminiSaveInput | undefined): GeminiSaveBlock {
  return {
    model: input?.model ?? '',
    voice: input?.voice ?? 'Puck',
    pronunciation: input?.pronunciation ?? '',
    libraryLanguage: input?.libraryLanguage ?? '',
  };
}