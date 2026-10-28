// Direct requests: interpret once, then resolve identity and eligibility in code.
// No model tools or station/session state belong in this module.
import { artistNameKey, artistParticipantKeys, nameKey } from './recency.js';
import {
  languageTerms,
  requestName,
  requestNameVariants,
  requestNameWithin,
  requestTextSimilarity,
  languageDisplayName,
  resolveLanguageCode,
  canonicalLanguage,
  resolveRequestEnergy,
  resolveRequestGenre as resolveRequestGenreAlias,
  resolveRequestMood,
  looksLikeLyricRequest,
  isLyricOrFilmDescription,
  LYRIC_CUE,
  hasUnspacedNativeScript,
  type RequestEnergy,
} from './request-normalize.js';
import { bpmCompat, keyCompat } from './mix.js';

// Keep the long-standing request-match exports stable for scripts and route
// consumers while the shared normalization helpers live in their own module.
export { requestName, looksLikeLyricRequest } from './request-normalize.js';
export { isLyricOrFilmDescription, isGreetingLikeRequest, isGenericRequestPhrase } from './request-normalize.js';

export interface RequestMatch {
  kind?: string;
  title?: string | null;
  album?: string | null;
  artist?: string | null;
  genre?: string | null;
  language?: string | null;
  mood?: string | null;
  energy?: RequestEnergy | null;
  sort?: string | null;
  scope?: string;
  search_terms?: string[];
  intent?: string;
  ack?: string;
  unsupported?: string[];
  // Controller-owned markers; never part of the model's interpretation schema.
  literal?: boolean;
  // A short title-only request may be ambiguous with an artist-only request.
  // The route tries the title first, then permits an exact artist lookup, but
  // never falls through to an unrelated recommendation.
  titleOnly?: boolean;
  // A literal "A - B" or "A, B" whose words do not say which side is the artist.
  reversible?: boolean;
  // Names need catalogue proof before they may hide condition words.
  unverifiedConditions?: string[];
  // A trailing "from Y" is kept as context, not folded into an artist. The
  // complete phrase remains the first title hypothesis so real titles such as
  // "Letter from America" stay valid.
  releaseContext?: {
    name: string;
    kind: 'movie' | 'film' | 'soundtrack' | 'album' | 'unknown';
    title: string;
    wholeTitle: string;
  };
  // A named similarity request is resolved through the same recording
  // identity verifier before its neighbours are considered.
  similarTo?: {
    title: string | null;
    artist: string | null;
    album: string | null;
    releaseContext?: RequestMatch['releaseContext'];
    raw: string;
  };
}

export type ListenerRequestClass =
  | 'named-song-or-artist'
  | 'lyrics-or-description'
  | 'attributes'
  | 'ambiguous-music'
  | 'non-music-chat';

export interface RequestSong {
  id: string;
  title?: string;
  artist?: string;
  artists?: Array<string | { name?: string }>;
  album?: string;
  year?: number;
  originalReleaseDate?: { year?: number; month?: number; day?: number };
  releaseDate?: string;
  genre?: string;
  genres?: Array<string | { name: string }>;
  language?: string;
  languages?: string[];
  bpm?: number | null;
  musicalKey?: string | null;
  moods?: string[];
  alternateTitles?: string[];
  _similarity?: number;
  lyricExcerpt?: string | null;
  lyrics?: string | null;
  [key: string]: unknown;
}

export interface RequestCandidateEvidence {
  webText?: string;
  lyricText?: string;
  lyricsById?: ReadonlyMap<string, string> | Readonly<Record<string, string | null | undefined>>;
}

export interface RankedRequestCandidate {
  song: RequestSong;
  score: number;
  titleScore: number;
  artistScore: number;
  alternateTitleScore: number;
  lyricOverlap: number;
  webEvidence: number;
}

export interface RequestCatalog {
  searchPage(query: string, options: { songCount: number; songOffset: number; signal?: AbortSignal }): Promise<{ songs: RequestSong[]; rawCount: number }>;
  // Local catalogue candidates used after exact/token search misses. This is
  // intentionally optional so resolver tests and non-library callers can
  // retain the existing Navidrome-only behaviour.
  fuzzySearch?(query: string, options?: { signal?: AbortSignal }): Promise<RequestSong[]>;
  resolveArtist(name: string, options?: { signal?: AbortSignal }): Promise<{ id: string; name?: string } | null>;
  getArtist(id: string, options?: { signal?: AbortSignal }): Promise<{ album?: Array<{ id: string; name?: string; title?: string; year?: number; originalReleaseDate?: { year?: number; month?: number; day?: number }; releaseDate?: string }> } | null>;
  getAlbum(id: string, options?: { signal?: AbortSignal }): Promise<RequestSong[]>;
  getTopSongs(name: string, options: { count: number; signal?: AbortSignal }): Promise<RequestSong[]>;
  resolveGenreName(name: string, options?: { signal?: AbortSignal }): Promise<string | null>;
  getGenres?(options?: { signal?: AbortSignal }): Promise<Array<{ value: string }>>;
  getSongsByGenreSampled(genre: string, options: { count: number; signal?: AbortSignal }): Promise<RequestSong[]>;
}

// Speech-to-text clients commonly alternate between a digit
// and its spoken cardinal form. Keep this fold deliberately small and title-
// local: changing artist keys or arbitrary request prose would make unrelated
// names collide (for example, a title named "Oh").
const SPOKEN_NUMBER_KEYS = new Map([
  ['zero', '0'], ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'], ['nine', '9'],
  ['ten', '10'], ['eleven', '11'], ['twelve', '12'], ['thirteen', '13'],
  ['fourteen', '14'], ['fifteen', '15'], ['sixteen', '16'], ['seventeen', '17'],
  ['eighteen', '18'], ['nineteen', '19'], ['twenty', '20'],
]);
const DIGIT_NUMBER_KEYS = new Map([...SPOKEN_NUMBER_KEYS].map(([word, digit]) => [digit, word]));

function titleIdentityKey(value: unknown): string {
  return requestName(value).split(' ').map(word => SPOKEN_NUMBER_KEYS.get(word) || word).join(' ');
}

// Search backends do not necessarily fold spoken number variants.
// Query both spellings, while titleIdentityKey keeps the final comparison
// title-local and deterministic. The original spelling remains first so the
// normal catalogue query and its ranking are unchanged.
function titleSearchVariants(value: string): string[] {
  const original = value.trim();
  const words = requestName(original).split(' ').filter(Boolean);
  const numeric = words.map(word => SPOKEN_NUMBER_KEYS.get(word) || word).join(' ');
  const spoken = words.map(word => DIGIT_NUMBER_KEYS.get(word) || word).join(' ');
  const seen = new Set<string>();
  return [original, numeric, spoken].filter(variant => {
    const key = requestName(variant) || `literal:${variant}`;
    if (!variant || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RequestSelection {
  track: RequestSong | null;
  source: string;
  outcome: 'matched' | 'partial' | 'substituted' | 'cooldown' | 'already-queued' | 'no-match' | 'unsupported';
  errors: string[];
  unmetPreferences?: string[];
  unsupported?: string[];
  // The hard requirements in force, so a no-match can say what it could not verify.
  required?: string[];
  confidence?: number;
  alternatives?: Array<{ id: string; title: string; artist: string; confidence: number }>;
}

// The resolver named the track but declined to queue it: it played recently,
// or it is already playing or queued.
export function isRefusedOutcome(outcome: string | null | undefined): boolean {
  return outcome === 'cooldown' || outcome === 'already-queued';
}

// Backstop for common conditions a small model can silently omit. Quoted
// names are data: "Everything but the Girl" is not an exclusion instruction.
// This is deliberately bounded, not a second natural-language interpreter.
export function directRequestUnsupported(text: string, match: RequestMatch = {}): string[] {
  if (match.kind === 'chat') return [];
  const prose = requestConditionProse(text, match);
  const reasons = new Set((match.unsupported || []).filter(reason => reason.trim()));
  if (/\b(?:anything|something|music|songs?|tracks?)\s+(?:except|excluding|but(?: not)?)\b|\b(?:but not|but no|excluding|except(?: for)?|other than)\s+\S|\b(?:do not|don['’]?t)\s+play\b/i.test(prose)) reasons.add('exclusions');
  // Require an instruction/clause boundary, not bare no/not or a cue inside
  // a name such as No Doubt, Not Waving, Skip James or Never Shout Never.
  if (/(?:^|[,;.!?]\s*|\s+(?:but|and|please)\s+)(?:please\s+)?(?:avoid\s+|steer\s+clear\s+of\s+|(?:do\s+not|don['’]?t)\s+(?:include|play)\s+|exclude\s+)(?=\S)/iu.test(prose)) {
    reasons.add('exclusions');
  }
  // "A Horse with No Name" is a recording identity, while "soul with no
  // metal" is a condition. Only treat `with no` as a filter when the words
  // before it are a generic music frame or a recognised attribute. This keeps
  // condition-like titles strict without letting title words reject a named
  // recording before catalogue verification.
  const withNo = prose.match(/(?<![\p{L}\p{N}])with\s+no\s+(?=\S)/iu);
  if (withNo) {
    const prefix = prose.slice(0, withNo.index).trim();
    const prefixWords = requestName(prefix).split(' ').filter(Boolean);
    const lastWord = prefixWords[prefixWords.length - 1] || '';
    const genericFrame = /(?:anything|something|music|songs?|tracks?|a\s+song|a\s+track)\s*$/iu.test(prefix);
    const recognisedAttribute = !!(resolveRequestMood(lastWord)
      || resolveRequestEnergy(lastWord)
      || resolveRequestGenreAlias(lastWord)
      || requestLanguageCode(lastWord));
    if (genericFrame || recognisedAttribute) reasons.add('exclusions');
  }
  if (/\b(?:19|20)\d0s\b|\b(?:from|during|in)\s+(?:the\s+)?(?:19|20)\d{2}\b/i.test(prose)
    || (!match.artist && !match.album && !/["'“‘]/u.test(text)
      && /\b(?:19|20)\d0s\b/iu.test(text)
      && /\b(?:song|track|music)\b/iu.test(text))) reasons.add('era');
  if (/\b(?:instrumental|acoustic|live)\s+(?:only|music|songs?|tracks?|versions?)\b|\b(?:only|strictly)\s+(?:instrumental|acoustic|live)\b|\bwithout\s+(?:vocals|singing|lyrics)\b/i.test(prose)) reasons.add('recording condition');
  if (/\b(?:song|track|one|music)\s+(?:from|in)\s+(?:(?:that|the|a)\s+)?(?:new\s+)?(?:film|movie|show|advert|commercial)\b|\b(?:song|track|one)\s+(?:with|containing|that has)\s+(?:the\s+)?(?:lyrics|words|line)\b/i.test(prose)) reasons.add('external identification');
  if (/\b(?:one|song|track|music)\s+(?:we|you|I)\s+(?:discussed|mentioned|requested|talked about)\s+(?:earlier|before|yesterday|last)\b/i.test(prose)) reasons.add('earlier conversation');
  return [...reasons];
}

const QUOTED_NAMES = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]+'(?![\p{L}\p{N}])/gu;

// The framing before a name: "could you play", "please put on".
const REQUEST_LEAD = /^\s*(?:(?:please\s+)?(?:can|could|would)\s+you\s+)?(?:(?:please\s+)?(?:play|put on|queue|request)\s+)?/i;

// The name quoted right after the request's framing, without whatever follows
// its closing quote: `play "X" for my mum` names X. A bare "please" frames a
// quote too (`please "X"`), though never an unquoted name ("Please Please Me").
function leadingQuotedName(text: string): string | null {
  const head = text.replace(REQUEST_LEAD, '').replace(/^please\s+/i, '');
  const span = head.match(QUOTED_NAMES)?.[0];
  return span && head.startsWith(span) ? span.slice(1, -1).trim() || null : null;
}

// Replace whole names in the listener's text with `token`, and every quoted
// span too unless `quoted` is false (an occurrence of the names themselves).
function maskNames(text: string, names: Array<string | null | undefined>, token: string, quoted = true): string {
  let prose = (quoted ? text.replace(QUOTED_NAMES, token) : text)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘']/g, '');
  for (const name of names.filter(Boolean).sort((a, b) => b!.length - a!.length)) {
    const words = requestName(name).split(' ').filter(Boolean);
    if (!words.length && name!.trim()) prose = prose.replaceAll(name!.trim(), token);
    // A leading "The" is optional: the model's "The Rock Steady Crew" still
    // masks the listener's "Rock Steady Crew".
    const article = words.length > 1 && words[0] === 'the' ? `(?:${words.shift()}[^\\p{L}\\p{N}\\p{M}]+)?` : '';
    if (words.length) prose = prose.replace(new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${article}${words.join('[^\\p{L}\\p{N}\\p{M}]+')}(?![\\p{L}\\p{N}\\p{M}])`, 'giu'), token);
  }
  return prose;
}

// Names are data, including exclusion-like words in titles and years in artist
// names. Mask whole names, the reading's name search terms included, before
// looking for conditions or attribute evidence.
function requestConditionProse(text: string, match: RequestMatch): string {
  return maskNames(text, [match.title, match.album, match.artist, ...nameSearchTerms(match)], ' <name> ');
}

// The words that only frame a request around a name: "could you play X by Y
// please". English only, like the condition backstop.
const REQUEST_FRAME = new Set(['play', 'please', 'pls', 'can', 'could', 'would', 'will', 'you', 'i', 'id', 'im', 'like',
  'love', 'want', 'wanna', 'to', 'hear', 'listen', 'put', 'on', 'queue', 'request', 'me', 'us', 'some', 'a', 'an', 'the',
  'song', 'track', 'tune', 'by', 'from', 'of', 'next', 'now', 'up', 'hey', 'hi', 'dj', 'thanks', 'thank', 'cheers', 'just']);

// Does the listener's text hold `term` as whole words? Only an occurrence of
// this term is proof, never an unrelated quoted span.
function inRequest(text: string, term: string): boolean {
  return maskNames(text, [term], ' \u0000 ', false).includes('\u0000');
}

// Voice clients often append a dedication or a polite closing after the
// recording name. These words are request framing, not part of the title or
// artist identity. Keep the list deliberately narrow so real names such as
// "Waiting for the World to Change", "For the First Time" and
// "Do It for My Baby" remain intact.
function trimLiteralRequestTail(value: string): string {
  return value
    .replace(/\s*(?:[,;]\s*(?:it['’]?s|it is)\b[^.!?]*|\s+for\s+my\s+(?:mum|mom|mother|dad|father|sister|brother|wife|husband|friend|friends|family|kids|children|son|daughter|birthday)\b[^.!?]*|,?\s*(?:please(?:\s+dj)?|thanks(?:\s+you)?|thank\s+you))\s*[.!?]*$/iu, '')
    .trim();
}

// Does the listener's text name `term`, with nothing but other names and
// request framing around it?
function namedInRequest(text: string, term: string, names: Array<string | null | undefined>): boolean {
  const masked = maskNames(text, [term], ' \u0000 ', false);
  return masked.includes('\u0000') && requestName(maskNames(masked, names, ' ', false)).split(' ').every(word => !word || REQUEST_FRAME.has(word));
}

// Is `term` the name at the head of a literal title, followed only by what a
// listener adds after a name: request framing, a dedication ("for my mum") or
// a new clause (", it's my birthday")? A recording's own words ("(Live)",
// "- Remastered", "Part 2") are no such tail.
function headsLiteral(literal: string, term: string): boolean {
  const [head, ...rest] = maskNames(literal, [term], '\u0000', false).split('\u0000');
  const tail = rest.join(' ');
  if (head.trim() || !requestName(tail)) return false;
  if (/^\s*[,;.!?]/.test(tail)) return true;
  const words = requestName(tail).split(' ');
  const dedication = words.indexOf('for');
  return (dedication < 0 ? words : words.slice(0, dedication)).every(word => REQUEST_FRAME.has(word));
}

// The search terms that can be names: never the reading's own artist in any
// spelling ("Beatles" for The Beatles), nor a term carrying its mood, genre,
// language, or energy word ("calm Queen songs", "upbeat music").
export function nameSearchTerms(match: RequestMatch): string[] {
  const artist = artistIdentityKey(match.artist);
  const attributes = [match.genre, match.language, match.mood, match.energy].map(requestName).filter(Boolean);
  return (match.search_terms || []).filter(term => {
    const key = requestName(term);
    return !!key && artistIdentityKey(term) !== artist && !attributes.some(word => ` ${key} `.includes(` ${word} `));
  });
}

// ICU supplies translated names for the languages recognised by literal
// recovery. Never treat short ISO codes such as "en" or "de" as request
// evidence: they are ordinary prepositions in other languages, and "it" is the
// last word of "Rock It". Tags and model output resolve codes directly.
function requestLanguageCode(name: string): string | undefined {
  return /^[a-z]{2}$/u.test(requestName(name)) ? undefined : resolveLanguageCode(name);
}

function requestLanguageTerms(name: string): string[] {
  return languageTerms(name);
}

// Navidrome installations do not agree on where language metadata lives. A
// tag may be an ISO-639 code (`pa`), a language name (`Punjabi`), or a style
// tag that carries the language (`Punjabi Pop`). Treat those as equivalent
// only when the requested language is a recognised language name or code. This
// keeps unknown words strict while allowing real-world library metadata to
// satisfy an explicit language request.
function requestLanguageTagMatches(want: string, got: string): boolean {
  const code = resolveLanguageCode(want);
  const canonicalWant = canonicalLanguage(want);
  const canonicalGot = canonicalLanguage(got);
  if (canonicalWant && canonicalGot && canonicalWant === canonicalGot) return true;
  const terms = [...requestLanguageTerms(want), ...(code ? [code] : []), ...(canonicalWant ? [canonicalWant] : [])].filter(Boolean);
  const tag = requestName(got);
  const exact = terms.some(term => tag === requestName(term));
  if (exact) return true;
  // Only recognised languages may use a language-bearing genre tag as
  // evidence. Unknown words stay exact-only, so an arbitrary genre such as
  // "Klingon Rock" cannot silently satisfy a language requirement.
  return !!code && terms.some(term => {
    const normalized = requestName(term);
    return !!normalized && requestGenreMatches(normalized, tag);
  });
}

export function explicitRequestAttribute(text: string, match: RequestMatch, value: string | null | undefined): boolean {
  if (!value) return false;
  const prose = requestName(requestConditionProse(text, match));
  const requestedName = requestName(value);
  const terms = (value === match.language ? requestLanguageTerms(value) : [requestedName])
    // Do not treat a two-letter ISO code emitted by the canonical language
    // list as prose evidence. It is valid metadata, but words such as "de"
    // and "en" are ordinary prepositions in many listener languages.
    .filter(term => term.length > 2 || term === requestedName);
  return terms.some(term => {
    // Spacing/punctuation may change during canonicalisation (hiphop/hip hop),
    // but a shared substring inside a different word (rap/trap) is no evidence.
    const letters = [...term.replace(/ /g, '')].join(' *');
    return !!letters && new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${letters}(?![\\p{L}\\p{N}\\p{M}])`, 'u').test(prose);
  });
}

function requestGenreMatches(want: string, got: string): boolean {
  const targets = requestNameVariants(want).filter(Boolean);
  const tags = requestNameVariants(got).filter(Boolean);
  return targets.some(target => tags.some(tag => {
    if (target === tag) return true;
    const targetTokens = target.split(' ').filter(Boolean);
    const tagTokens = tag.split(' ').filter(Boolean);
    // A catalogue style tag such as "Punjabi Pop" or "classic rock" can
    // carry a requested one-word genre, but never by substring: rap must not
    // match trap and soul must not match soulful.
    return targetTokens.length === 1
      ? tagTokens.includes(targetTokens[0]!)
      : targetTokens.every(token => tagTokens.includes(token));
  }));
}

// Request-only strictness: shared genre resolution remains fuzzy for shows,
// journeys and the picker. Prefer a strict catalogue hit over a fuzzy first hit.
export async function resolveRequestGenre(catalog: RequestCatalog, name: string, signal?: AbortSignal): Promise<string | null> {
  if (catalog.getGenres) {
    const genres = await catalog.getGenres({ signal });
    return genres.find(g => requestName(g.value).replace(/ /g, '') === requestName(name).replace(/ /g, ''))?.value
      || genres.find(g => requestGenreMatches(name, g.value))?.value || null;
  }
  const genre = await catalog.resolveGenreName(name, { signal });
  return genre && requestGenreMatches(name, genre) ? genre : null;
}

const RELEASE_CONTEXT_WRAPPER_TOKENS = new Set([
  'album', 'albums', 'film', 'films', 'movie', 'movies', 'motion', 'music',
  'original', 'ost', 'picture', 'soundtrack', 'the',
]);

function releaseContextFields(song: RequestSong): string[] {
  return [
    song.album,
    song['releaseGroup'],
    song['soundtrack'],
    song['movie'],
    song['film'],
  ].map(requestName).filter(Boolean);
}

function releaseContextMatches(context: NonNullable<RequestMatch['releaseContext']>, song: RequestSong): boolean {
  const want = requestName(context.name);
  if (!want) return false;
  const wantedTokens = want.split(' ').filter(Boolean);
  const wrappedFieldMatches = (field: string): boolean => {
    const fieldTokens = field.split(' ').filter(Boolean);
    if (fieldTokens.length <= wantedTokens.length) return false;
    for (let start = 0; start <= fieldTokens.length - wantedTokens.length; start++) {
      if (!wantedTokens.every((token, index) => fieldTokens[start + index] === token)) continue;
      const extras = fieldTokens.filter((_, index) => index < start || index >= start + wantedTokens.length);
      if (extras.every(token => RELEASE_CONTEXT_WRAPPER_TOKENS.has(token))) return true;
    }
    return false;
  };
  return releaseContextFields(song).some(field => field === want || wrappedFieldMatches(field));
}

// A named movie/album context is allowed one small speech-recognition typo,
// but only after exact context matching fails. Keep the comparison narrow:
// wrapper words may be present in catalogue fields, token counts must remain
// the same, numeric sequel markers must agree, and at most one sufficiently
// long token may differ by one edit. This makes "Tenu Weds Manu" prove
// "Tanu Weds Manu" without treating "Aashiqui" as "Aashiqui 2".
function oneEditApart(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  let row = 0;
  let column = 0;
  let edits = 0;
  while (row < left.length && column < right.length) {
    if (left[row] === right[column]) {
      row++;
      column++;
      continue;
    }
    if (++edits > 1) return false;
    if (left.length > right.length) row++;
    else if (right.length > left.length) column++;
    else {
      row++;
      column++;
    }
  }
  return edits + (left.length - row) + (right.length - column) <= 1;
}

function releaseContextFuzzyMatches(context: NonNullable<RequestMatch['releaseContext']>, song: RequestSong): boolean {
  if (releaseContextMatches(context, song)) return true;
  const wanted = requestName(context.name).split(' ').filter(token => !RELEASE_CONTEXT_WRAPPER_TOKENS.has(token));
  if (!wanted.length) return false;
  return releaseContextFields(song).some(field => {
    const actual = field.split(' ').filter(token => !RELEASE_CONTEXT_WRAPPER_TOKENS.has(token));
    if (actual.length !== wanted.length) return false;
    let edits = 0;
    for (let index = 0; index < wanted.length; index++) {
      const left = wanted[index]!;
      const right = actual[index]!;
      if (left === right) continue;
      // A changed digit is more likely a different sequel or edition than a
      // speech typo, so it is never accepted by this fallback.
      if (/^(?:\d+|[ivxlcdm]+)$/iu.test(left) || /^(?:\d+|[ivxlcdm]+)$/iu.test(right)
        || left.length < 4 || right.length < 4 || !oneEditApart(left, right)) return false;
      if (++edits > 1) return false;
    }
    return edits === 1;
  });
}

// Credits key through recency's shared name fold and split only on
// feat./ft./featuring, the blocklist's rule: "&", "+" and commas sit inside
// real band names, so "Fire" never names "Earth, Wind & Fire". A collaboration
// names each act through the server's per-artist credits instead. The
// listener's spelling is then compared without accents, punctuation or a
// leading "The".
function artistIdentityKey(value: unknown): string {
  const key = artistNameKey(value);
  return requestName(key).replace(/^the (?=\S)/, '') || key;
}

function artistIdentityVariants(value: unknown): string[] {
  return requestNameVariants(value)
    .map(key => key.replace(/^the (?=\S)/, '').trim())
    .filter(Boolean);
}

export function requestArtistMatches(want: unknown, song: RequestSong): boolean {
  const artists = artistIdentityVariants(want);
  const credits = [song.artist, ...(Array.isArray(song.artists) ? song.artists.map(a => (a as { name?: string })?.name) : [])];
  const rawWant = String(want ?? '').trim();
  if (!rawWant) return true;
  // requestName intentionally drops punctuation. Punctuation-only recordings
  // are still real identities, so an unnormalizable request may only match its
  // exact NFC/case-folded spelling rather than acting as a wildcard.
  if (!artists.length) {
    const wantedKey = nameKey(rawWant);
    return credits.some(credit => nameKey(credit) === wantedKey);
  }
  return credits.some((credit) => {
    const keys = [artistNameKey(credit), ...artistParticipantKeys(String(credit ?? ''))];
    return keys.some((key) => {
      const variants = artistIdentityVariants(key);
      return variants.some((variant) => artists.includes(variant));
    });
  });
}

function candidateArtistParts(value: unknown): string[] {
  const raw = String(value ?? '').trim();
  if (!raw) return [];
  // Navidrome commonly renders separate credits with a spaced slash. Keep
  // that documented request-matching behaviour, but do not split commas,
  // ampersands, plus signs, or compact slashes which can be part of one act
  // name ("Earth, Wind & Fire", "AC/DC").
  return raw.split(/\s+\/\s+|\b(?:feat(?:uring)?|ft)\.?\s+/iu).map(part => part.trim()).filter(Boolean);
}

function candidateArtistVariants(value: unknown): string[] {
  const parts = candidateArtistParts(value);
  const values = parts.length ? parts : [String(value ?? '')];
  return values.flatMap(part => {
    const variants = artistIdentityVariants(part);
    return variants.length ? variants : [nameKey(part)];
  }).filter(Boolean);
}

function candidateArtistCredits(song: RequestSong): string[] {
  const credits = [
    song.artist,
    ...(Array.isArray(song.artists) ? song.artists.map(artist => typeof artist === 'string' ? artist : artist?.name) : []),
  ].filter(Boolean);
  return credits.flatMap(candidateArtistParts);
}

export function requestCandidateArtistMatches(want: unknown, song: RequestSong): boolean {
  const wanted = candidateArtistVariants(want);
  if (!wanted.length) return true;
  const credits = candidateArtistCredits(song).flatMap(candidateArtistVariants);
  return wanted.some(value => credits.includes(value));
}

function requestCandidateArtistSimilarity(want: unknown, song: RequestSong): number {
  const wanted = candidateArtistVariants(want);
  if (!wanted.length) return 1;
  const credits = candidateArtistCredits(song).flatMap(candidateArtistVariants);
  return wanted.reduce((best, value) => Math.max(best,
    credits.reduce((inner, credit) => Math.max(inner, requestTextSimilarity(value, credit)), 0)), 0);
}

export function requestArtistSimilarity(want: unknown, song: RequestSong): number {
  const requested = artistIdentityVariants(want);
  if (!requested.length) return 1;
  const credits = [song.artist, ...(Array.isArray(song.artists) ? song.artists.map(a => (a as { name?: string })?.name) : [])]
    .filter(Boolean) as string[];
  return credits.reduce((best, credit) => {
    const variants = artistIdentityVariants(credit);
    const score = requested.reduce((inner, value) => {
      const valueScore = variants.reduce((variantBest, candidate) =>
        Math.max(variantBest, requestTextSimilarity(value, candidate)), 0);
      return Math.max(inner, valueScore);
    }, 0);
    return Math.max(best, score);
  }, 0);
}

export function requestedTitle(match: RequestMatch, text?: string): string | null {
  if (match.title?.trim()) return match.title.trim();
  if (match.album) return null;
  const terms = nameSearchTerms(match).map(term => term.trim());
  // The tolerant schema reads an omitted title as null, so a null title beside
  // a mood, genre, language, or energy is #1961's reply shape: a small model guessed
  // attributes and left the song in search_terms. The term is the title when
  // the listener's own words name it with only request framing around it;
  // "something calm for an overcast evening" stays a vibe.
  if (match.title === null && (match.mood || match.genre || match.language || match.energy)) {
    return text === undefined ? null : terms.find(term => namedInRequest(text, term, [match.artist, match.album])) || null;
  }
  return terms[0] || null;
}

// Catalogue decorations around one recording. A featured credit never makes
// another recording, in either the request or the library title; a mastering
// or edit label does only when the listener named one. Live, remix and
// acoustic recordings stay distinct.
const FEATURED_CREDIT = [
  /\s*(?:[-–—]\s*|\(|\[)(?:feat\.?|featuring|ft\.?)\s+[^)\]]+[\])]?\s*$/i,
  // Bare "Title feat. X" needs the dot, so "The Feat of Clay" keeps its title.
  /\s+(?:feat\.|ft\.|featuring)\s+[^)\]]+$/i,
];
const EDITION = [
  /\s*(?:[-–—]\s*|\(|\[)(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+(?:\d{4}|version|edition))*|radio\s+edit|single(?:\s+version)?|album\s+version|explicit(?:\s+version)?)[\])]?\s*$/iu,
  /\s*(?:\(|\[)\s*from\s+(?:"[^"]+"|“[^”]+”|'[^']+'|[^)\]]+)\s*[\])]?\s*$/iu,
];

function undecorated(value: unknown, patterns: RegExp[]): string {
  let title = String(value ?? '');
  for (let stripped = true; stripped;) {
    stripped = false;
    for (const pattern of patterns) {
      const next = title.replace(pattern, '');
      if (next !== title && next.trim()) { title = next; stripped = true; }
    }
  }
  return requestName(title);
}

export function requestTitleMatches(want: unknown, got: unknown): boolean {
  // Names such as "?" and "!!!" are real identities, not two empty keys.
  if (!requestName(want) || !requestName(got)) return nameKey(want) === nameKey(got);
  const wantKeys = requestNameVariants(want).map(titleIdentityKey);
  const gotKeys = requestNameVariants(got).map(titleIdentityKey);
  if (wantKeys.some(key => gotKeys.includes(key))) return true;
  const wanted = undecorated(want, FEATURED_CREDIT);
  const edition = undecorated(want, [...FEATURED_CREDIT, ...EDITION]) !== wanted;
  const gotTitle = undecorated(got, edition ? FEATURED_CREDIT : [...FEATURED_CREDIT, ...EDITION]);
  return requestNameVariants(wanted).map(titleIdentityKey)
    .some(key => requestNameVariants(gotTitle).map(titleIdentityKey).includes(key));
}

export function requestTitleSimilarity(want: unknown, got: unknown): number {
  if (requestTitleMatches(want, got)) return 1;
  return requestTextSimilarity(undecorated(want, FEATURED_CREDIT), undecorated(got, FEATURED_CREDIT));
}

function evidenceText(evidence: RequestCandidateEvidence): string {
  return requestName(evidence.webText || '');
}

function evidenceLyrics(evidence: RequestCandidateEvidence, song: RequestSong): string {
  const byId = evidence.lyricsById;
  const supplied = byId instanceof Map ? byId.get(song.id) : byId?.[song.id];
  return String(supplied || song.lyricExcerpt || song.lyrics || '');
}

function meaningfulTokens(value: unknown): string[] {
  return requestName(value).split(' ').filter(token => token.length >= 3);
}

function lyricOverlapScore(want: unknown, got: unknown): number {
  if (!String(want ?? '').trim() || !String(got ?? '').trim()) return 0;
  let best = 0;
  for (const left of requestNameVariants(want)) {
    const wanted = new Set(meaningfulTokens(left));
    if (wanted.size < 3) continue;
    for (const right of requestNameVariants(got)) {
      const actual = new Set(meaningfulTokens(right));
      const overlap = [...wanted].filter(token => actual.has(token)).length;
      best = Math.max(best, overlap / wanted.size);
    }
  }
  return Math.min(1, best);
}

function candidateAlternateTitles(song: RequestSong): string[] {
  return Array.isArray(song.alternateTitles)
    ? song.alternateTitles.filter((title): title is string => typeof title === 'string' && !!title.trim())
    : [];
}

// Web text that mentions both titles is not alias evidence: a page about
// "Viva la Vida" that also lists "Yellow" would otherwise prove "Yellow".
// Only the catalogue's own alternate titles can bridge two different titles.
function alternateTitleScore(requestedTitle: string | null, song: RequestSong): number {
  if (!requestedTitle) return 0;
  return candidateAlternateTitles(song).some(title => requestTitleSimilarity(requestedTitle, title) >= 0.82) ? 1 : 0;
}

function webEvidenceScore(requestedTitle: string | null, requestedArtist: string | null, song: RequestSong, evidence: RequestCandidateEvidence): number {
  const blob = evidenceText(evidence);
  if (!blob) return 0;
  // The web can confirm a local recording only under the title asked for.
  if (requestedTitle && !requestTitleMatches(requestedTitle, song.title)) return 0;
  const named = (values: string[]) => values.some(value => requestNameWithin(blob, value));
  const localTitle = named(requestNameVariants(song.title));
  const artistTerms = candidateArtistCredits(song).flatMap(requestNameVariants);
  const requestedArtistTerms = candidateArtistVariants(requestedArtist).flatMap(requestNameVariants);
  const artistInWeb = named(requestedArtist ? requestedArtistTerms : artistTerms);
  const requestedTitleInWeb = requestedTitle ? named(requestNameVariants(requestedTitle)) : false;
  if (localTitle && artistInWeb && (!requestedTitle || requestedTitleInWeb)) return 1;
  if (localTitle && artistInWeb) return 0.5;
  return 0;
}

export function rankRequestCandidates(
  requestedTitle: string | null,
  requestedArtist: string | null,
  candidates: RequestSong[],
  evidence: RequestCandidateEvidence = {},
): RankedRequestCandidate[] {
  return candidates
    .filter(song => song?.id)
    .map(song => {
      const artistScore = requestedArtist ? (requestCandidateArtistMatches(requestedArtist, song) ? 1 : 0) : 1;
      const titleScore = requestedTitle ? requestTitleSimilarity(requestedTitle, song.title) : 0;
      const alternateScore = alternateTitleScore(requestedTitle, song);
      const lyricScore = lyricOverlapScore(evidence.lyricText, evidenceLyrics(evidence, song));
      const webScore = webEvidenceScore(requestedTitle, requestedArtist, song, evidence);
      const strongSignal = titleScore >= 0.82 || alternateScore >= 0.7 || lyricScore >= 0.35 || webScore >= 0.8;
      const score = artistScore * 0.25 + titleScore * 0.45 + alternateScore * 0.15 + lyricScore * 0.10 + webScore * 0.05;
      return { song, score, titleScore, artistScore, alternateTitleScore: alternateScore, lyricOverlap: lyricScore, webEvidence: webScore, strongSignal };
    })
    .filter(row => row.artistScore > 0 && row.strongSignal)
    .sort((a, b) => b.score - a.score
      || b.titleScore - a.titleScore
      || b.alternateTitleScore - a.alternateTitleScore
      || b.lyricOverlap - a.lyricOverlap
      || b.webEvidence - a.webEvidence
      || String(a.song.id).localeCompare(String(b.song.id)));
}

const ATTRIBUTE_CONNECTORS = new Set(['and', 'or', 'in', 'en', 'de', 'में', 'ਵਿੱਚ', 'vibes', 'vibe']);

function knownAttributeToken(token: string): boolean {
  return !!(resolveRequestMood(token) || resolveRequestEnergy(token)
    || resolveRequestGenreAlias(token) || requestLanguageCode(token));
}

// Attribute recognition is a whole-request decision. Resolving a single token
// such as "dance" is not enough evidence: it is also a common title word.
// Unknown Latin words beside a recognised attribute keep the input on the
// named-title path, so "I wanna dance with somebody who loves me" is not
// reduced to the genre "dance".
function isAttributeOnlyRequest(
  attributeBody: string,
  languagePhrase: RegExpMatchArray | null,
  values: Array<string | null | undefined>,
): boolean {
  const canonicalTerms = values.flatMap(value => requestNameVariants(value))
    .concat(languagePhrase ? requestNameVariants(languagePhrase[1]) : [])
    .flatMap(value => value.split(' '))
    .filter(Boolean);
  const allowed = new Set([...canonicalTerms, ...ATTRIBUTE_CONNECTORS]);
  const inputTokens = requestName(attributeBody).split(' ').filter(Boolean);
  return inputTokens.every(token => allowed.has(token) || knownAttributeToken(token) || !/^[a-z]+$/iu.test(token));
}

export function isFramedTitleOnlyRequest(text: string, literal: RequestMatch): boolean {
  const lyricLike = looksLikeLyricRequest(text);
  return lyricLike
    && literal.kind === 'track'
    && Boolean(literal.title?.trim())
    && !literal.artist && !literal.album
    && !literal.genre && !literal.language && !literal.mood && !literal.energy
    && /^(?:please\s+)?(?:play|queue|request|put\s+on)\b/iu.test(text)
    && !hasUnspacedNativeScript(text)
    && !LYRIC_CUE.test(text)
    && !/\b(?:album|artist|genre|language|mood|energy)\b/iu.test(text)
    && !/^(?:please\s+)?(?:play|queue|request|put\s+on)\s+(?:some|something|anything|music|a\s+song|a\s+track)\b/iu.test(text);
}

export function modelFreeRequest(text: string): RequestMatch {
  const cleaned = text.replace(REQUEST_LEAD, '').replace(/\s+please[.!?]*$/i, '').trim();
  const unquote = (s: string) => s.replace(/^["'“‘]|["'”’][.!?]*$/g, '').trim();
  const albumPhrase = cleaned.match(/^(?:the\s+)?album\s+(.+?)[.!?]*$/iu);
  if (albumPhrase) {
    const album = unquote(albumPhrase[1]);
    return {
      kind: 'track', title: null, album, artist: null, genre: null, language: null,
      mood: null, energy: null, sort: null, scope: 'album', search_terms: album ? [album] : [],
      intent: album ? `Wants a track from the album ${album}.` : 'Wants a track from an album.', ack: '',
    };
  }
  const attributeBody = cleaned
    .replace(/^(?:(?:some|something|music|songs?|tracks?|a\s+song|a\s+track)\s+)+/iu, '')
    .replace(/\s+(?:music|songs?|tracks?|genre|language|style)(?=\s+(?:in|en|de|में|ਵਿੱਚ)\b)/iu, '')
    .replace(/\s+(?:music|songs?|tracks?|genre|language|style)\s*$/iu, '')
    .trim();
  const namedSimilarity = cleaned.match(/^(?:something|anything)\s+like\s+(.+?)[.!?]*$/iu);
  const lyricLike = looksLikeLyricRequest(cleaned) && !namedSimilarity;
  // At the model token cap, deictic similarity requests still need their
  // semantic lane. Treat only the unquoted "something/anything like this"
  // frame as similarity; a quoted or otherwise named recording keeps its
  // literal identity.
  if (!lyricLike && /^(?:(?:something|anything|more)\s+like\s+this|like\s+(?:this|that))\b/iu.test(cleaned)
    && !/["'“‘]/u.test(cleaned)) {
    return {
      kind: 'track', title: null, album: null, artist: null, genre: null,
      language: null, mood: null, energy: null, sort: null, scope: 'song',
      search_terms: [], intent: 'Wants more like the current track.', ack: '',
    };
  }
  // Named similarity is a separate relation from lyric or vibe search. Keep
  // the seed as data and resolve it through the recording verifier below.
  // This also handles a seed with soundtrack context, such as
  // "something like Tum Hi Ho from Aashiqui 2".
  if (namedSimilarity && namedSimilarity[1]) {
    const seed = modelFreeRequest(`play ${namedSimilarity[1]}`);
    return {
      kind: 'track', title: null, album: null, artist: null, genre: null,
      language: null, mood: null, energy: null, sort: null, scope: 'song',
      search_terms: [],
      similarTo: {
        title: seed.title || null,
        artist: seed.artist || null,
        album: seed.album || null,
        releaseContext: seed.releaseContext,
        raw: namedSimilarity[1].trim(),
      },
      intent: `Wants something similar to ${namedSimilarity[1].trim()}.`, ack: '',
    };
  }
  // Parse a trailing language condition before resolving the other attributes,
  // so "energetic in Punjabi" and "rock in Punjabi" retain both constraints.
  const languagePhrase = attributeBody.match(/(?:^|\s+)(?:in|en|de|में|ਵਿੱਚ)\s+([\p{L}][\p{L} -]*?)[.!?]*$/iu);
  const attributeCore = languagePhrase ? attributeBody.slice(0, languagePhrase.index).trim() : attributeBody;
  const inferredMood = !lyricLike ? resolveRequestMood(attributeCore) : null;
  const inferredEnergy = !lyricLike ? resolveRequestEnergy(attributeCore) : null;
  const inferredGenre = !lyricLike ? resolveRequestGenreAlias(attributeCore) : null;
  // A recognised genre name is not automatically a language. If the same
  // value is also an unambiguous language name ("Punjabi music"), preserve
  // both interpretations so a language-aware library can enforce it while a
  // genre-only library can still satisfy it through its Punjabi tag.
  const explicitLanguageCue = Boolean(languagePhrase)
    || /\b(?:language|language[s]?|sung|spoken|vocals?)\b/iu.test(attributeBody);
  const nativeScriptCue = /[^\u0000-\u007f]/u.test(attributeBody);
  const genreLanguage = inferredGenre && requestLanguageCode(inferredGenre)
    ? languageDisplayName(inferredGenre)
    : null;
  const inferredLanguage = !lyricLike && (explicitLanguageCue || nativeScriptCue || !inferredGenre)
    ? (requestLanguageCode(languagePhrase?.[1] || attributeBody) ? languageDisplayName(languagePhrase?.[1] || attributeBody) : null) || genreLanguage
    : !lyricLike && genreLanguage
      ? genreLanguage
    : null;
  if ((inferredMood || inferredEnergy || inferredGenre || inferredLanguage)
    && isAttributeOnlyRequest(attributeBody, languagePhrase, [
      inferredMood, inferredEnergy, inferredGenre, inferredLanguage,
    ])
    && !/\s+(?:by|from)\s+/iu.test(cleaned)
    && !/[\u0000,]|\s[-–—]\s/u.test(cleaned)
    && cleaned.split(/\s+/u).length <= 12) {
    const languageRequested = !!inferredLanguage && (explicitLanguageCue || nativeScriptCue || !!genreLanguage || !inferredGenre)
      && !/\b(?:genre|style)\b/iu.test(cleaned);
    const conditions = [
      inferredMood ? `Wants ${inferredMood} music.` : '',
      inferredEnergy ? `Wants ${inferredEnergy}-energy music.` : '',
      inferredGenre ? `Wants ${inferredGenre} music.` : '',
      languageRequested ? `Wants ${inferredLanguage}-language music.` : '',
    ].filter(Boolean);
    return {
      kind: 'track', title: null, album: null, artist: null,
      genre: inferredGenre,
      language: languageRequested ? inferredLanguage : null,
      mood: inferredMood, energy: inferredEnergy, sort: null, scope: 'song', search_terms: [],
      unsupported: [], intent: conditions.join(' '), ack: '',
    };
  }
  // A trailing language condition stays explicit even without interpretation.
  const languageHint = cleaned.match(/\s+in\s+([\p{L}][\p{L} -]*?)[.!?]*$/iu);
  // Only split an unambiguous, familiar language after a name-pair delimiter.
  // Other "in" phrases stay in the literal name and need catalogue proof;
  // e.g. A Day in the Life and Explosions in the Sky are names, not languages.
  const language = languageHint && /\sby\s|,\s|\s[-–—]\s/i.test(cleaned.slice(0, languageHint.index))
    && requestLanguageCode(languageHint[1]) ? languageHint : null;
  const unverifiedConditions = languageHint && !language ? ['unparsed language condition'] : [];
  const query = language ? cleaned.slice(0, language.index) : cleaned;
  // Keep offsets into the original text, but never split a quoted name on its
  // own "by", comma or spaced dash.
  const separators = query.replace(QUOTED_NAMES, name => '\u0000'.repeat(name.length));
  const pair = (separator: RegExpMatchArray | null, trimSentence = false) => {
    if (!separator) return null;
    let tail = query.slice(separator.index! + separator[0].length);
    if (trimSentence && /[^\s.!?]/u.test(tail)) tail = tail.replace(/[.!?]*$/, '');
    return [separator[0], query.slice(0, separator.index), tail];
  };
  // `from` is a relationship in generic frames ("a song from Artist"), not
  // an identity separator. Treating it like `by` turns "Letter from America
  // by The Proclaimers" into the title "Letter" and artist "America by ...".
  const by = pair(separators.match(/\s+by\s+/i), true);
  const artistOnly = query.match(/^(?:some|(?:anything|something|music|a song|a track) (?:by|from))\s+(.+?)[.!?]*$/i);
  const describedArtist = query.match(/^(?:some|anything|something|music|a song|a track)\s+(.+?)\s+by\s+(.+?)[.!?]*$/i);
  // "Anything but Love" and "Something except ..." are literal title
  // shapes, not mood requests. Do not let the word "love" inside an
  // exclusion-like title become the romantic mood and erase the title.
  const knownMood = describedArtist
    && !/^(?:anything|something)\s+(?:but|except|other than)\b/iu.test(describedArtist[0])
    && !!resolveRequestMood(describedArtist[1]);
  const genericPair = by && /^(?:(?:the|a|some|my)\s+)?(?:song|track|tune|music)$/iu.test(unquote(by[1]));
  if (artistOnly || knownMood || genericPair) return { kind: 'track', artist: unquote(artistOnly?.[1] || describedArtist?.[2] || by![2]), title: null,
    unverifiedConditions, language: language?.[1] || null, mood: knownMood ? resolveRequestMood(describedArtist?.[1]) : null,
    energy: resolveRequestEnergy(describedArtist?.[1]), album: null, search_terms: [], scope: 'song', ack: '' };
  // `from` is ambiguous in a title-only request. Keep the complete wording as
  // the first identity hypothesis and retain the split form as verified
  // soundtrack/album context. The resolver only accepts the split form when
  // the local candidate proves that relationship.
  const explicitContext = !by && query.match(/^(.+?)\s+from\s+(?:the\s+)?(movie|film|soundtrack|album)\s+(.+?)[.!?]*$/iu);
  const genericContext = !by && !explicitContext && query.match(/^(.+?)\s+from\s+(.+?)[.!?]*$/iu);
  const context = explicitContext || genericContext;
  if (context) {
    const titleBefore = unquote(context[1]).trim();
    const contextKind = explicitContext
      ? String(explicitContext[2]).toLowerCase() as 'movie' | 'film' | 'soundtrack' | 'album'
      : 'unknown';
    const contextName = unquote(explicitContext ? explicitContext[3] : context[2]).trim();
    const wholeTitle = unquote(query).trim();
    if (titleBefore && contextName) {
      if (/^(?:a\s+)?(?:song|track|music|one)$/iu.test(titleBefore)) {
        return {
          kind: 'track', title: null, album: null, artist: null,
          genre: null, language: null, mood: null, sort: null, energy: null,
          scope: 'song', search_terms: [], unsupported: ['film identification'],
          intent: 'Identify a song from a film or show.', ack: '',
        };
      }
      return {
        kind: 'track', title: wholeTitle, album: null, artist: null,
        genre: null, language: language?.[1] || null, mood: null, sort: null,
        energy: null, reversible: false, search_terms: [wholeTitle], scope: 'song',
        releaseContext: { name: contextName, kind: contextKind, title: titleBefore, wholeTitle },
        intent: 'Wants a named recording with soundtrack or album context.', ack: '',
      };
    }
  }
  const rawSeparated = !by && pair(separators.match(/,\s*/) || separators.match(/\s+[-–—]\s+/));
  // A comma after a conversational opener is prose, not an Artist, Title
  // delimiter. This matters for pasted lyrics such as "No, it's not a bad
  // time at all ...": treating "No" as the artist makes the request look like
  // an explicit name pair and bypasses the lyric-identification agent.
  const commaOpener = !!rawSeparated && rawSeparated[0].includes(',')
    && /^(?:no|yes|yeah|well|oh|okay|ok|actually|honestly)$/i.test(unquote(rawSeparated[1]))
    && requestName(rawSeparated[2]).split(' ').length > 8;
  const separated = commaOpener ? null : rawSeparated;
  // A title before an explicit by/from separator is authoritative. Trimming
  // it would turn real recordings such as "Looking for the Summer" or
  // "Do It for My Baby" into a different identity. Ambiguous comma/dash and
  // title-only forms retain the legacy narrow dedication cleanup.
  const title = by ? unquote(by[1])
    : commaOpener ? unquote(query)
      : trimLiteralRequestTail(unquote(separated?.[2] || query));
  const artist = by?.[2] ? trimLiteralRequestTail(by[2]) : separated?.[1] ? trimLiteralRequestTail(separated[1]) : null;
  return { kind: 'track', title, album: null, unverifiedConditions, artist: artist ? unquote(artist) : null, reversible: !!separated,
    search_terms: [title], genre: null, language: language?.[1] || null, mood: null, sort: null,
    scope: 'song', intent: 'library search without model interpretation', ack: '' };
}

// A deliberately small, deterministic classifier. It does not decide which
// track wins; it only chooses the resolver lane and provides durable
// diagnostics. Catalogue lookup still gets first refusal for short inputs in
// the route, because a title such as "Daaku" can otherwise resemble ordinary
// prose in an unfamiliar language.
export function classifyListenerRequest(text: string, literal = modelFreeRequest(text)): ListenerRequestClass {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const musicFraming = /\b(?:play|queue|request|song|track|music|album|artist|band|dj|more like|surprise)\b/iu.test(normalized);
  if (!musicFraming && /^(?:hello|hi|hey|how|what|who|where|when|why|are|is|do|does|can|could|would)\b/iu.test(normalized)) {
    return 'non-music-chat';
  }
  if (isLyricOrFilmDescription(normalized)
    || /\b(?:lyrics?|words|line)\s+(?:are|goes?|containing|that has)\b/iu.test(normalized)) {
    return 'lyrics-or-description';
  }
  if (literal.album || literal.genre || literal.language || literal.mood || literal.energy || literal.scope === 'album') {
    return 'attributes';
  }
  const generic = /^(?:please\s+)?(?:play|queue|put on|request)\s+(?:me\s+)?(?:anything|something|music|a song|a track)|^(?:anything|something|surprise me|more like this)$/iu;
  if (!generic.test(normalized) && (literal.artist?.trim() || literal.title?.trim())) {
    return 'named-song-or-artist';
  }
  if (musicFraming) return 'ambiguous-music';
  return 'non-music-chat';
}

// A model reply repaired against the literal reading of the same words.
export function repairRequestMatch(match: RequestMatch, text: string): RequestMatch {
  if (match.kind === 'chat') return match;
  const literal = modelFreeRequest(text);
  // The deterministic parser owns relationship semantics. An interpreter may
  // omit soundtrack context or turn it into an artist, but it cannot rewrite
  // that relationship.
  if (literal.releaseContext && !match.releaseContext) match = { ...match, releaseContext: literal.releaseContext };
  if (literal.similarTo) {
    return {
      ...match,
      kind: 'track', title: null, artist: null, album: null,
      similarTo: literal.similarTo, scope: 'song', literal: false,
    };
  }
  // The model sometimes labels a genre and the same word as a language. The
  // literal grammar resolves that ambiguity: "Punjabi music" is genre, while
  // "music in Punjabi" is language.
  if (literal.genre && !literal.language && match.language
    && requestName(match.language) === requestName(literal.genre)) {
    match = { ...match, language: null };
  }
  // Preserve every deterministic constraint the model omitted. This is
  // especially important for combined requests such as "energetic rock in
  // Punjabi": the model may identify the intent but return only one field.
  for (const key of ['mood', 'energy', 'genre', 'language'] as const) {
    if (!match[key] && literal[key]) match = { ...match, [key]: literal[key] };
  }
  // A song quoted right after the request's framing is explicit even if the
  // model supplies a different search term. Only the quoted span is the name,
  // never the words after its closing quote, and a quotation elsewhere
  // (lyrics, a dedication or a self-introduction) is no such evidence.
  const quoted = leadingQuotedName(text);
  if (quoted && !match.title && !match.album && match.scope !== 'album' && !literal.artist
    && !requestArtistMatches(quoted, { id: 'literal', artist: match.artist || '' })) return { ...match, title: quoted };
  if (!literal.artist || !literal.title) return match;
  if (!match.unsupported?.length
    && ![match.title, match.album, match.artist, match.genre, match.language, match.mood, ...(match.search_terms || [])].some(Boolean)) {
    // A valid empty plan is not a failure. Keep an unambiguous name pair when
    // the words hold one; generic asks still proceed as "anything".
    return { ...match, title: literal.title, artist: literal.artist, literal: true, reversible: literal.reversible,
      unverifiedConditions: literal.unverifiedConditions };
  }
  if (match.title || match.album || match.scope === 'album' || !match.artist) return match;
  // A small model can keep the artist but drop the title. Recover the literal
  // title whose artist agrees, written either way round. The literal keeps
  // whatever the listener said after the name, so a search term heading it
  // is the title instead ("Queen, Bohemian Rhapsody for my mum").
  const recovered = (title: string) => ({ ...match, title: nameSearchTerms(match).find(term => headsLiteral(title, term)) || title });
  if (requestArtistMatches(match.artist, { id: 'literal', artist: literal.artist })) return recovered(literal.title);
  if (literal.reversible && requestArtistMatches(match.artist, { id: 'literal', artist: literal.title })) return recovered(literal.artist);
  return match;
}

// The literal title and artist are the identity claim for an explicit request.
// Keep this policy beside the catalogue resolver so HTTP and future
// request route cannot accidentally let an interpreter rewrite the recording.
export function pinExplicitRequestMatch(match: RequestMatch, text: string): RequestMatch | null {
  const literal = modelFreeRequest(text);
  if (!literal.title?.trim() || !literal.artist?.trim()) return null;
  const repaired = repairRequestMatch(match, text);
  const compactName = (value: unknown) => String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const nameIsPrefix = (candidate: unknown, literalName: unknown) => {
    const candidateKey = compactName(candidate);
    const literalKey = compactName(literalName);
    return !!candidateKey && (literalKey === candidateKey || literalKey.startsWith(`${candidateKey} `));
  };
  let exactTitle = literal.title;
  let exactArtist = literal.artist;
  // A spaced dash or comma is reversible. If the interpreter confirms the
  // other side as the artist, use that orientation while retaining the
  // literal title, never the interpreter's title.
  if (literal.reversible && repaired.artist && nameIsPrefix(repaired.artist, literal.title)) {
    exactTitle = literal.artist;
    exactArtist = repaired.artist;
  } else if (repaired.artist && nameIsPrefix(repaired.artist, literal.artist)) {
    // The model can omit a dedication from the artist tail. Its matching
    // prefix is safe to use, while an unrelated artist is ignored.
    exactArtist = repaired.artist;
  }
  const literalUnverified = (literal.unverifiedConditions || [])
    .filter(condition => !(condition === 'unparsed language condition' && repaired.language));
  const identity = repairRequestMatch({
    ...repaired,
    kind: 'track',
    title: null,
    artist: exactArtist,
    album: null,
    scope: 'song',
  }, text);
  return {
    ...identity,
    kind: 'track',
    title: exactTitle,
    artist: exactArtist,
    album: null,
    scope: 'song',
    search_terms: [exactTitle, exactArtist],
    literal: true,
    reversible: literal.reversible,
    // The model can mistake title words such as "with no" for a condition.
    // Conditions are re-derived from the listener text below, after the
    // literal identity is known, so do not carry the model's unverified list
    // into the shared resolver.
    unsupported: literal.unsupported || [],
    unverifiedConditions: [...new Set([...(repaired.unverifiedConditions || []), ...literalUnverified])],
  };
}

/**
 * Canonicalise model and literal output before catalogue resolution. The model
 * speaks in English field names, while listeners can use another script or a
 * speech-recognition synonym. Canonicalisation never changes the listener's
 * title, artist, or album identity.
 */
export function normalizeRequestMatch(match: RequestMatch, options: { moods?: readonly string[] } = {}): RequestMatch {
  const mood = match.mood ? resolveRequestMood(match.mood, options.moods || []) || match.mood : null;
  // The request schema currently emits only the three supported values. Keep
  // legacy or hand-written callers safe as well: an unknown model value must
  // not leak into pool lookup as if it were a valid energy bucket.
  const energy = match.energy ? resolveRequestEnergy(match.energy) : null;
  const language = match.language && resolveLanguageCode(match.language)
    ? (languageDisplayName(match.language) || match.language)
    : match.language || null;
  return { ...match, mood, energy, language };
}

// One chronological scale; precise original dates precede release/year fallbacks.
export function requestReleaseRank(album: { year?: number; originalReleaseDate?: { year?: number; month?: number; day?: number }; releaseDate?: string }): number {
  const date = album.originalReleaseDate;
  if (date?.year) return date.year * 10000 + (date.month || 1) * 100 + (date.day || 1);
  const release = new Date(album.releaseDate || '');
  if (Number.isFinite(release.getTime())) return release.getUTCFullYear() * 10000 + (release.getUTCMonth() + 1) * 100 + release.getUTCDate();
  return album.year ? album.year * 10000 + 101 : 0;
}

export async function resolveDirectRequest(match: RequestMatch, deps: {
  catalog: RequestCatalog;
  text?: string;
  recentIds: Set<string>;
  queuedIds: Set<string>;
  currentId?: string | null;
  moodSongs(mood: string): Promise<RequestSong[]>;
  energySongs?(energy: RequestEnergy): Promise<RequestSong[]>;
  languageSongs?(language: string): Promise<RequestSong[]>;
  fallbackSongs(): Promise<RequestSong[]>;
  similarSongs?(): Promise<RequestSong[]>;
  similarSeedSongs?(seedId: string): Promise<RequestSong[]>;
  // Named title+artist requests use this to prevent a miss from becoming an
  // unrelated artist, search, mood, or starred-track fallback.
  exactOnly?: boolean;
  random?: () => number;
  choose?(pool: RequestSong[]): RequestSong | null;
  signal?: AbortSignal;
}): Promise<RequestSelection> {
  const { catalog, recentIds, queuedIds, currentId } = deps;
  const errors: string[] = [];
  const unsupported = deps.text === undefined ? match.unsupported || [] : directRequestUnsupported(deps.text, match);
  if (unsupported.length) return { track: null, source: 'unsupported', outcome: 'unsupported', errors, unsupported };
  // Model-supplied names can hide instructions just as literal names can.
  // Defer those raw cues until an actual catalogue identity proves the name;
  // otherwise refuse before any stand-in pool is tried.
  const unverifiedConditions = [...new Set([...(match.unverifiedConditions || []),
    ...(deps.text === undefined || match.kind === 'chat' ? [] : directRequestUnsupported(deps.text))])];
  const safe = async <T>(source: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); } catch (err) {
      if (deps.signal?.aborted) throw err;
      errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };
  let title = requestedTitle(match, deps.text);
  let artistName = match.artist;
  let titleOnlyArtistFallback = false;
  const requiredGenre = !!match.genre && (deps.text === undefined || explicitRequestAttribute(deps.text, match, match.genre));
  const requiredLanguage = !!match.language && (deps.text === undefined || explicitRequestAttribute(deps.text, match, match.language));
  const required = [requiredGenre && 'genre', requiredLanguage && 'language'].filter((value): value is string => !!value);
  // #1961's reply shape with more than framing around the song ("Play
  // Bohemian Rhapsody by Queen, it is my birthday"): no title, and attributes
  // the listener's words never asked for. The search terms those words hold
  // may still name the song, so each is tried as a title before any pool.
  const namedTerms = deps.text !== undefined && !title && match.title === null && !match.album && match.scope !== 'album'
    && [match.mood, match.genre, match.language].some(Boolean) && !required.length
    && !explicitRequestAttribute(deps.text, match, match.mood)
    ? nameSearchTerms(match).filter(term => inRequest(deps.text!, term)) : [];
  // Once a named song missed, a pool draw only stands in for it.
  let standingIn = false;
  const moodPool = match.mood ? await safe('mood tracks', () => deps.moodSongs(match.mood!), []) : [];
  const energyPool = match.energy && deps.energySongs
    ? await safe('energy tracks', () => deps.energySongs!(match.energy!), [])
    : [];
  const languagePool = match.language && deps.languageSongs
    ? await safe('language tracks', () => deps.languageSongs!(canonicalLanguage(match.language!) || match.language!), [])
    : [];
  const moodIds = new Set(moodPool.map(song => song.id));
  const moodMatches = (song: RequestSong) => !match.mood || moodIds.has(song.id)
    || Boolean(song.moods?.some(m => requestName(m) === requestName(match.mood)));
  const energyMatches = (song: RequestSong) => !match.energy || requestName(song.energy) === requestName(match.energy);
  let resolvedArtistName = match.artist;
  // The complete "X from Y" wording is a title in its own right ("Postcards
  // from Italy"), so only the split "X" reading has to prove Y in the
  // catalogue.
  const contextProven = (song: RequestSong) => !match.releaseContext
    || title === match.releaseContext.wholeTitle
    || releaseContextMatches(match.releaseContext, song);
  const identity = (song: RequestSong) => (!title || requestTitleMatches(title, song.title))
    && requestCandidateArtistMatches(resolvedArtistName, song)
    && (!match.album || requestName(song.album) === requestName(match.album))
    && contextProven(song);
  const tags = (song: RequestSong) => [song.genre, ...(song.genres || []).map(g => typeof g === 'string' ? g : g.name)].map(requestName).filter(Boolean);
  let genre: string | null = null;
  // Small models may guess attributes despite the prompt. Only terms present
  // outside recognised names are hard requirements; guesses stay preferences.
  if (match.genre) genre = await safe('genre resolution', () => resolveRequestGenre(catalog, match.genre!, deps.signal), null);
  const languageMatches = (song: RequestSong) => !match.language
    || [song.language, ...(song.languages || []), ...tags(song)].some(value => requestLanguageTagMatches(match.language!, String(value ?? '')));
  // Some language names are also commonly emitted as broad style tags (for
  // example, "Punjabi music"). When the parser records both interpretations,
  // first-class language metadata is the stronger evidence and must satisfy
  // the overlapping genre condition even if the library has no genre column.
  const overlappingLanguageGenre = Boolean(match.genre && match.language
    && canonicalLanguage(match.genre) && canonicalLanguage(match.genre) === canonicalLanguage(match.language));
  const genreMatches = (song: RequestSong) => !match.genre
    || tags(song).some(g => requestGenreMatches(genre || match.genre!, g))
    || (overlappingLanguageGenre && languageMatches(song));
  const constraints = (song: RequestSong, source: string) =>
    (!requiredGenre || (genre && source === `genre:${genre}`) || genreMatches(song))
    && (!requiredLanguage || (source === 'language-library' && languagePool.length > 0) || languageMatches(song));
  const eligible = (song: RequestSong) => !recentIds.has(song.id) && !queuedIds.has(song.id) && song.id !== currentId;
  const unique = (songs: RequestSong[]) => [...new Map(songs.filter(s => s?.id).map(s => [s.id, s])).values()];
  let similaritySeed: RequestSong | null = null;
  const overlap = (left: string[], right: string[]) => {
    if (!left.length || !right.length) return 0;
    const rightSet = new Set(right);
    return left.filter(value => rightSet.has(value)).length / Math.max(left.length, right.length);
  };
  const similarityScore = (song: RequestSong): number => {
    if (!similaritySeed) return 0;
    const audio = typeof song._similarity === 'number' && Number.isFinite(song._similarity)
      ? Math.max(0, Math.min(1, song._similarity)) : 0;
    const genreScore = overlap(tags(similaritySeed), tags(song));
    const moodScore = overlap((similaritySeed.moods || []).map(requestName), (song.moods || []).map(requestName));
    const languageScore = similaritySeed.language && song.language
      ? Number(requestLanguageTagMatches(similaritySeed.language, song.language)) : 0;
    const energyScore = similaritySeed.energy && song.energy
      ? Number(requestName(similaritySeed.energy) === requestName(song.energy)) : 0;
    const tempoScore = bpmCompat(similaritySeed.bpm ?? null, song.bpm ?? null);
    const keyScore = keyCompat(similaritySeed.musicalKey ?? null, song.musicalKey ?? null);
    return 0.55 * audio + 0.14 * genreScore + 0.10 * moodScore + 0.08 * languageScore
      + 0.05 * energyScore + 0.05 * tempoScore + 0.03 * keyScore;
  };
  const choose = (songs: RequestSong[]) => {
    if (match.similarTo && similaritySeed) {
      return [...songs].sort((a, b) => similarityScore(b) - similarityScore(a) || a.id.localeCompare(b.id))[0] || null;
    }
    const score = (song: RequestSong) => Number(!!match.mood && moodMatches(song))
      + Number(!!match.genre && !requiredGenre && genreMatches(song))
      + Number(!!match.language && !requiredLanguage && languageMatches(song))
      + Number(!!match.energy && energyMatches(song));
    const best = songs.reduce((best, song) => Math.max(best, score(song)), 0);
    const pool = songs.filter(song => score(song) === best);
    if (deps.choose) return deps.choose(pool);
    return pool[Math.min(pool.length - 1, Math.floor((deps.random || Math.random)() * pool.length))] || null;
  };
  let alternatives: Array<{ id: string; title: string; artist: string; confidence: number }> = [];
  const identityScore = (song: RequestSong): number => {
    const titleScore = title ? requestTitleSimilarity(title, song.title) : 1;
    const artistScore = resolvedArtistName ? requestCandidateArtistSimilarity(resolvedArtistName, song) : 1;
    const albumScore = match.album ? requestTextSimilarity(match.album, song.album) : 1;
    return titleScore * 0.55 + artistScore * 0.35 + albumScore * 0.10;
  };
  const selectFuzzy = (songs: RequestSong[], source: string): RequestSelection | null => {
    if (!title) return null;
    const scored = unique(songs)
      // Keep temporarily ineligible candidates in the ranked set. Exact
      // matching already preserves a queued/cooldown identity for a refusal;
      // fuzzy matching must do the same instead of turning a verified repeat
      // into a misleading no-match.
      .filter(song => constraints(song, source) && contextProven(song))
      .map(song => ({ song, confidence: identityScore(song), titleScore: requestTitleSimilarity(title, song.title), artistScore: resolvedArtistName ? requestCandidateArtistSimilarity(resolvedArtistName, song) : 1 }))
      // Keep a wider, still meaningful candidate set for clarification. Only
      // the stricter confidence and margin checks below may auto-select.
      .filter(row => row.titleScore >= 0.70 && (!resolvedArtistName || row.artistScore >= 0.70))
      .sort((a, b) => b.confidence - a.confidence || a.song.id.localeCompare(b.song.id));
    alternatives = scored.slice(0, 3).map(row => ({
      id: row.song.id,
      title: String(row.song.title || ''),
      artist: String(row.song.artist || ''),
      confidence: Number(row.confidence.toFixed(4)),
    }));
    // Prefer an eligible candidate when one exists. If every plausible
    // candidate is queued, playing, or on cooldown, retain the best verified
    // identity so the caller can return its typed refusal instead of widening
    // into an unrelated fallback.
    const ranked = scored.filter(row => eligible(row.song));
    const top = (ranked.length ? ranked : scored)[0];
    const comparison = ranked.length ? ranked : scored;
    const margin = top && comparison[1] ? top.confidence - comparison[1].confidence : 1;
    // A title-only request has no artist signal to contribute, so one speech
    // recognition typo can land just below the explicit title+artist floor.
    // Keep a meaningful title threshold and the same ambiguity margin; a
    // collision therefore remains a no-match rather than becoming a guess.
    const minimumConfidence = resolvedArtistName ? 0.92 : 0.88;
    if (!top || top.confidence < minimumConfidence || margin < 0.08) return null;
    if (!eligible(top.song)) {
      return {
        track: top.song,
        source,
        outcome: queuedIds.has(top.song.id) || top.song.id === currentId ? 'already-queued' : 'cooldown',
        errors,
        confidence: top.confidence,
        alternatives,
      };
    }
    return {
      track: top.song,
      source: `${source}:fuzzy`,
      outcome: 'matched',
      errors,
      confidence: top.confidence,
      alternatives,
    };
  };
  let held: { track: RequestSong; source: string } | null = null;
  const select = (songs: RequestSong[], source: string, exact = true): RequestSelection | null => {
    const pool = unique(songs).filter(s => constraints(s, source) && (!exact || identity(s)));
    const track = choose(pool.filter(eligible));
    const named = exact && !standingIn;
    if (track) {
      const unmetPreferences = [!moodMatches(track) && 'mood', !genreMatches(track) && 'genre', !languageMatches(track) && 'language', !energyMatches(track) && 'energy'].filter((value): value is string => !!value);
      const outcome = named ? (unmetPreferences.length ? 'partial' : 'matched') : 'substituted';
      return { track, source, outcome, errors, unmetPreferences };
    }
    // Preserve the requested identity for an honest refusal, never replace an
    // exact recording merely because it is queued or on cooldown.
    if (named && pool.length && !held) held = { track: pool[0], source };
    return null;
  };
  const selectFuzzyReleaseContext = (songs: RequestSong[], source: string): RequestSelection | null => {
    if (!match.releaseContext || !title) return null;
    const pool = unique(songs).filter(song => constraints(song, source)
      && requestTitleMatches(title, song.title)
      && requestCandidateArtistMatches(resolvedArtistName, song)
      && releaseContextFuzzyMatches(match.releaseContext!, song));
    // A typo-tolerant context is useful only when it still identifies one
    // local recording. Do not choose between two tracks with the same title
    // merely because both soundtrack/album names are close.
    if (pool.length !== 1) return null;
    const track = pool[0]!;
    if (!eligible(track)) {
      return {
        track,
        source,
        outcome: queuedIds.has(track.id) || track.id === currentId ? 'already-queued' : 'cooldown',
        errors,
      };
    }
    const unmetPreferences = [!moodMatches(track) && 'mood', !genreMatches(track) && 'genre', !languageMatches(track) && 'language', !energyMatches(track) && 'energy'].filter((value): value is string => !!value);
    return {
      track,
      source,
      outcome: unmetPreferences.length ? 'partial' : 'matched',
      errors,
      unmetPreferences,
    };
  };
  const refusal = (): RequestSelection | null => held ? {
    ...held, outcome: queuedIds.has(held.track.id) || held.track.id === currentId ? 'already-queued' : 'cooldown', errors,
  } : null;

  if (match.similarTo) {
    const seedRequest: RequestMatch = {
      kind: 'track', title: match.similarTo.title, artist: match.similarTo.artist,
      album: match.similarTo.album, releaseContext: match.similarTo.releaseContext,
      scope: 'song', literal: false, titleOnly: true,
    };
    let seed = await resolveDirectRequest(seedRequest, {
      ...deps, text: undefined, exactOnly: true, choose: undefined,
      similarSongs: undefined, similarSeedSongs: undefined, fallbackSongs: async () => [],
    });
    // "something like Michael Jackson" is commonly an artist seed rather
    // than a recording title. Resolve it as an artist only after exact title
    // identity has failed.
    if (!seed.track && match.similarTo.title && !match.similarTo.artist) {
      seed = await resolveDirectRequest({ kind: 'track', title: null, artist: match.similarTo.title, scope: 'song' }, {
        ...deps, text: undefined, exactOnly: false, choose: undefined,
        similarSongs: undefined, similarSeedSongs: undefined, fallbackSongs: async () => [],
      });
    }
    if (!seed.track) {
      // A named comparison is still a named identity claim. Without a
      // verified recording seed, do not silently reinterpret it as a request
      // for the current track or another artist's similarity pool.
      return { track: null, source: 'similar-seed', outcome: 'no-match', errors, required, alternatives };
    }
    similaritySeed = seed.track;
    const candidates = await safe('similar seed tracks', () => {
      if (deps.similarSeedSongs) return deps.similarSeedSongs(seed.track!.id);
      return deps.similarSongs ? deps.similarSongs() : Promise.resolve([]);
    }, []);
    const seedTitle = requestName(seed.track.title);
    const filtered = unique(candidates).filter(song => song.id !== seed.track!.id && requestName(song.title) !== seedTitle);
    const result = select(filtered, 'similar-to-seed');
    return result || { track: null, source: 'similar-seed', outcome: 'no-match', errors, required, alternatives };
  }

  const search = async (term: string) => {
    const found: RequestSong[] = [];
    const normalized = requestName(term);
    const tokens = normalized.split(' ').filter(token => token.length >= 3);
    const primaryQueries = [...new Set(titleSearchVariants(term).filter(Boolean))];
    const fallbackQueries = [...new Set([
      ...requestNameVariants(term),
      ...(tokens.length > 1 ? [tokens.sort((a, b) => b.length - a.length)[0]] : []),
    ].filter(Boolean))].filter(query => !primaryQueries.includes(query)).slice(0, 4);
    // Preserve the normal catalogue query and its bounded page budget. Extra
    // transliteration/token queries are only a fallback after the primary
    // spelling produced no rows. This prevents a single miss from multiplying
    // every normal request into several full pagination walks.
    const queryGroups = [primaryQueries, fallbackQueries].filter(group => group.length);
    // Bounded, deterministic pages. rawCount includes filtered/blocked rows.
    for (const queries of queryGroups) {
      const errorsBefore = errors.length;
      for (const query of queries) {
        for (let songOffset = 0; songOffset < 100; songOffset += 25) {
    const page = await safe('search', () => catalog.searchPage(query, { songCount: 25, songOffset, signal: deps.signal }), { songs: [], rawCount: 0 });
          found.push(...page.songs);
          if (found.some(s => identity(s) && constraints(s, 'search') && (Boolean(title) || eligible(s))) || page.rawCount < 25) break;
        }
        if (found.some(s => identity(s) && constraints(s, 'search') && (Boolean(title) || eligible(s)))) break;
      }
      if (found.length || errors.length > errorsBefore) break;
    }
    return unique(found);
  };
  let searched: RequestSong[] = [];
  const artistAlternatives: RequestSong[] = [];
  if (title) {
    searched = await search(title);
      const exact = select(searched, 'search');
      if (exact) return exact;
      const heldExact = refusal();
      if (heldExact) return heldExact;
      const fuzzy = selectFuzzy(searched, 'search');
      if (fuzzy) return fuzzy;
      // Navidrome's token search is intentionally bounded and may miss a
      // misspelled multi-word title entirely. Ask the local catalogue for a
      // bounded candidate set before any artist/pool fallback. The verifier
      // above still owns title/artist similarity and ambiguity decisions.
      if (catalog.fuzzySearch) {
        const local = await safe('local fuzzy search', () => catalog.fuzzySearch!(title!, { signal: deps.signal }), []);
        const localFuzzy = selectFuzzy(local, 'local-fuzzy');
        if (localFuzzy) return localFuzzy;
      }
      // Generic "Title from Artist" is also a common artist frame. Try that
      // alternate identity before treating the trailing name as release
      // context, and only through exact title+artist proof.
      if (match.releaseContext?.kind === 'unknown' && !match.artist) {
        const artistFallback = await resolveDirectRequest({
          ...match,
          title: match.releaseContext.title,
          artist: match.releaseContext.name,
          album: null,
          releaseContext: undefined,
          search_terms: [match.releaseContext.title, match.releaseContext.name],
          literal: false,
          titleOnly: true,
        }, {
          ...deps,
          text: undefined,
          exactOnly: true,
          choose: undefined,
          similarSongs: undefined,
          similarSeedSongs: undefined,
          fallbackSongs: async () => [],
        });
        if (artistFallback.track) return { ...artistFallback, source: 'from-artist' };
      }
      // If the complete phrase did not prove an identity, try the bounded
      // title-plus-release-context hypothesis. The same title and context
      // verifier remains active, so a token search can never turn this into a
      // same-artist or unrelated album substitution.
      if (match.releaseContext && title === match.releaseContext.wholeTitle
        && match.releaseContext.title !== title) {
        const wholeTitle = title;
        title = match.releaseContext.title;
        const contextual = await search(title);
        const exactContext = select(contextual, 'release-context');
        if (exactContext) return exactContext;
        const fuzzyContext = selectFuzzy(contextual, 'release-context');
        if (fuzzyContext) return fuzzyContext;
        const typoContext = selectFuzzyReleaseContext(contextual, 'release-context-fuzzy');
        if (typoContext) return typoContext;
        title = wholeTitle;
      }
    // "One Crowded Hour - Augie March" reads either way round. The other
    // reading counts only on catalogue proof of both its title and artist.
    if (match.reversible && artistName) {
      const reading = { title, artistName };
      [title, artistName, resolvedArtistName] = [reading.artistName, reading.title, reading.title];
      const swapped = select(await search(title), 'search') || refusal();
      if (swapped) return swapped;
      [title, artistName, resolvedArtistName] = [reading.title, reading.artistName, reading.artistName];
    }
    // Accent/punctuation variants or compilation indexing may need the artist
    // catalogue below; never union an artist query into a named-title lottery.
  }
  // Only a catalogue hit for the term counts. With no artist in the reading,
  // another named term must be it ("Queen, Bohemian Rhapsody").
  for (const term of namedTerms) {
    const others = namedTerms.filter(other => other !== term);
    title = term;
    resolvedArtistName = match.artist;
    const hits = await search(term);
    for (const artist of match.artist ? [match.artist] : others.length ? others : [null]) {
      resolvedArtistName = artist;
      const hit = select(hits, 'search') || refusal();
      if (hit) return hit;
    }
    [title, resolvedArtistName] = [null, match.artist];
    standingIn = true;
  }

  // A one-word title miss can also be an artist name. Try that exact artist
  // catalogue before refusing, but retain the no-stand-in policy below.
  if (deps.exactOnly && match.titleOnly && !artistName && title) {
    artistName = title;
    resolvedArtistName = title;
    title = null;
    titleOnlyArtistFallback = true;
  }

  if (match.literal && !deps.exactOnly && !match.titleOnly && !match.releaseContext && !match.similarTo && !artistName && title) {
    artistName = title;
    resolvedArtistName = title;
    title = null;
  }
  if (artistName) {
    if (match.sort === 'popular' && !title && !match.album) {
      const popular = await safe('popular songs', () => catalog.getTopSongs(artistName!, { count: 100, signal: deps.signal }), []);
      const candidates = unique(popular).filter(s => identity(s) && constraints(s, 'artist-popular'));
      const best = candidates.find(eligible) || candidates[0];
      const result = select(best ? [best] : [], 'artist-popular');
      if (result) return result;
    }
    const artist = await safe('artist resolution', () => catalog.resolveArtist(artistName!, { signal: deps.signal }), null);
    if (artist && ((!match.literal && !unverifiedConditions.length) || requestArtistMatches(artistName, { id: artist.id, artist: artist.name }))) {
      resolvedArtistName = artist.name || artistName;
      // The title search judged its hits against the listener's spelling of
      // the artist; the library's own spelling may prove one of them.
      if (title && resolvedArtistName !== artistName) {
        const exact = select(searched, 'search') || refusal();
        if (exact) return exact;
      }
      const full = await safe('artist albums', () => catalog.getArtist(artist.id, { signal: deps.signal }), null);
      let albums = full?.album || [];
      if (match.album) albums = albums.filter(a => requestName(a.name || a.title) === requestName(match.album));
      if (match.sort === 'latest' || match.sort === 'oldest') {
        const direction = match.sort === 'latest' ? -1 : 1;
        albums = [...albums].sort((a, b) => {
          const left = requestReleaseRank(a), right = requestReleaseRank(b);
          return !left ? 1 : !right ? -1 : direction * (left - right);
        });
      } else if (albums.length) {
        const offset = Math.floor((deps.random || Math.random)() * albums.length);
        albums = [...albums.slice(offset), ...albums.slice(0, offset)];
      }
      const rankedSongs: Array<{ song: RequestSong; rank: number }> = [];
      const artistMoodPool: RequestSong[] = [];
      const rankIndividualTracks = !title && match.scope !== 'album' && (match.sort === 'latest' || match.sort === 'oldest');
      for (const album of albums.slice(0, 20)) {
        const songs = await safe('album tracks', () => catalog.getAlbum(album.id, { signal: deps.signal }), []);
        if (title) artistAlternatives.push(...songs.filter(song => requestCandidateArtistMatches(resolvedArtistName, song)));
        if (rankIndividualTracks) {
          rankedSongs.push(...songs.map(song => ({ song, rank: requestReleaseRank(song) || requestReleaseRank(album) })));
          continue;
        }
        if (!title && match.mood) {
          artistMoodPool.push(...songs);
          continue;
        }
        const result = select(songs, 'artist-albums');
        // Album order is no evidence of popularity, but a named song is itself.
        if (result) return match.sort === 'popular' && !title ? { ...result, outcome: 'substituted' } : result;
      }
      if (artistMoodPool.length) {
        const result = select(artistMoodPool, 'artist-mood');
        if (result) return match.sort === 'popular' ? { ...result, outcome: 'substituted' } : result;
      }
      if (rankIndividualTracks) {
        const ranks = [...new Set(rankedSongs.map(row => row.rank))].sort((a, b) => !a ? 1 : !b ? -1 : match.sort === 'latest' ? b - a : a - b);
        for (const rank of ranks) {
          const result = select(rankedSongs.filter(row => row.rank === rank).map(row => row.song), 'artist-release');
          if (result) return result;
        }
      }
    }
    // Song artists on compilations need not have an artist-album index entry.
    if (!title) {
      searched = await search(match.album || artistName);
      const result = select(searched, 'search');
      if (result) return match.sort ? { ...result, outcome: 'substituted' } : result;
    }
  } else if (match.album) {
    searched = await search(match.album);
    const result = select(searched, 'search');
    if (result) return result;
  }
  const identityRefusal = refusal();
  if (identityRefusal) return identityRefusal;
  if (unverifiedConditions.length) return { track: null, source: 'unsupported', outcome: 'unsupported', errors, unsupported: unverifiedConditions };
  if (deps.exactOnly && artistName && !title && !match.album) {
    // A named artist may select one of that artist's own recordings above,
    // but an absent artist is not permission to draw unrelated fallback music.
    return { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors, required, alternatives };
  }

  // Exact identity requests may inspect the named artist's real catalogue for
  // aliases and alternatives, but they never enter similarity, mood, genre,
  // language, or starred fallback pools.
  if (deps.exactOnly && (title || match.album)) {
    if (unverifiedConditions.length) {
      return { track: null, source: 'unsupported', outcome: 'unsupported', errors, unsupported: unverifiedConditions };
    }
    return { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors, required, alternatives };
  }

  // An explicit title and artist are identity claims, not a request for a
  // nearby recommendation. The caller can still use the normal fallback
  // policy for artist-only, mood, and similarity requests, but an exact-only
  // lookup must stop here rather than silently replacing the listener's song.
  // Explicit named titles are never silently replaced by a random search or
  // fallback track. This also covers title-only requests, where an ambiguous
  // fuzzy result must be shown as alternatives instead of being queued.
  if (!title && !match.album) {
    if (genre) {
      const result = select(await safe('genre tracks', () => catalog.getSongsByGenreSampled(genre!, { count: 100, signal: deps.signal }), []), `genre:${genre}`);
      if (result) return result;
    }
    if (languagePool.length) {
      const result = select(languagePool, 'language-library');
      if (result) return result;
    }
    if (match.mood) {
      const result = select(moodPool, `library-mood:${match.mood}`);
      if (result) return result;
    }
    if (match.energy) {
      const result = select(energyPool, `library-energy:${match.energy}`);
      if (result) return result;
    }
    // A genre/language may be absent from Navidrome's genre index even though
    // searchable recordings carry the term in their title or album. Search
    // each requested attribute and let the same hard-constraint verifier
    // accept only evidence-bearing rows.
    if (match.genre || match.language) {
      const attributeCandidates = unique((await Promise.all(
        [match.genre, match.language].filter((value): value is string => !!value)
          .map(value => safe(`attribute search:${value}`, () => search(value), [])),
      )).flat());
      const result = select(attributeCandidates, 'attribute-search');
      if (result) return result;
    }
    const constrainedRefusal = refusal();
    if (constrainedRefusal) return constrainedRefusal;
  }
  if (titleOnlyArtistFallback) return { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors, required, alternatives };
  if (deps.similarSongs) {
    const result = select(await safe('similar tracks', deps.similarSongs, []), 'similar-to-current', !title && !artistName && !match.album);
    if (result) return result;
  }
  // Both interpreted and literal requests can offer honest alternatives,
  // within any explicit hard constraints.
  const artistAlternative = select(artistAlternatives, 'artist-alternative', false);
  if (artistAlternative) return artistAlternative;
  const searchAlternative = select(searched, 'search', false);
  if (searchAlternative) return searchAlternative;
  const fallback = select(await safe('fallback tracks', deps.fallbackSongs, []), 'fallback', false);
  return fallback || { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors, required, alternatives };
}
