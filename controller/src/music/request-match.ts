// Direct requests: interpret once, then resolve identity and eligibility in code.
// No model tools or station/session state belong in this module.
import { artistNameKey, artistParticipantKeys, nameKey } from './recency.js';

export interface RequestMatch {
  kind?: string;
  title?: string | null;
  album?: string | null;
  artist?: string | null;
  genre?: string | null;
  language?: string | null;
  mood?: string | null;
  sort?: string | null;
  scope?: string;
  search_terms?: string[];
  intent?: string;
  ack?: string;
  unsupported?: string[];
  // Controller-owned markers; never part of the model's interpretation schema.
  literal?: boolean;
  // A literal "A - B" or "A, B" whose words do not say which side is the artist.
  reversible?: boolean;
  // Names need catalogue proof before they may hide condition words.
  unverifiedConditions?: string[];
}

export interface RequestSong {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  year?: number;
  originalReleaseDate?: { year?: number; month?: number; day?: number };
  releaseDate?: string;
  genre?: string;
  genres?: Array<string | { name: string }>;
  language?: string;
  languages?: string[];
  moods?: string[];
  [key: string]: unknown;
}

export interface RequestCatalog {
  searchPage(query: string, options: { songCount: number; songOffset: number }): Promise<{ songs: RequestSong[]; rawCount: number }>;
  resolveArtist(name: string): Promise<{ id: string; name?: string } | null>;
  getArtist(id: string): Promise<{ album?: Array<{ id: string; name?: string; title?: string; year?: number; originalReleaseDate?: { year?: number; month?: number; day?: number }; releaseDate?: string }> } | null>;
  getAlbum(id: string): Promise<RequestSong[]>;
  getTopSongs(name: string, options: { count: number }): Promise<RequestSong[]>;
  resolveGenreName(name: string): Promise<string | null>;
  getGenres?(): Promise<Array<{ value: string }>>;
  getSongsByGenreSampled(genre: string, options: { count: number }): Promise<RequestSong[]>;
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

export function requestName(value: unknown): string {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’‘']/g, '').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
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
const requestLanguageCodes = ['en', 'fr', 'de', 'es', 'it', 'pt', 'pa', 'hi', 'ur', 'tr', 'ar', 'ja', 'ko', 'zh', 'yue', 'ru', 'pl', 'nl', 'bn', 'ta', 'te', 'mr'];
const englishLanguageNames = new Intl.DisplayNames(['en'], { type: 'language' });
const translatedLanguageNames = new Map<string, string[]>();

function requestLanguageCode(name: string): string | undefined {
  const term = requestName(name);
  return requestLanguageCodes.find(code => requestName(englishLanguageNames.of(code)) === term)
    || (term === 'mandarin' ? 'zh' : undefined);
}

function requestLanguageTerms(name: string): string[] {
  const term = requestName(name);
  const code = requestLanguageCode(name);
  if (!code) return [term];
  // Cache only the fixed set of language codes, never arbitrary model strings.
  if (!translatedLanguageNames.has(code)) {
    translatedLanguageNames.set(code, [...new Set(requestLanguageCodes.map(locale =>
      requestName(new Intl.DisplayNames([locale], { type: 'language' }).of(code))))]);
  }
  return [term, ...translatedLanguageNames.get(code)!];
}

export function explicitRequestAttribute(text: string, match: RequestMatch, value: string | null | undefined): boolean {
  if (!value) return false;
  const prose = requestName(requestConditionProse(text, match));
  const terms = value === match.language ? requestLanguageTerms(value) : [requestName(value)];
  return terms.some(term => {
    // Spacing/punctuation may change during canonicalisation (hiphop/hip hop),
    // but a shared substring inside a different word (rap/trap) is no evidence.
    const letters = [...term.replace(/ /g, '')].join(' *');
    return !!letters && new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${letters}(?![\\p{L}\\p{N}\\p{M}])`, 'u').test(prose);
  });
}

function requestGenreMatches(want: string, got: string): boolean {
  const target = requestName(want), tag = requestName(got);
  return !!target && (target.replace(/ /g, '') === tag.replace(/ /g, '') || ` ${tag} `.includes(` ${target} `));
}

// Request-only strictness: shared genre resolution remains fuzzy for shows,
// journeys and the picker. Prefer a strict catalogue hit over a fuzzy first hit.
export async function resolveRequestGenre(catalog: RequestCatalog, name: string): Promise<string | null> {
  if (catalog.getGenres) {
    const genres = await catalog.getGenres();
    return genres.find(g => requestName(g.value).replace(/ /g, '') === requestName(name).replace(/ /g, ''))?.value
      || genres.find(g => requestGenreMatches(name, g.value))?.value || null;
  }
  const genre = await catalog.resolveGenreName(name);
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

export function requestArtistMatches(want: unknown, song: RequestSong): boolean {
  const artist = artistIdentityKey(want);
  if (!artist) return true;
  const credits = [song.artist, ...(Array.isArray(song.artists) ? song.artists.map(a => (a as { name?: string })?.name) : [])];
  return credits.some(credit => [artistNameKey(credit), ...artistParticipantKeys(String(credit ?? ''))]
    .some(key => artistIdentityKey(key) === artist));
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
const EDITION = /\s*(?:[-–—]\s*|\(|\[)(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+(?:\d{4}|version|edition))*|radio\s+edit|single\s+version|album\s+version|explicit(?:\s+version)?)[\])]?\s*$/i;

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
  if (requestName(want) === requestName(got)) return true;
  const wanted = undecorated(want, FEATURED_CREDIT);
  const edition = undecorated(want, [...FEATURED_CREDIT, EDITION]) !== wanted;
  return wanted === undecorated(got, edition ? FEATURED_CREDIT : [...FEATURED_CREDIT, EDITION]);
}

export function modelFreeRequest(text: string): RequestMatch {
  const cleaned = text.replace(REQUEST_LEAD, '').replace(/\s+please[.!?]*$/i, '').trim();
  const unquote = (s: string) => s.replace(/^["'“‘]|["'”’][.!?]*$/g, '').trim();
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
  const by = pair(separators.match(/\s+by\s+/i), true);
  const artistOnly = query.match(/^(?:some|(?:anything|something|music|a song|a track) (?:by|from))\s+(.+?)[.!?]*$/i);
  const describedArtist = query.match(/^(?:some|anything|something|music|a song|a track)\s+(.+?)\s+by\s+(.+?)[.!?]*$/i);
  const knownMood = describedArtist && /^(?:energetic|calm|reflective|celebratory|romantic|spiritual|focus|workout|driving|cooking|rainy|sunny|night|morning|evening|festival|cultural)$/i.test(describedArtist[1]);
  if (artistOnly || knownMood) return { kind: 'track', artist: unquote(artistOnly?.[1] || describedArtist![2]), title: null,
    unverifiedConditions, language: language?.[1] || null, mood: describedArtist?.[1] || null, album: null, search_terms: [], scope: 'song', ack: '' };
  const separated = !by && pair(separators.match(/,\s*/) || separators.match(/\s+[-–—]\s+/));
  const title = unquote(by?.[1] || separated?.[2] || query);
  const artist = by?.[2] || separated?.[1] || null;
  return { kind: 'track', title, album: null, unverifiedConditions, artist: artist ? unquote(artist) : null, reversible: !!separated,
    search_terms: [title], genre: null, language: language?.[1] || null, mood: null, sort: null,
    scope: 'song', intent: 'library search without model interpretation', ack: '' };
}

// A model reply repaired against the literal reading of the same words.
export function repairRequestMatch(match: RequestMatch, text: string): RequestMatch {
  if (match.kind === 'chat') return match;
  const literal = modelFreeRequest(text);
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
  fallbackSongs(): Promise<RequestSong[]>;
  similarSongs?(): Promise<RequestSong[]>;
  random?: () => number;
  choose?(pool: RequestSong[]): RequestSong | null;
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
    try { return await run(); } catch (err) { errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`); return fallback; }
  };
  let title = requestedTitle(match, deps.text);
  let artistName = match.artist;
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
  const moodIds = new Set(moodPool.map(song => song.id));
  const moodMatches = (song: RequestSong) => !match.mood || moodIds.has(song.id)
    || Boolean(song.moods?.some(m => requestName(m) === requestName(match.mood)));
  let resolvedArtistName = match.artist;
  const identity = (song: RequestSong) => (!title || requestTitleMatches(title, song.title))
    && requestArtistMatches(resolvedArtistName, song) && (!match.album || requestName(song.album) === requestName(match.album));
  const tags = (song: RequestSong) => [song.genre, ...(song.genres || []).map(g => typeof g === 'string' ? g : g.name)].map(requestName).filter(Boolean);
  let genre: string | null = null;
  let languageGenre: string | null = null;
  // Small models may guess attributes despite the prompt. Only terms present
  // outside recognised names are hard requirements; guesses stay preferences.
  if (match.genre) genre = await safe('genre resolution', () => resolveRequestGenre(catalog, match.genre!), null);
  if (match.language) languageGenre = await safe('language resolution', () => resolveRequestGenre(catalog, match.language!), null);
  const genreMatches = (song: RequestSong) => !match.genre || tags(song).some(g => requestGenreMatches(genre || match.genre!, g));
  const languageMatches = (song: RequestSong) => !match.language
    || [song.language, ...(song.languages || []), ...tags(song)].map(requestName).includes(requestName(match.language));
  const constraints = (song: RequestSong, source: string) =>
    (!requiredGenre || (genre && source === `genre:${genre}`) || genreMatches(song))
    && (!requiredLanguage || (languageGenre && source === `language-genre:${languageGenre}`) || languageMatches(song));
  const eligible = (song: RequestSong) => !recentIds.has(song.id) && !queuedIds.has(song.id) && song.id !== currentId;
  const unique = (songs: RequestSong[]) => [...new Map(songs.filter(s => s?.id).map(s => [s.id, s])).values()];
  const choose = (songs: RequestSong[]) => {
    const score = (song: RequestSong) => Number(!!match.mood && moodMatches(song))
      + Number(!!match.genre && !requiredGenre && genreMatches(song))
      + Number(!!match.language && !requiredLanguage && languageMatches(song));
    const best = songs.reduce((best, song) => Math.max(best, score(song)), 0);
    const pool = songs.filter(song => score(song) === best);
    if (deps.choose) return deps.choose(pool);
    return pool[Math.min(pool.length - 1, Math.floor((deps.random || Math.random)() * pool.length))] || null;
  };
  let held: { track: RequestSong; source: string } | null = null;
  const select = (songs: RequestSong[], source: string, exact = true): RequestSelection | null => {
    const pool = unique(songs).filter(s => constraints(s, source) && (!exact || identity(s)));
    const track = choose(pool.filter(eligible));
    const named = exact && !standingIn;
    if (track) {
      const unmetPreferences = [!moodMatches(track) && 'mood', !genreMatches(track) && 'genre', !languageMatches(track) && 'language'].filter((value): value is string => !!value);
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
    // Bounded, deterministic pages. rawCount includes filtered/blocked rows.
    for (let songOffset = 0; songOffset < 100; songOffset += 25) {
      const page = await safe('search', () => catalog.searchPage(term, { songCount: 25, songOffset }), { songs: [], rawCount: 0 });
      found.push(...page.songs);
      if (found.some(s => identity(s) && constraints(s, 'search') && (Boolean(title) || eligible(s))) || page.rawCount < 25) break;
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

  if (match.literal && !artistName && title) {
    artistName = title;
    resolvedArtistName = title;
    title = null;
  }
  if (artistName) {
    if (match.sort === 'popular' && !title && !match.album) {
      const popular = await safe('popular songs', () => catalog.getTopSongs(artistName!, { count: 100 }), []);
      const candidates = unique(popular).filter(s => identity(s) && constraints(s, 'artist-popular'));
      const best = candidates.find(eligible) || candidates[0];
      const result = select(best ? [best] : [], 'artist-popular');
      if (result) return result;
    }
    const artist = await safe('artist resolution', () => catalog.resolveArtist(artistName!), null);
    if (artist && ((!match.literal && !unverifiedConditions.length) || requestArtistMatches(artistName, { id: artist.id, artist: artist.name }))) {
      resolvedArtistName = artist.name || artistName;
      // The title search judged its hits against the listener's spelling of
      // the artist; the library's own spelling may prove one of them.
      if (title && resolvedArtistName !== artistName) {
        const exact = select(searched, 'search') || refusal();
        if (exact) return exact;
      }
      const full = await safe('artist albums', () => catalog.getArtist(artist.id), null);
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
        const songs = await safe('album tracks', () => catalog.getAlbum(album.id), []);
        if (title) artistAlternatives.push(...songs.filter(song => requestArtistMatches(resolvedArtistName, song)));
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

  if (!title && !match.album) {
    if (genre) {
      const result = select(await safe('genre tracks', () => catalog.getSongsByGenreSampled(genre!, { count: 100 }), []), `genre:${genre}`);
      if (result) return result;
    }
    if (languageGenre) {
      const result = select(await safe('language tracks', () => catalog.getSongsByGenreSampled(languageGenre!, { count: 100 }), []), `language-genre:${languageGenre}`);
      if (result) return result;
    }
    if (match.mood) {
      const result = select(moodPool, `library-mood:${match.mood}`);
      if (result) return result;
    }
    const constrainedRefusal = refusal();
    if (constrainedRefusal) return constrainedRefusal;
  }
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
  return fallback || { track: null, source: errors.length ? 'lookup-error' : 'no-match', outcome: 'no-match', errors, required };
}
