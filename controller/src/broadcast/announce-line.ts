// Composes the fixed announce-mode link line in code; the model is only asked
// whether to speak. Both picker paths compose here so the listener hears one
// continuous alternation.
//
// PURE — the alternation is derived from the line that last AIRED (handed in by
// the caller), never from a composition-time counter: several paths compose a
// link without airing it, and a counter left the next aired line repeating the
// form the listener just heard.

// The composed frame is English; a persona bound to another language has to go
// through the model. Unset means English.
const ENGLISH_LANGUAGE = /^english$/i;

// A composed line interpolates the artist tag verbatim, so a name in one of
// these scripts has to go through the model (which romanizes) or an English
// voice reads nothing at all.
const NON_LATIN_NAME = new RegExp(
  '[\\u3000-\\u303f'   // CJK punctuation
  + '\\u3040-\\u30ff'  // hiragana + katakana
  + '\\u31f0-\\u31ff'  // katakana phonetic extensions
  + '\\u3400-\\u4dbf'  // CJK unified ideographs extension A
  + '\\u4e00-\\u9fff'  // CJK unified ideographs
  + '\\uac00-\\ud7af'  // hangul syllables
  + '\\uf900-\\ufaff'  // CJK compatibility ideographs
  + '\\uff65-\\uff9f]' // halfwidth katakana
);

export type AnnounceForm = 'this-is' | 'next-up';

/**
 * The form that follows `lastLine` — the previous link exactly as it AIRED.
 * Anything that isn't one of the two forms (a natural link from before the
 * operator flipped the style, or nothing aired yet) starts the sequence.
 */
export function nextAnnounceForm(lastLine?: string | null): AnnounceForm {
  const prev = String(lastLine ?? '').replace(/^["'\s]+/, '').toLowerCase();
  if (prev.startsWith('next up')) return 'this-is';
  if (prev.startsWith('this is')) return 'next-up';
  return 'this-is';
}

export interface AnnounceLineOptions {
  /** The between-track link that last aired, for the alternation. */
  lastLine?: string | null;
  /** True when `artist` is the track ALREADY playing (the /dj/segment link
   *  button airs over it) rather than the pick about to start — "Next up" is a
   *  false claim there, so the form is pinned to "This is". */
  currentIsOnAir?: boolean;
}

/**
 * `This is <artist>.` or `Next up, <artist>.` — or `''` when the station
 * cannot compose the line itself and the model has to write it: no artist to
 * name, a persona that speaks something other than English, or an artist tag
 * in a script an English frame can't carry. `''` is the caller's signal to
 * fall back, never a line to air.
 */
export function announceLine(
  artist: unknown,
  persona: unknown,
  { lastLine = null, currentIsOnAir = false }: AnnounceLineOptions = {},
): string {
  const trimmed = String(artist ?? '').trim();
  if (!trimmed || NON_LATIN_NAME.test(trimmed)) return '';
  const language = String(
    (persona as { language?: unknown } | null | undefined)?.language ?? '',
  ).trim();
  if (language && !ENGLISH_LANGUAGE.test(language)) return '';
  const form = currentIsOnAir ? 'this-is' : nextAnnounceForm(lastLine);
  return form === 'this-is' ? `This is ${trimmed}.` : `Next up, ${trimmed}.`;
}
