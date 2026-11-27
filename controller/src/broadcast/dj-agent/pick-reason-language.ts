// Which language a pick's note is written in, and the forms a note takes when
// it is not English. One place decides both, for every pick route (Agentic,
// Track Shortlist and its Musical Leanings review, and the pool).
//
// A pick note is the Booth's "pick" line and the next Agentic pick's memory of
// its own choice; it is never aired. It follows the on-air persona's PRIMARY
// language (settings.personaLanguages, the one reader of the field), judged by
// isEnglishSpeech below, so "English", "en", "en-GB", "English (UK)" and an
// unset language all count as English. `null` means English, and on that path every prompt and every
// controller-written sentence is byte-identical to what it was before notes
// followed the persona.
//
// For another language the model is told to write the note in it, keeping
// titles and artist names exactly as given: they are what the grounding checks
// (leanings-review.ts agenticSelectionReason, pick-note.ts groundPickNote)
// match on. The controller then adds no English words of its own. The English
// rewrites ("“Title” by Artist — fits …"), the English plain copy ("… offers a
// strong musical fit with the current flow.") and the English clause floors are
// replaced by the credit alone, in the Booth's own display form: `“Title” —
// Artist`, followed by the model's note after a colon when it has one.
//
// The English scrubs on these paths (QUEUE_LANGUAGE, LEANINGS_REFERENCE, the
// Shortlist's BACKSTAGE_LANGUAGE) still run on a non-English note, but they can
// only catch English leaking into it: an English regex cannot see "à suivre" or
// "το γούστο του DJ". They never match ordinary words of another language, so a
// non-English note is not dropped by them. The one that would (the Shortlist's
// first-person check: "me" is French, Spanish and Italian, "i" is an Italian
// article) is English-only, by isEnglishNote below.

import * as settings from '../../settings.js';

/** True for an English (or unset) language name or tag: "English", "en", "en-GB", "English (UK)". */
export function isEnglishSpeech(language: unknown): boolean {
  if (language == null) return true;
  if (typeof language !== 'string') return false;
  const t = language.trim().toLowerCase();
  if (!t) return true;
  return t === 'en' || t.startsWith('en-') || t.startsWith('en_') || t.startsWith('english');
}

/** A pick note's language: `null` for English, else the persona's primary language as written. */
export type PickNoteLanguage = string | null;

export function pickNoteLanguage(persona: unknown): PickNoteLanguage {
  const { primary } = settings.personaLanguages(persona);
  return isEnglishSpeech(primary) ? null : primary;
}

export function isEnglishNote(language: PickNoteLanguage | undefined): boolean {
  return !language;
}

// The prompt clause, appended LAST to the pick call it belongs to (the same
// placement the agents' language reminder found necessary, #558): the English
// field descriptions sit right beside the output and otherwise win. '' for
// English, so those prompts stay byte-identical. `fields` names the note field.
export function pickNoteLanguageClause(language: PickNoteLanguage | undefined, fields: string): string {
  if (isEnglishNote(language)) return '';
  return `\n\nNOTE LANGUAGE — this overrides the English wording rules in the field descriptions (such as beginning with "its" or "it"): write ${fields} in ${language}. Any track title or artist name you use stays exactly as it is written in the data, never translated or transliterated.`;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// The verified identity a controller-written note opens with.
export function creditedTrack(track: { title?: unknown; artist?: unknown } | null | undefined, language: PickNoteLanguage | undefined): string {
  const title = str(track?.title);
  const artist = str(track?.artist);
  if (isEnglishNote(language)) {
    return title && artist ? `“${title}” by ${artist}` : title ? `“${title}”` : artist ? `A track by ${artist}` : '';
  }
  return title && artist ? `“${title}” — ${artist}` : title ? `“${title}”` : artist;
}

// The note a pick falls back to when the model's own cannot be grounded on the
// track. English keeps its sentence; any other language gets the credit alone.
export function plainPickNote(track: { title?: unknown; artist?: unknown } | null | undefined, language: PickNoteLanguage | undefined): string {
  const credited = creditedTrack(track, language);
  if (!isEnglishNote(language)) return credited;
  return credited ? `${credited} offers a strong musical fit with the current flow.` : 'Selected for its strong musical fit with the current flow.';
}

const ENGLISH_END = /[.!?]$/;
const ANY_END = /[.!?。！？…؟।]$/u;
// Han, kana and Hangul: dense scripts, which also take no Latin full stop.
const DENSE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// A model note closed with its own punctuation. A non-English note may end in
// a full stop of its own script ("。", "؟"), which never takes a second one,
// and a note ending in a dense script is left unclosed rather than given ".".
export function terminatedNote(note: string, language: PickNoteLanguage | undefined): string {
  if (isEnglishNote(language)) return ENGLISH_END.test(note) ? note : `${note}.`;
  return ANY_END.test(note) || DENSE_SCRIPT.test(note.slice(-1)) ? note : `${note}.`;
}

// The credit joined to the model's note: "“T” by A — note." in English, and
// "“T” — A: note" in any other language, so the dash never doubles.
export function creditedNote(credited: string, note: string, language: PickNoteLanguage | undefined): string {
  return isEnglishNote(language)
    ? `${credited} — ${terminatedNote(note, language)}`
    : `${credited}: ${terminatedNote(note, language)}`;
}

// The length floors that keep a vacuous note out of the Booth were set on
// English characters. A Han, kana or Hangul character carries about a word's
// worth of text, so on a non-English note each counts twice; English is
// measured as it always was.
export function noteLength(note: string, language: PickNoteLanguage | undefined): number {
  if (isEnglishNote(language)) return note.length;
  let n = 0;
  for (const ch of note) n += DENSE_SCRIPT.test(ch) ? 2 : 1;
  return n;
}

// Name matching for a non-English note. The English comparison keeps a-z and
// 0-9 only, which reads a Greek or Japanese name as empty, i.e. as named by
// any note. This one keeps every letter and digit, drops accents (Greek tonos
// included) and folds the final sigma, so "θάλασσα" names "ΘΆΛΑΣΣΑ".
export function unicodeComparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/ς/g, 'σ')
    .replace(/\bfeaturing\b/g, 'feat').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
