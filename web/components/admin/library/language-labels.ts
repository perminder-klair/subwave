const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

// Language tags are ISO 639-3 codes from the library database. ICU knows the
// full catalogue, so the UI does not need a hand-maintained list of languages.
// A code is still a useful fallback when a browser's ICU data is incomplete.
export function languageLabel(code: string): string {
  if (code === 'zxx') return 'Instrumental';
  try {
    return languageNames.of(code) || code;
  } catch {
    return code;
  }
}
