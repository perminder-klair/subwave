// Direct requests: interpret once, then resolve identity and eligibility in code.
// No model tools or station/session state belong in this module.
import { artistNameKey, artistParticipantKeys, nameKey } from './recency.js';
import {
  languageTerms,
  requestName,
  requestNameVariants,
  requestTextSimilarity,
  languageDisplayName,
  resolveLanguageCode,
  resolveRequestEnergy,
  resolveRequestGenre as resolveRequestGenreAlias,
  resolveRequestMood,
  looksLikeLyricRequest,
  type RequestEnergy,
} from './request-normalize.js';

// Keep the long-standing request-match exports stable for scripts and route
// consumers while the shared normalization helpers live in their own module.
export { requestName, looksLikeLyricRequest } from './request-normalize.js';

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
  moods?: string[];
  alternateTitles?: string[];
  lyricExcerpt?: string | null;
  lyrics?: string | null;
  [key: string]: unknown;
}

export interface RequestCandidateEvidence {
  webText?: string;
  lyricText?: string;
  lyricsById?: ReadonlyMap<string, string> | Readonly<Record<string, string | null | undefined>>;
}

export type LatestReleaseKind = 'single' | 'album';

export interface LatestReleaseEvidence {
  kind: LatestReleaseKind;
  title: string;
  artist: string;
  releaseDate: string;
  source: string;
  sourceUrls?: string[];
}

export type LatestReleaseUnavailableReason = 'artist-not-found' | 'no-evidence' | 'ambiguous' | 'provider-error' | 'not-in-library';

export type LatestReleaseLookup =
  | { status: 'verified'; release: LatestReleaseEvidence }
  | { status: 'unavailable'; reason: LatestReleaseUnavailableReason; provider?: string };

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
  outcome: 'matched' | 'substituted' | 'cooldown' | 'already-queued' | 'no-match' | 'unsupported';
  errors: string[];
  unmetPreferences?: string[];
  unsupported?: string[];
  // The hard requirements in force, so a no-match can say what it could not verify.
  required?: string[];
  confidence?: number;
  alternatives?: Array<{ id: string; title: string; artist: string; confidence: number }>;
  releaseResolution?: {
    kind: LatestReleaseKind;
    mode: 'verified' | 'local-fallback';
    evidence?: LatestReleaseEvidence;
    reason?: LatestReleaseUnavailableReason;
  };
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
  if (/(?:^|[,;.!?]\s*|\s+(?:but|and|please)\s+)(?:please\s+)?(?:avoid\s+|steer\s+clear\s+of\s+|(?:do\s+not|don['’]?t)\s+(?:include|play)\s+|exclude\s+)(?=\S)/iu.test(prose)
    || /(?<![\p{L}\p{N}])with\s+no\s+(?=\S)/iu.test(prose)) reasons.add('exclusions');
  if (/\b(?:19|20)\d0s\b|\b(?:from|during|in)\s+(?:the\s+)?(?:19|20)\d{2}\b/i.test(prose)) reasons.add('era');
  if (/\b(?:instrumental|acoustic|live)\s+(?:only|music|songs?|tracks?|versions?)\b|\b(?:only|strictly)\s+(?:instrumental|acoustic|live)\b|\bwithout\s+(?:vocals|singing|lyrics)\b/i.test(prose)) reasons.add('recording condition');
  if (/\b(?:song|track|one)\s+(?:from|in)\s+(?:that|the|a)\s+(?:new\s+)?(?:film|movie|show|advert|commercial)\b|\b(?:song|track|one)\s+(?:with|containing|that has)\s+(?:the\s+)?(?:lyrics|words|line)\b/i.test(prose)) reasons.add('external identification');
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
// spelling ("Beatles" for The Beatles), nor a term carrying its mood, genre or
// language word ("calm Queen songs").
export function nameSearchTerms(match: RequestMatch): string[] {
  const artist = artistIdentityKey(match.artist);
  const attributes = [match.genre, match.language, match.mood].map(requestName).filter(Boolean);
  return (match.search_terms || []).filter(term => {
    const key = requestName(term);
    return !!key && artistIdentityKey(term) !== artist && !attributes.some(word => ` ${key} `.includes(` ${word} `));
  });
}

// ICU supplies translated names for the languages recognised by literal
// recovery. Never treat short ISO codes such as "en" or "de" as request
// evidence: they are ordinary prepositions in other languages.
function requestLanguageCode(name: string): string | undefined {
  return resolveLanguageCode(name);
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
  const code = requestLanguageCode(want);
  const terms = [...requestLanguageTerms(want), ...(code ? [code] : [])].filter(Boolean);
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

// Candidate verification is deliberately more permissive than recency and
// blocklist matching. Navidrome has already supplied the catalogue row, so a
// listener's primary-artist request may match one act inside a track credit
// such as "Lead / Guest, feat. Producer". Keep this split local to request
// identity; widening artistParticipantKeys would change absolute blocklist
// semantics for names containing commas and ampersands.
const CANDIDATE_ARTIST_SPLIT = /\s*(?:\/|&|,)\s*|\b(?:feat(?:uring)?|ft)\.?\s+/iu;

function candidateArtistParts(value: unknown): string[] {
  return String(value ?? '')
    .split(CANDIDATE_ARTIST_SPLIT)
    .map(part => part.trim())
    .filter(Boolean);
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
  // a mood, genre or language is #1961's reply shape: a small model guessed
  // attributes and left the song in search_terms. The term is the title when
  // the listener's own words name it with only request framing around it;
  // "something calm for an overcast evening" stays a vibe.
  if (match.title === null && (match.mood || match.genre || match.language)) {
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

function alternateTitleScore(requestedTitle: string | null, song: RequestSong, evidence: RequestCandidateEvidence): number {
  if (!requestedTitle) return 0;
  const alternates = candidateAlternateTitles(song);
  if (alternates.some(title => requestTitleSimilarity(requestedTitle, title) >= 0.82)) return 1;
  const blob = evidenceText(evidence);
  if (!blob) return 0;
  const requested = requestNameVariants(requestedTitle);
  const local = requestNameVariants(song.title);
  const artist = candidateArtistCredits(song).flatMap(requestNameVariants);
  const requestedInWeb = requested.some(value => value && blob.includes(value));
  const localInWeb = local.some(value => value && blob.includes(value));
  const artistInWeb = artist.some(value => value && blob.includes(value));
  return requestedInWeb && localInWeb && artistInWeb ? 1 : 0;
}

function webEvidenceScore(requestedTitle: string | null, requestedArtist: string | null, song: RequestSong, evidence: RequestCandidateEvidence): number {
  const blob = evidenceText(evidence);
  if (!blob) return 0;
  const localTitle = requestNameVariants(song.title).some(value => value && blob.includes(value));
  const artistTerms = candidateArtistCredits(song).flatMap(requestNameVariants);
  const requestedArtistTerms = candidateArtistVariants(requestedArtist).flatMap(requestNameVariants);
  const artistInWeb = requestedArtist
    ? requestedArtistTerms.some(value => value && blob.includes(value))
    : artistTerms.some(value => value && blob.includes(value));
  const requestedTitleInWeb = requestedTitle
    ? requestNameVariants(requestedTitle).some(value => value && blob.includes(value))
    : false;
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
      const alternateScore = alternateTitleScore(requestedTitle, song, evidence);
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

// Alias verification is intentionally request-local. Web text can nominate a
// relationship between the listener's name and a real catalogue title, but it
// cannot manufacture an id; the returned candidate is always one of the
// caller-supplied Navidrome tracks and must still agree on artist.
export function rankAliasCandidates(
  requestedTitle: string,
  requestedArtist: string,
  candidates: RequestSong[],
  evidence: string,
): RequestSong | null {
  return rankRequestCandidates(requestedTitle, requestedArtist, candidates, { webText: evidence })[0]?.song || null;
}

type LatestReleaseScope = 'song' | 'album';

function latestReleaseScope(noun: string): LatestReleaseScope {
  return /album|record|एल्बम/iu.test(noun) ? 'album' : 'song';
}

function latestReleaseMatch(artist: string | null, scope: LatestReleaseScope): RequestMatch {
  const cleanArtist = artist?.replace(/[.!?]+$/u, '').trim() || null;
  return {
    kind: 'track', title: null, album: null, artist: cleanArtist,
    genre: null, language: null, mood: null, energy: null,
    sort: 'latest', scope, search_terms: cleanArtist ? [cleanArtist] : [],
    intent: scope === 'album' ? 'Wants a track from the newest official album.' : 'Wants the newest official single.',
    ack: '',
  };
}

/**
 * Recognise release recency before the generic `title by artist` parser. The
 * generic parser must treat every unknown left-hand side as a literal title,
 * which is correct for `The Latest by X` but wrong for `latest song by X`.
 * Keep this grammar narrow so a recording whose real title contains these
 * words is still handled by the literal path.
 */
function latestReleaseRequest(text: string): RequestMatch | null {
  const source = text.trim()
    .replace(/^(?:(?:what(?:['’]s|\s+is)|tell\s+me|show\s+me|give\s+me|play|queue|request)\s+)(?:the\s+)?/iu, '')
    .replace(/^the\s+/iu, '')
    .replace(/[.!?]+$/u, '').trim();
  if (!source || /"|“|”|‘|’/u.test(source)) return null;
  const noun = '(song|track|single|tune|album|record|गाना|गाने|गीत|ट्रैक|सिंगल|एल्बम|रिकॉर्ड)';
  const recency = '(?:latest|newest|most\\s+recent|recent|new)';
  const byArtist = source.match(new RegExp(`^${recency}\\s+${noun}\\s+(?:by|from)\\s+(.+)$`, 'iu'));
  if (byArtist?.[2]) return latestReleaseMatch(byArtist[2], latestReleaseScope(byArtist[1]));

  const possessive = source.match(new RegExp(`^(.+?)['’]s\\s+${recency}\\s+${noun}$`, 'iu'));
  if (possessive?.[1]) return latestReleaseMatch(possessive[1], latestReleaseScope(possessive[2]));

  const suffix = source.match(new RegExp(`^(.+?)\\s+${recency}\\s+${noun}$`, 'iu'));
  if (suffix?.[1]) return latestReleaseMatch(suffix[1], latestReleaseScope(suffix[2]));

  // Common Hinglish and Hindi Alexa transcriptions: "X ka sabse naya gana"
  // and "X का सबसे नया गाना". The artist remains data; only the small release
  // frame is interpreted.
  const indic = source.match(/^(.+?)\s+(?:ka|ki|ke|का|की|के)\s+(?:(?:sabse|सबसे)\s+)?(?:latest|newest|naya|nayi|naye|नया|नई|नए|नवीनतम|लेटेस्ट)\s+(song|track|single|album|record|gana|gaana|गाना|गाने|गीत|ट्रैक|सिंगल|एल्बम|रिकॉर्ड)$/iu);
  if (indic?.[1]) return latestReleaseMatch(indic[1], latestReleaseScope(indic[2]));

  const bare = source.match(new RegExp(`^${recency}\\s+${noun}$`, 'iu'));
  if (bare?.[1]) return latestReleaseMatch(null, latestReleaseScope(bare[1]));
  return null;
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
    .replace(/^(?:some|something|music|songs?|tracks?|a\s+song|a\s+track)\s+/iu, '')
    .replace(/\s+(?:music|songs?|tracks?|genre|language|style)\s*$/iu, '')
    .trim();
  const lyricLike = looksLikeLyricRequest(cleaned);
  // At the model token cap, deictic similarity requests still need their
  // semantic lane. Treat only the unquoted "something/anything like this"
  // frame as similarity; a quoted or otherwise named recording keeps its
  // literal identity.
  if (!lyricLike && /^(?:something|anything)\s+like\s+this\b/iu.test(cleaned)
    && !/["'“‘]/u.test(cleaned)) {
    return {
      kind: 'track', title: null, album: null, artist: null, genre: null,
      language: null, mood: null, energy: null, sort: null, scope: 'song',
      search_terms: [], intent: 'Wants more like the current track.', ack: '',
    };
  }
  // Parse a trailing language condition before resolving the other attributes,
  // so "energetic in Punjabi" and "rock in Punjabi" retain both constraints.
  const languagePhrase = attributeBody.match(/\s+(?:in|en|de|में|में|ਵਿੱਚ)\s+([\p{L}][\p{L} -]*?)[.!?]*$/iu);
  const attributeCore = languagePhrase ? attributeBody.slice(0, languagePhrase.index).trim() : attributeBody;
  const inferredMood = !lyricLike ? resolveRequestMood(attributeCore) : null;
  const inferredEnergy = !lyricLike ? resolveRequestEnergy(attributeCore) : null;
  const inferredGenre = !lyricLike ? resolveRequestGenreAlias(attributeCore) : null;
  const inferredLanguage = !lyricLike
    ? languageDisplayName(languagePhrase?.[1] || attributeBody)
    : null;
  if ((inferredMood || inferredEnergy || inferredGenre || inferredLanguage)
    && !/\s+(?:by|from)\s+/iu.test(cleaned)
    && !/[\u0000,]|\s[-–—]\s/u.test(cleaned)
    && cleaned.split(/\s+/u).length <= 12) {
    const languageRequested = !!inferredLanguage && !/\b(?:genre|style)\b/iu.test(cleaned);
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
  const latest = latestReleaseRequest(query);
  if (latest) {
    return {
      ...latest,
      language: language?.[1] || null,
      unverifiedConditions,
    };
  }
  // Keep offsets into the original text, but never split a quoted name on its
  // own "by", comma or spaced dash.
  const separators = query.replace(QUOTED_NAMES, name => '\u0000'.repeat(name.length));
  const pair = (separator: RegExpMatchArray | null, trimSentence = false) => {
    if (!separator) return null;
    let tail = query.slice(separator.index! + separator[0].length);
    if (trimSentence && /[^\s.!?]/u.test(tail)) tail = tail.replace(/[.!?]*$/, '');
    return [separator[0], query.slice(0, separator.index), tail];
  };
  const by = pair(separators.match(/\s+(?:by|from)\s+/i), true);
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
  if (looksLikeLyricRequest(normalized)
    || /\b(?:song|track|music)\s+(?:from|in)\b.{0,60}\b(?:film|movie|show|advert|commercial)\b/iu.test(normalized)
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
  const language = match.language && requestLanguageCode(match.language)
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
  fallbackSongs(): Promise<RequestSong[]>;
  similarSongs?(): Promise<RequestSong[]>;
  // Named title+artist requests use this to prevent a miss from becoming an
  // unrelated artist, search, mood, or starred-track fallback.
  exactOnly?: boolean;
  // Recency evidence is resolved outside this pure catalogue module. The
  // callback may use MusicBrainz/web metadata, but the returned release still
  // has to be verified against this local catalogue before it is queued.
  latestRelease?(artist: string, kind: LatestReleaseKind, signal?: AbortSignal): Promise<LatestReleaseLookup>;
  random?: () => number;
  choose?(pool: RequestSong[]): RequestSong | null;
  signal?: AbortSignal;
}): Promise<RequestSelection> {
  const { catalog, recentIds, queuedIds, currentId } = deps;
  const errors: string[] = [];
  if (match.sort === 'latest' && !match.artist?.trim() && !match.title?.trim() && !match.album?.trim()) {
    return { track: null, source: 'no-match', outcome: 'no-match', errors };
  }
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
  const releaseRequest = match.sort === 'latest'
    && !title
    && !!artistName
    && !match.album
    && (match.scope === undefined || match.scope === 'song' || match.scope === 'album');
  const releaseKind: LatestReleaseKind = match.scope === 'album' ? 'album' : 'single';
  const chronologicalRequest = !title && (match.sort === 'latest' || match.sort === 'oldest');
  let deterministicReleaseSelection = chronologicalRequest;
  let releaseLookup: LatestReleaseLookup | null = null;
  let releaseResolution: RequestSelection['releaseResolution'] | undefined;
  const decorateRelease = (selection: RequestSelection): RequestSelection => {
    if (!releaseResolution) return selection;
    return {
      ...selection,
      outcome: releaseResolution.mode === 'local-fallback' && selection.outcome === 'matched'
        ? 'substituted'
        : selection.outcome,
      releaseResolution,
    };
  };
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
  const moodIds = new Set(moodPool.map(song => song.id));
  const moodMatches = (song: RequestSong) => !match.mood || moodIds.has(song.id)
    || Boolean(song.moods?.some(m => requestName(m) === requestName(match.mood)));
  const energyMatches = (song: RequestSong) => !match.energy || requestName(song.energy) === requestName(match.energy);
  let resolvedArtistName = match.artist;
  const identity = (song: RequestSong) => (!title || requestTitleMatches(title, song.title))
    && requestCandidateArtistMatches(resolvedArtistName, song) && (!match.album || requestName(song.album) === requestName(match.album));
  const tags = (song: RequestSong) => [song.genre, ...(song.genres || []).map(g => typeof g === 'string' ? g : g.name)].map(requestName).filter(Boolean);
  let genre: string | null = null;
  let languageGenre: string | null = null;
  // Small models may guess attributes despite the prompt. Only terms present
  // outside recognised names are hard requirements; guesses stay preferences.
  if (match.genre) genre = await safe('genre resolution', () => resolveRequestGenre(catalog, match.genre!, deps.signal), null);
  if (match.language) languageGenre = await safe('language resolution', () => resolveRequestGenre(catalog, match.language!, deps.signal), null);
  const genreMatches = (song: RequestSong) => !match.genre || tags(song).some(g => requestGenreMatches(genre || match.genre!, g));
  const languageMatches = (song: RequestSong) => !match.language
    || [song.language, ...(song.languages || []), ...tags(song)].some(value => requestLanguageTagMatches(match.language!, String(value ?? '')));
  // Some Navidrome libraries have useful language/scene evidence in the
  // recording or album name but no genre tags at all. A search result is
  // eligible for the attribute lane only when the requested term is present
  // in that metadata; this never turns an arbitrary pool track into evidence
  // and keeps named-song verification strict.
  const attributeNameEvidence = (song: RequestSong, value: string | null | undefined): boolean => {
    if (!value) return false;
    const fields = [song.title, song.album].flatMap(requestNameVariants).filter(Boolean);
    return requestNameVariants(value).some(term => fields.some(field => field === term || ` ${field} `.includes(` ${term} `)));
  };
  const attributeEvidenceMatches = (song: RequestSong) =>
    (!requiredGenre || genreMatches(song) || attributeNameEvidence(song, match.genre))
    && (!requiredLanguage || languageMatches(song) || attributeNameEvidence(song, match.language));
  const constraints = (song: RequestSong, source: string) =>
    (!requiredGenre || (genre && source === `genre:${genre}`) || genreMatches(song) || (source === 'attribute-search' && attributeEvidenceMatches(song)))
    && (!requiredLanguage || (languageGenre && source === `language-genre:${languageGenre}`) || languageMatches(song) || (source === 'attribute-search' && attributeEvidenceMatches(song)));
  const eligible = (song: RequestSong) => !recentIds.has(song.id) && !queuedIds.has(song.id) && song.id !== currentId;
  const unique = (songs: RequestSong[]) => [...new Map(songs.filter(s => s?.id).map(s => [s.id, s])).values()];
  const choose = (songs: RequestSong[]) => {
    const score = (song: RequestSong) => Number(!!match.mood && moodMatches(song))
      + Number(!!match.genre && !requiredGenre && genreMatches(song))
      + Number(!!match.language && !requiredLanguage && languageMatches(song))
      + Number(!!match.energy && energyMatches(song));
    const best = songs.reduce((best, song) => Math.max(best, score(song)), 0);
    const pool = songs.filter(song => score(song) === best);
    if (deterministicReleaseSelection) {
      return [...pool].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0] || null;
    }
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
      .filter(song => constraints(song, source))
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
      return { track, source, outcome: named ? 'matched' : 'substituted', errors, unmetPreferences };
    }
    // Preserve the requested identity for an honest refusal, never replace an
    // exact recording merely because it is queued or on cooldown.
    if (named && pool.length && !held) held = { track: pool[0], source };
    return null;
  };
  const refusal = (): RequestSelection | null => held ? {
    ...held, outcome: queuedIds.has(held.track.id) || held.track.id === currentId ? 'already-queued' : 'cooldown', errors,
  } : null;
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

  if (match.literal && !match.titleOnly && !artistName && title) {
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
          return !left ? 1 : !right ? -1 : direction * (left - right)
            || String(a.id).localeCompare(String(b.id));
        });
      } else if (albums.length) {
        const offset = Math.floor((deps.random || Math.random)() * albums.length);
        albums = [...albums.slice(offset), ...albums.slice(0, offset)];
      }
      const rankedSongs: Array<{ song: RequestSong; rank: number }> = [];
      const artistMoodPool: RequestSong[] = [];
      const rankIndividualTracks = !title && match.scope !== 'album' && (match.sort === 'latest' || match.sort === 'oldest');
      const releaseFallbackAlbums: Array<{ album: typeof albums[number]; songs: RequestSong[] }> = [];
      let releaseExactRequest = false;
      if (releaseRequest && deps.latestRelease) {
        releaseLookup = await safe('latest release lookup', () => deps.latestRelease!(resolvedArtistName || artistName!, releaseKind, deps.signal), {
          status: 'unavailable', reason: 'provider-error',
        });
        if (releaseLookup.status === 'verified') {
          releaseExactRequest = true;
          releaseResolution = { kind: releaseKind, mode: 'verified', evidence: releaseLookup.release };
          if (releaseKind === 'single') title = releaseLookup.release.title;
        } else {
          releaseResolution = { kind: releaseKind, mode: 'local-fallback', reason: releaseLookup.reason };
        }
      }
      for (const album of albums.slice(0, 20)) {
        const songs = await safe('album tracks', () => catalog.getAlbum(album.id, { signal: deps.signal }), []);
        if (releaseRequest && deps.latestRelease) {
          releaseFallbackAlbums.push({ album, songs });
          if (releaseExactRequest) {
            const releaseAlbum = releaseLookup?.status === 'verified' ? releaseLookup.release.title : '';
            const isReleaseAlbum = releaseKind !== 'album'
              || requestName(album.name || album.title) === requestName(releaseAlbum);
            if (isReleaseAlbum) {
              const result = select(songs, 'artist-latest-release');
              if (result) return decorateRelease(result);
            }
          }
          continue;
        }
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
      if (releaseRequest && deps.latestRelease) {
        if (releaseExactRequest) {
          // The provider identified a real release, but the station does not
          // carry that exact recording/release. Keep the fallback in the
          // verified artist catalogue and make its reason visible to callers.
          releaseResolution = { kind: releaseKind, mode: 'local-fallback', reason: 'not-in-library' };
          title = null;
        }
        deterministicReleaseSelection = true;
        if (releaseKind === 'album') {
          for (const { songs } of releaseFallbackAlbums) {
            const result = select(songs, 'artist-latest-local-fallback');
            if (result) return decorateRelease(result);
          }
        } else {
          const rankedReleaseSongs = releaseFallbackAlbums.flatMap(({ album, songs }) => songs.map(song => ({
            song,
            rank: requestReleaseRank(song) || requestReleaseRank(album),
          })));
          const ranks = [...new Set(rankedReleaseSongs.map(row => row.rank))]
            .sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || b - a);
          for (const rank of ranks) {
            const result = select(rankedReleaseSongs.filter(row => row.rank === rank).map(row => row.song), 'artist-latest-local-fallback');
            if (result) return decorateRelease(result);
          }
        }
        const releaseRefusal = refusal();
        if (releaseRefusal) return decorateRelease(releaseRefusal);
        return {
          track: null,
          source: errors.length ? 'lookup-error' : 'no-match',
          outcome: 'no-match',
          errors,
          releaseResolution,
        };
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

  // Exact identity requests may inspect the named artist's real catalogue for
  // aliases and alternatives, but they never enter similarity, mood, genre,
  // language, or starred fallback pools.
  if (deps.exactOnly && title) {
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
    if (languageGenre) {
      const result = select(await safe('language tracks', () => catalog.getSongsByGenreSampled(languageGenre!, { count: 100, signal: deps.signal }), []), `language-genre:${languageGenre}`);
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
