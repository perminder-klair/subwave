import { transliterate } from 'transliteration';
import { iso6393 } from 'iso-639-3';
import ianaRegistry from 'language-subtag-registry/data/json/registry.json' with { type: 'json' };

export type RequestEnergy = 'low' | 'medium' | 'high';

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

const LANGUAGE_ALIASES: Record<string, string> = {
  // Common Indian-language spellings and scripts. CLDR names cover the rest.
  hindi: 'hi', 'हिंदी': 'hi', hin: 'hi',
  punjabi: 'pa', 'ਪੰਜਾਬੀ': 'pa', panjabi: 'pa', pa: 'pa',
  bengali: 'bn', 'বাংলা': 'bn', bangla: 'bn', bn: 'bn',
  tamil: 'ta', 'தமிழ்': 'ta', ta: 'ta',
  telugu: 'te', 'తెలుగు': 'te', te: 'te',
  marathi: 'mr', 'मराठी': 'mr', mr: 'mr',
  gujarati: 'gu', 'ગુજરાતી': 'gu', gu: 'gu',
  kannada: 'kn', 'ಕನ್ನಡ': 'kn', kn: 'kn',
  malayalam: 'ml', 'മലയാളം': 'ml', ml: 'ml',
  urdu: 'ur', 'اردو': 'ur', ur: 'ur',
  english: 'en', en: 'en',
  french: 'fr', français: 'fr', francais: 'fr', frances: 'fr', fr: 'fr',
  german: 'de', deutsch: 'de', de: 'de',
  spanish: 'es', español: 'es', espanol: 'es', es: 'es',
  italian: 'it', italiano: 'it', it: 'it',
  portuguese: 'pt', português: 'pt', portugues: 'pt', pt: 'pt',
  russian: 'ru', русский: 'ru', ru: 'ru',
  arabic: 'ar', العربية: 'ar', ar: 'ar',
  japanese: 'ja', 日本語: 'ja', ja: 'ja',
  korean: 'ko', 한국어: 'ko', ko: 'ko',
  chinese: 'zh', mandarin: 'zh', 中文: 'zh', zh: 'zh', cantonese: 'yue', yue: 'yue',
  turkish: 'tr', türkçe: 'tr', turkce: 'tr', tr: 'tr',
  haryanvi: 'bgc', hariyanvi: 'bgc', haryanavi: 'bgc', bgc: 'bgc',
  bhojpuri: 'bho', bhojpuriya: 'bho', bho: 'bho',
  maithili: 'mai', mai: 'mai', konkani: 'kok', kok: 'kok',
};

const MOOD_ALIASES: Record<string, string> = {
  energetic: 'energetic', energy: 'energetic', upbeat: 'energetic', pumped: 'energetic',
  lively: 'energetic', hype: 'energetic', josh: 'energetic', 'जोश': 'energetic',
  calm: 'calm', chill: 'calm', relaxing: 'calm', relaxed: 'calm', peaceful: 'calm',
  shaant: 'calm', shant: 'calm', 'शांत': 'calm', 'ਸ਼ਾਂਤ': 'calm',
  reflective: 'reflective', thoughtful: 'reflective', melancholy: 'reflective', sad: 'reflective',
  romantic: 'romantic', love: 'romantic', romance: 'romantic',
  celebratory: 'celebratory', celebration: 'celebration', party: 'celebratory', festive: 'celebratory',
  spiritual: 'spiritual', devotional: 'spiritual', bhajan: 'spiritual', kirtan: 'spiritual',
  focus: 'focus', study: 'focus', work: 'focus', concentration: 'focus',
  workout: 'workout', gym: 'workout', exercise: 'workout', running: 'workout',
  driving: 'driving', roadtrip: 'driving', 'road trip': 'driving',
  cooking: 'cooking', rainy: 'rainy', rain: 'rainy', sunny: 'sunny',
  night: 'night', midnight: 'night', morning: 'morning', evening: 'evening',
  festival: 'festival', cultural: 'cultural', diwali: 'festival', holi: 'festival', vaisakhi: 'festival',
};

const ENERGY_ALIASES: Record<string, RequestEnergy> = {
  low: 'low', mellow: 'low', slow: 'low', soft: 'low', gentle: 'low', chill: 'low', relaxed: 'low',
  medium: 'medium', moderate: 'medium', mid: 'medium', balanced: 'medium', steady: 'medium',
  high: 'high', energetic: 'high', upbeat: 'high', pumped: 'high', lively: 'high', intense: 'high',
};

const GENRE_ALIASES: Record<string, string> = {
  rock: 'rock', pop: 'pop', jazz: 'jazz', blues: 'blues', soul: 'soul', rap: 'rap', hiphop: 'hip hop',
  'hip hop': 'hip hop', rnb: 'r&b', 'r&b': 'r&b', metal: 'metal', punk: 'punk', folk: 'folk', country: 'country',
  classical: 'classical', electronic: 'electronic', dance: 'dance', house: 'house', techno: 'techno', trance: 'trance',
  disco: 'disco', reggae: 'reggae', afrobeats: 'afrobeats', indie: 'indie', lofi: 'lofi', 'lo fi': 'lofi',
  bhangra: 'bhangra', bollywood: 'bollywood', devotional: 'devotional', gospel: 'gospel', soundtrack: 'soundtrack',
  kpop: 'k-pop', 'k pop': 'k-pop', jpop: 'j-pop', 'j pop': 'j-pop', punjabi: 'punjabi',
};

// Keep lyric-cue ownership in the normalizer. The request matcher imports this
// same expression when deciding whether a framed request needs evidence.
export const LYRIC_CUE = /\b(?:lyrics?|words?|line\s+from|verse|song\s+goes|sung\s+by|gane\s+ke\s+bol|gaane\s+ke\s+bol|gane\s+ke\s+lyrics|gaane\s+ke\s+lyrics|geet\s+ke\s+bol)\b/iu;
const LANGUAGE_CUE = /(?:^|\s)(?:in|en|de|में|ਵਿੱਚ)\s+([\p{L}][\p{L} -]*?)(?:[.!?]*$|\s)/iu;
export const GREETING_CUE = /^(?:hello|hi|hey|how are you|whats up|good morning|good evening)\b/iu;
const GENERIC_REQUEST_CUE = /^(?:surprise|anything|something|music)(?:\s+(?:me|dj|radio|there|subwave|chill\s+zone))?$/iu;

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function requestName(value: unknown): string {
  return compact(String(value ?? '')
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[’‘']/g, '')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' '));
}

// Whether requestName()-normalised text names a normalised value as whole
// words. A raw substring test finds the title "One" inside "Someone".
export function requestNameWithin(text: string, value: string): boolean {
  return !!value && ` ${text} `.includes(` ${value} `);
}

export function transliteratedRequestName(value: unknown): string {
  try {
    return requestName(transliterate(String(value ?? '')));
  } catch {
    return requestName(value);
  }
}

export function requestNameVariants(value: unknown): string[] {
  const original = requestName(value);
  const translit = transliteratedRequestName(value);
  return [...new Set([original, translit].filter(Boolean))];
}

// Keep the request surface open to every current ISO 639-3 entry. The
// registry supplies code, ISO 639-1/2 aliases and names, so adding support
// for another community or historical language does not require editing this
// file.
const ISO6393_BY_NAME = new Map<string, string>();
for (const language of iso6393) {
  for (const value of [language.name, language.iso6393, language.iso6391, language.iso6392B, language.iso6392T]) {
    if (value) ISO6393_BY_NAME.set(requestName(value), language.iso6393);
  }
}

export function resolveLanguageCode(value: unknown, options: { allowFuzzy?: boolean; allowEmbedded?: boolean } = {}): string | undefined {
  const names = requestNameVariants(value);
  for (const name of names) {
    const explicit = LANGUAGE_ALIASES[name];
    if (explicit) return explicit;
    const registryMatch = ISO6393_BY_NAME.get(name);
    if (registryMatch) return registryMatch;
    const fuzzy = options.allowFuzzy === false ? undefined : fuzzyLanguageCode(name);
    if (fuzzy) return fuzzy;
    // ISO codes are accepted when the whole value is the code. A two-letter
    // alias must not be found inside prose: French "de", Spanish "en", and
    // similar words are ordinary prepositions, not language evidence.
    if (options.allowEmbedded !== false) {
      const token = name.split(' ').find(word => word.length > 2 && LANGUAGE_ALIASES[word]);
      if (token) return LANGUAGE_ALIASES[token];
    }
  }
  return undefined;
}

export function languageTerms(value: unknown): string[] {
  const code = resolveLanguageCode(value);
  const canonical = canonicalLanguage(value);
  if (!code && !canonical) return requestNameVariants(value);
  const terms = new Set<string>([...requestNameVariants(value), code, canonical].filter(Boolean) as string[]);
  // Include every explicit alias for the resolved code. This covers common
  // spellings that Intl.DisplayNames does not emit, such as francais,
  // espanol, deutsch, and transliterated regional names.
  for (const [alias] of Object.entries(LANGUAGE_ALIASES)) {
    if (canonicalLanguage(alias) === canonical) for (const variant of requestNameVariants(alias)) terms.add(variant);
  }
  const registryName = iso6393.find(language => language.iso6393 === canonical)?.name;
  if (registryName) {
    for (const variant of requestNameVariants(registryName)) terms.add(variant);
  }
  for (const locale of ['en', 'hi', 'pa', 'bn', 'ta', 'te', 'mr', 'ur']) {
    try {
      const label = new Intl.DisplayNames([locale], { type: 'language' }).of((code || canonical)!);
      if (label) for (const variant of requestNameVariants(label)) terms.add(variant);
    } catch {
      // A missing ICU locale must not make local matching fail.
    }
  }
  return [...terms];
}

export function resolveRequestMood(value: unknown, allowed: readonly string[] = []): string | null {
  const names = requestNameVariants(value);
  const allowedNames = new Map(allowed.map(mood => [requestName(mood), mood]));
  for (const name of names) {
    const canonical = MOOD_ALIASES[name] || name;
    const allowedMood = allowedNames.get(requestName(canonical));
    if (allowedMood) return allowedMood;
    if (Object.prototype.hasOwnProperty.call(MOOD_ALIASES, name)) return MOOD_ALIASES[name];
    const token = name.split(' ').find(word => MOOD_ALIASES[word]);
    if (token) return MOOD_ALIASES[token];
  }
  return null;
}

export function resolveRequestEnergy(value: unknown): RequestEnergy | null {
  const names = requestNameVariants(value);
  for (const name of names) {
    if (ENERGY_ALIASES[name]) return ENERGY_ALIASES[name];
    if (name.includes('high energy') || name.includes('full power')) return 'high';
    if (name.includes('low energy') || name.includes('easy listening')) return 'low';
    if (name.includes('medium energy')) return 'medium';
    const token = name.split(' ').find(word => ENERGY_ALIASES[word]);
    if (token) return ENERGY_ALIASES[token];
  }
  return null;
}

export function resolveRequestGenre(value: unknown): string | null {
  const names = requestNameVariants(value);
  for (const name of names) {
    const compactName = name.replace(/\s+/g, ' ');
    if (GENRE_ALIASES[compactName]) return GENRE_ALIASES[compactName];
    const token = compactName.split(' ').find(word => GENRE_ALIASES[word]);
    if (token) return GENRE_ALIASES[token];
  }
  return null;
}

export function languageDisplayName(value: unknown): string | null {
  const code = resolveLanguageCode(value);
  if (!code) return null;
  const canonical = canonicalLanguage(value);
  return displayNames.of(code) || displayNames.of(canonical || code) || iso6393.find(language => language.iso6393 === canonical)?.name || null;
}

export function hasRequestLanguage(text: string): boolean {
  const match = text.match(LANGUAGE_CUE);
  return !!match && !!resolveLanguageCode(match[1]);
}

export function isGreetingLikeRequest(text: string): boolean {
  return GREETING_CUE.test(requestName(text));
}

export function isGenericRequestPhrase(text: string): boolean {
  return GENERIC_REQUEST_CUE.test(requestName(text));
}

// The library tagger stores ISO 639-3 values, while speech recognition and
// Intl.DisplayNames usually produce ISO 639-1 values. Keep this conversion at
// the boundary so every supported language, including regional languages, can
// use the same request and library indexes.
const ISO6393: Record<string, string> = {
  aa: 'aar', ab: 'abk', af: 'afr', am: 'amh', ar: 'ara', as: 'asm', az: 'aze', ba: 'bak',
  be: 'bel', bg: 'bul', bn: 'ben', bo: 'bod', br: 'bre', bs: 'bos', ca: 'cat', cs: 'ces',
  cy: 'cym', da: 'dan', de: 'deu', el: 'ell', en: 'eng', es: 'spa', et: 'est', eu: 'eus',
  fa: 'fas', fi: 'fin', fil: 'fil', fj: 'fij', fo: 'fao', fr: 'fra', fy: 'fry', ga: 'gle',
  gd: 'gla', gl: 'glg', gu: 'guj', ha: 'hau', he: 'heb', hi: 'hin', hr: 'hrv', hu: 'hun',
  hy: 'hye', id: 'ind', is: 'isl', it: 'ita', ja: 'jpn', jv: 'jav', ka: 'kat', kk: 'kaz',
  km: 'khm', kn: 'kan', ko: 'kor', ku: 'kur', ky: 'kir', la: 'lat', lb: 'ltz', lo: 'lao',
  lt: 'lit', lv: 'lav', mg: 'mlg', mi: 'mri', mk: 'mkd', ml: 'mal', mn: 'mon', mr: 'mar',
  ms: 'msa', mt: 'mlt', my: 'mya', ne: 'nep', nl: 'nld', no: 'nor', oc: 'oci', om: 'orm',
  or: 'ori', pa: 'pan', pl: 'pol', ps: 'pus', pt: 'por', ro: 'ron', ru: 'rus', rw: 'kin',
  sa: 'san', sd: 'snd', si: 'sin', sk: 'slk', sl: 'slv', so: 'som', sq: 'sqi', sr: 'srp',
  su: 'sun', sv: 'swe', sw: 'swa', ta: 'tam', te: 'tel', tg: 'tgk', th: 'tha', tk: 'tuk',
  tl: 'tgl', tr: 'tur', tt: 'tat', ug: 'uig', uk: 'ukr', ur: 'urd', uz: 'uzb', vi: 'vie',
  wo: 'wol', xh: 'xho', yi: 'yid', yo: 'yor', zh: 'zho', zu: 'zul', yue: 'yue',
  bgc: 'bgc', bho: 'bho', mai: 'mai', kok: 'kok', hne: 'hne',
};
const ISO6393_CODES = new Set(Object.values(ISO6393));

// The complete registry makes language matching extensible without a hand-
// maintained list of every language name. IANA macrolanguage membership is
// used only for an explicitly requested macrolanguage; named members remain
// exact and do not broaden to the parent language.
const ISO6393_BY_ALIAS = new Map<string, string>();
for (const language of iso6393) {
  for (const value of [language.iso6391, language.iso6392B, language.iso6392T]) {
    if (value) ISO6393_BY_ALIAS.set(requestName(value), language.iso6393);
  }
}
type IanaLanguageRecord = { Type?: string; Subtag?: string; Macrolanguage?: string };
const ianaToIso6393 = new Map<string, string>();
for (const language of iso6393) {
  for (const value of [language.iso6391, language.iso6392B, language.iso6392T, language.iso6393]) {
    if (value) ianaToIso6393.set(value.toLowerCase(), language.iso6393);
  }
}
const languageFamilies = new Map<string, Set<string>>();
for (const record of (ianaRegistry as IanaLanguageRecord[])) {
  if (record.Type !== 'language' || !record.Subtag || !record.Macrolanguage) continue;
  const member = ianaToIso6393.get(record.Subtag.toLowerCase());
  const macro = ianaToIso6393.get(record.Macrolanguage.toLowerCase());
  if (!member || !macro) continue;
  const family = languageFamilies.get(macro) || new Set<string>([macro]);
  family.add(member);
  languageFamilies.set(macro, family);
}

function fuzzyLanguageCode(value: string): string | undefined {
  if (value.length < 4 || value.length > 32) return undefined;
  const candidates = [...ISO6393_BY_NAME.entries()]
    .filter(([name]) => name.length >= 4)
    .map(([name, code]) => ({ name, code, distance: levenshtein(value, name) }))
    .filter(candidate => candidate.distance <= Math.max(1, Math.floor(candidate.name.length * 0.2)))
    .sort((a, b) => a.distance - b.distance || a.name.length - b.name.length || a.code.localeCompare(b.code));
  if (!candidates.length) return undefined;
  const best = candidates[0]!;
  const tied = candidates.filter(candidate => candidate.distance === best.distance
    && candidate.name.length === best.name.length && candidate.code !== best.code);
  return tied.length ? undefined : best.code;
}

export function canonicalLanguage(value: unknown, options: { allowFuzzy?: boolean; allowEmbedded?: boolean } = {}): string | undefined {
  const raw = requestName(value);
  if (!raw) return undefined;
  if (raw === 'und' || raw === 'xxx' || raw === 'zxx') return raw;
  if (ISO6393[raw]) return ISO6393[raw];
  if (ISO6393_CODES.has(raw)) return raw;
  const registryCode = ISO6393_BY_NAME.get(raw) || ISO6393_BY_ALIAS.get(raw)
    || (options.allowFuzzy === false ? undefined : fuzzyLanguageCode(raw));
  if (registryCode) return registryCode;
  if (/^[a-z]{3}$/u.test(raw) && ISO6393_CODES.has(raw)) return raw;
  const two = resolveLanguageCode(raw, options);
  return two ? ISO6393[two] ?? two : undefined;
}

/**
 * Return the ISO 639-3 codes accepted by a request. A macrolanguage request
 * includes its official IANA member languages; a named member or dialect
 * remains exact so "Egyptian Arabic" cannot silently broaden to all Arabic.
 */
export function requestLanguageCodes(value: unknown): string[] {
  const canonical = canonicalLanguage(value);
  if (!canonical) return [];
  return [...(languageFamilies.get(canonical) || new Set([canonical]))].sort();
}

export interface RequestLanguageSpan {
  value: string;
  code: string;
  codes: string[];
  start: number;
  end: number;
}

const LANGUAGE_REQUEST_STOP_WORDS = new Set([
  'music', 'música', 'musique', 'musica', 'song', 'songs', 'track', 'tracks', 'genre', 'genres', 'style', 'styles',
  'language', 'languages', 'mood', 'energy', 'era', 'year', 'years', 'from', 'the',
  'in', 'en', 'de', 'and', 'or', 'some', 'something', 'anything', 'please',
]);

/** Find the longest recognised language phrase in normalized request prose. */
export function findRequestLanguageSpan(value: string, options: { allowBareCode?: boolean; allowFuzzy?: boolean } = {}): RequestLanguageSpan | null {
  const normalized = requestName(value);
  const tokens = normalized.split(' ').filter(Boolean);
  // Fuzzy language names are useful for speech typos such as "Hindii music",
  // but a bare one-word title such as "Daaku" must remain a title candidate.
  // Exact registry names and aliases stay available in either context.
  const fuzzyContext = options.allowFuzzy ?? (tokens.some(token => LANGUAGE_REQUEST_STOP_WORDS.has(token))
    || /\b(?:in|en|de|sung|spoken|vocals?)\b/iu.test(normalized));
  let best: RequestLanguageSpan | null = null;
  for (let start = 0; start < tokens.length; start++) {
    for (let length = Math.min(5, tokens.length - start); length >= 1; length--) {
      const candidate = tokens.slice(start, start + length).join(' ');
      if (length === 1 && LANGUAGE_REQUEST_STOP_WORDS.has(candidate)) continue;
      if (!options.allowBareCode && candidate.length <= 3 && /^[a-z]{2,3}$/u.test(candidate)) continue;
      // A request span must be a language name or alias in its entirety. The
      // metadata matcher may accept a language-bearing style tag such as
      // "Punjabi Pop", but request parsing must not consume the adjacent
      // genre and let it disappear from the listener's intent.
      const code = canonicalLanguage(candidate, { allowFuzzy: fuzzyContext, allowEmbedded: false });
      if (!code) continue;
      const prefix = tokens.slice(0, start).join(' ');
      const offset = prefix ? prefix.length + 1 : 0;
      const span = { value: candidate, code, codes: requestLanguageCodes(code), start: offset, end: offset + candidate.length };
      if (!best || span.value.length > best.value.length) best = span;
      break;
    }
  }
  return best;
}
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

export function requestTextSimilarity(want: unknown, got: unknown): number {
  const wanted = requestNameVariants(want);
  const actual = requestNameVariants(got);
  if (!wanted.length || !actual.length) return 0;
  let best = 0;
  for (const left of wanted) for (const right of actual) {
    if (left === right) best = Math.max(best, 1);
    const leftTokens = new Set(left.split(' ').filter(Boolean));
    const rightTokens = new Set(right.split(' ').filter(Boolean));
    const overlap = [...leftTokens].filter(token => rightTokens.has(token)).length;
    const tokenScore = Math.max(leftTokens.size, rightTokens.size) ? overlap / Math.max(leftTokens.size, rightTokens.size) : 0;
    const editScore = 1 - levenshtein(left.replace(/ /g, ''), right.replace(/ /g, ''))
      / Math.max(left.replace(/ /g, '').length, right.replace(/ /g, '').length, 1);
    // Token overlap protects word order and multi-word identities. The raw
    // edit score is also important for a single speech-recognition typo in a
    // longer title, where one misspelled token would otherwise dilute an
    // otherwise high-confidence identity.
    best = Math.max(best, tokenScore * 0.45 + editScore * 0.55, editScore);
  }
  return Math.max(0, Math.min(1, best));
}

export function looksLikeLyricRequest(text: string): boolean {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const content = text
    .replace(/^\s*(?:please\s+)?(?:play|request|queue|find|search\s+for|listen\s+to)\s+/iu, '')
    .trim();
  const normalized = requestName(content);
  const words = normalized.split(' ').filter(Boolean);
  let segmentedWords = words.length;
  // CJK and some native-script inputs commonly arrive without spaces. ICU's
  // word segmenter gives those requests the same lyric threshold without
  // weakening the title path for a single unspaced Latin token.
  try {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    segmentedWords = Math.max(segmentedWords, [...segmenter.segment(normalized)]
      .filter(segment => segment.isWordLike).length);
  } catch {
    // Older runtimes may lack Segmenter; the whitespace heuristic remains safe.
  }
  if (lines.length >= 2 || words.length >= 18 || segmentedWords >= 18) return true;

  // A listener may paste a short verse in transliterated Hindi or Punjabi.
  // English-only cues and an eighteen-word floor missed inputs such as
  // "chite suit te daag pai gaye gali teri vich gara". Keep explicit names
  // and attribute requests on the deterministic path, but treat a longer
  // free-form phrase as lyric evidence so the web resolver gets a chance.
  if (LYRIC_CUE.test(normalized)) return true;
  // Short comma and dash forms are commonly "title, artist" or "title -
  // artist" requests. Preserve those as named identities instead of sending
  // them through lyric search. Long pasted verses still qualify above.
  const hasIdentityDelimiter = /\s(?:by|from)\s/i.test(content)
    || (/[,،]/u.test(content) && words.length <= 12)
    || (/\s[-–—]\s/u.test(content) && words.length <= 12);
  const hasAttribute = Boolean(
    resolveRequestMood(text)
    || resolveRequestEnergy(text)
    || resolveRequestGenre(text)
    || languageDisplayName(text),
  ) || hasRequestLanguage(text);
  // Four or more free-form words are enough for a short transliterated line
  // such as "gali teri vich gara". Generic attributes and identity forms are
  // excluded first, so this does not turn mood, genre, or title-by-artist
  // requests into web searches.
  return (words.length >= 4 || segmentedWords >= 4) && !hasIdentityDelimiter && !hasAttribute;
}

export function isLyricOrFilmDescription(text: string): boolean {
  const eraRequest = /\b(?:from|during|in)\s+(?:the\s+)?(?:19|20)\d0s\b/iu.test(text);
  return looksLikeLyricRequest(text)
    || (!eraRequest && /\b(?:song|track|music)\s+(?:from|in)\s+\S/iu.test(text)
      && !hasRequestLanguage(text));
}

// Native-script lyrics are often transcribed without spaces. They should use
// the evidence resolver when framed as a play request; treating them as a
// literal multi-word title makes the local miss look like a valid identity.
export function hasUnspacedNativeScript(text: string): boolean {
  const content = text
    .replace(/^\s*(?:please\s+)?(?:play|request|queue|find|search\s+for|listen\s+to)\s+/iu, '')
    .trim();
  return /[\p{Script=Arabic}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Gujarati}\p{Script=Gurmukhi}\p{Script=Han}\p{Script=Hangul}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Thai}]/u.test(content)
    && !/\s/u.test(content);
}
