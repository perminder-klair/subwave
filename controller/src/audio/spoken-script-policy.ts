// Final script boundary for booth-bound English speech. English espeak reads
// leaked CJK codepoints as literal character classes ("Japanese letter"), so
// this fails safe when generation did not. A scrub, not a transliterator: the
// model owns the canonical Latin name. Non-English personas are untouched.
//
// A multilingual persona (`alsoSpeaks`) is judged by its primary language, and
// the scrub stands down only when a mixed-in language is itself WRITTEN in CJK
// script: English + Japanese keeps its kana, but English + Spanish on a local
// English voice is still protected. Matched by name (English or native), so an
// unrecognised mix language keeps the safety net rather than dropping it.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const ENGLISH_RE = /^english(?:\b|\s|[-_(])/i;
// A CJK language named anywhere in the entry, as a whole word ("Traditional
// Chinese", "Mandarin Chinese"), or a whole-entry code with an optional region
// or script subtag (`zh`, `zh-TW`, `zh-Hant`, `ja-JP`, `ko_KR`). No misspellings.
const CJK_LANGUAGE_RE = /(?<![a-z])(?:japanese|nihongo|chinese|mandarin|cantonese|putonghua|taiwanese|hokkien|hakka|shanghainese|korean|hangugeo)(?![a-z])/i;
const CJK_CODE_RE = /^(?:zh|ja|ko)(?:[-_][a-z0-9]{2,8})*$/i;
const CJK_NAME_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function cjkWrittenLanguage(language: unknown): boolean {
  const lang = String(language || '').trim();
  return CJK_LANGUAGE_RE.test(lang) || CJK_CODE_RE.test(lang) || CJK_NAME_RE.test(lang);
}

export function cjkUnsafeForSpokenLanguage(language: unknown, mix: readonly unknown[] = []): boolean {
  const lang = String(language || '').trim();
  // An unset persona language is the product's long-standing English default.
  return (!lang || ENGLISH_RE.test(lang)) && !mix.some(cjkWrittenLanguage);
}

export function scrubCjkForSpeech(text: string, language: unknown, mix: readonly unknown[] = []): string {
  if (!text || !cjkUnsafeForSpokenLanguage(language, mix) || !CJK_RE.test(text)) return text;
  CJK_RE.lastIndex = 0;
  return text
    .replace(CJK_RE, '')
    .replace(/\b(?:with|by)\s*([,.;:!?])/gi, '$1')
    .replace(/([!?])\1+/g, '$1')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
