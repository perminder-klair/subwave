// Composes the fixed announce-mode link line in CODE rather than asking the
// model to produce it: a model cannot reliably hold to an exact fixed string,
// and it cannot alternate with a line it is never shown — the agent path
// writes the link before the pick after it airs, and the scripted path never
// carries the previous link forward at all. Per the station's own posture (fix
// shape in code, don't just instruct the model harder), both call sites
// compose the line here and only ask the model whether to speak.
//
// PURE — the alternation is derived from the line that last AIRED, handed in
// by the caller (queue.getLastLinkText(), written by onSpoken once the clip
// reached the stream). It used to be a module-level counter advanced at
// composition time, which is not the same thing: three routine paths consume a
// composed link without airing it — a model writing a `say` when the event
// ordered silence, trimLinkToIntro dropping the line on a track whose vocals
// enter under 2.5s, and enqueuePick refusing the pick (dedup / never-play) —
// and each one left the NEXT aired line repeating the form the listener had
// just heard ("This is A." … "This is C."). Anchoring on air truth cannot
// drift, and one shared sequence covers the whole air chain: the agent picker
// and the stateless pool picker are two code paths for the same on-air slot,
// and a listener hears one continuous sequence of links regardless of which
// produced each one.

// The composed frame is English, and only the model can write it in anything
// else — languageDirective (settings/persona.ts) binds the persona to speak
// exclusively in its own language, and code has no translation of "This is".
// Same field read as languageDirective's: unset means English.
const ENGLISH_LANGUAGE = /^english$/i;

// spokenProperNounDirective (settings/persona.ts) requires ZERO CJK characters
// in any spoken field and tells the model to romanize (ウルフルズ → Ulfuls,
// 周杰倫 → Jay Chou). A composed line interpolates the artist tag verbatim, so
// a name in one of these scripts has to go through the model or an English
// voice reads nothing at all. Hangul rides along for the same reason.
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
