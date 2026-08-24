// Final script boundary for booth-bound English speech.
//
// The DJ prompt asks the model to turn CJK artist/title names into their
// established Latin form. Models can still occasionally echo one native
// character or a full native spelling. English espeak then reads those
// codepoints as literal character classes ("Japanese letter"), so the TTS
// boundary must fail safe even when generation did not. This is deliberately
// a scrub, not a transliterator: the model owns the good, canonical name;
// this last line of defence only prevents leaked codepoints reaching a voice
// that cannot pronounce them. Explicitly non-English personas are untouched.

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
