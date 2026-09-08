// Final script boundary for booth-bound English speech. English espeak reads
// leaked CJK codepoints as literal character classes ("Japanese letter"), so
// this fails safe when generation did not. A scrub, not a transliterator: the
// model owns the canonical Latin name. Non-English personas are untouched.

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const ENGLISH_RE = /^english(?:\b|\s|[-_(])/i;

export function cjkUnsafeForSpokenLanguage(language: unknown): boolean {
  const lang = String(language || '').trim();
  // An unset persona language is the product's long-standing English default.
  return !lang || ENGLISH_RE.test(lang);
}

export function scrubCjkForSpeech(text: string, language: unknown): string {
  if (!text || !cjkUnsafeForSpokenLanguage(language) || !CJK_RE.test(text)) return text;
  CJK_RE.lastIndex = 0;
  return text
    .replace(CJK_RE, '')
    .replace(/\b(?:with|by)\s*([,.;:!?])/gi, '$1')
    .replace(/([!?])\1+/g, '$1')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
