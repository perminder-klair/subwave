// Controller-owned proof that Musical Leanings changed an Agentic pick.
//
// The review model can propose a replacement, but it cannot certify its own
// influence. A replacement only counts when it differs from the Leanings-blind
// preliminary pick, remains the final choice after the station guards, and is
// actually accepted by the queue.

import { bpmCompat, keyCompat } from '../../music/mix.js';

// What modelTolerant writes when a review or Shortlist pick returns an
// unusable musicalReason. It must never reach the Booth as if it were prose,
// so every reason builder treats it as absent.
export const MUSICAL_REASON_UNAVAILABLE = '[musical reason unavailable]';

export type AgenticTrackRef = {
  id: string;
  title: string | null;
  artist: string | null;
};

export type AgenticLeaningsReviewOutcome = 'not-run' | 'kept' | 'replaced' | 'invalid' | 'failed';

export type AgenticLeaningsReviewRejection =
  | 'unknown-candidate'
  | 'missing-leanings-basis'
  | 'basis-not-in-leanings'
  | 'basis-not-supported-by-candidate'
  | 'basis-already-supported-by-baseline'
  | 'not-flow-tie'
  | 'weak-musical-reason'
  | 'invalid-editorial-evidence';

// One settled record of a pick for Debug and the event log, shared by both
// selection routes so a field added for one cannot silently go missing from
// the other. It rides the LLM call records by reference and is filled in only
// after the guards and enqueue.
export type PickResolution = {
  preliminary?: AgenticTrackRef;
  leaningsReview?: {
    outcome: AgenticLeaningsReviewOutcome;
    replacementId: string | null;
    track?: AgenticTrackRef | null;
    leaningsBasis?: string | null;
    baselineId?: string | null;
    reviewedSelectedId?: string | null;
    candidateIds?: string[];
    leaningsOptions?: string[];
    leaningsSources?: AgenticLeaningsOption[];
    leaningsSource?: 'host' | 'guest' | null;
    proposedReplacementId?: string | null;
    rejectionReason?: AgenticLeaningsReviewRejection | null;
    evidenceKind?: 'metadata-match' | 'editorial-comparison';
    editorialEvidence?: EditorialLeaningsEvidence;
  };
  guardOutcome?: 'none' | 'artist-repick' | 'album-repick' | 'artist-and-album-repick' | 'pool-rescue';
  final?: AgenticTrackRef;
  reason?: string | null;
  queued?: boolean;
  usedMusicalLeanings?: boolean;
  rejectionReason?: AgenticLeaningsReviewRejection | 'queue-collision' | 'pool-rescue' | null;
};

export type AgenticPickResolution = PickResolution;

export function agenticTrackRef(song: { id: unknown; title?: unknown; artist?: unknown }): AgenticTrackRef {
  return {
    id: String(song.id),
    title: typeof song.title === 'string' ? song.title : null,
    artist: typeof song.artist === 'string' ? song.artist : null,
  };
}

function identityComparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bfeaturing\b/g, 'feat').replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function trimDanglingEnding(value: string): string {
  return value.replace(/\s*[,;:]\s*(?:and|or|but)?\s*$/i, '').replace(/\s+(?:and|or|but)\s*$/i, '').trim();
}

// The part of a stored name a note can be expected to say. Titles and credits
// often carry a feature list or an edition tag — "Final Warning (feat. Bun B,
// Shawty Lo, …)", "Bumpin My Song Feat. J.Hind", "Alien Girl (Today W/ Her)" —
// that no model repeats in a sentence, so requiring the full string replaced
// notes that named the track correctly with plain copy. Splits on feat./ft./
// featuring only, as the blocklist does: `&`, `,` and `x` live inside real names.
function coreName(raw: string): string {
  return raw
    .replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, '')
    .replace(/\s+[-–—]\s+.*$/, '')
    .trim();
}

// Does the note say this name? The full name as before, or its core as whole
// words — a short core ("Up") as a bare substring would match "upbeat", and a
// core of one short word is too common to count as naming anything.
function noteNames(note: string, raw: string): boolean {
  const full = identityComparable(raw);
  if (!full || note.includes(full)) return true;
  const core = identityComparable(coreName(raw));
  if (!core || core === full) return false;
  if (!core.includes(' ') && core.length < 4) return false;
  return ` ${note} `.includes(` ${core} `);
}

// Agentic reasons are verified against the final track at the queue boundary.
// This keeps useful model variation while preventing a guard replacement from
// inheriting another track's explanation or Shortlist-specific wording.
export function agenticSelectionReason(track: any, reason: unknown): string {
  const titleRaw = typeof track?.title === 'string' ? track.title.trim() : '';
  const artistRaw = typeof track?.artist === 'string' ? track.artist.trim() : '';
  const note = identityComparable(reason);
  const namesTitle = noteNames(note, titleRaw);
  if (note && namesTitle && noteNames(note, artistRaw)) return String(reason).trim();

  const raw = typeof reason === 'string' ? trimDanglingEnding(reason.replace(/\s+/g, ' ')) : '';
  if (raw && titleRaw && artistRaw && identityComparable(artistRaw) && !namesTitle) {
    const remainder = raw.replace(new RegExp(`^${escapeRegExp(artistRaw)}\\s*[-—,:]?\\s*`, 'i'), '').trim();
    if (/^(?:fits|works|brings|keeps|matches|follows|continues|adds|carries|suits|makes|offers)\b/i.test(remainder)) {
      return `“${titleRaw}” by ${artistRaw} — ${/[.!?]$/.test(remainder) ? remainder : `${remainder}.`}`;
    }
  }
  return plainAgenticSelectionReason(track);
}

// The plain copy a note becomes when it cannot be grounded on the track.
// Exported so the pick path can tell a discarded note from a kept one.
export function plainAgenticSelectionReason(track: any): string {
  const titleRaw = typeof track?.title === 'string' ? track.title.trim() : '';
  const artistRaw = typeof track?.artist === 'string' ? track.artist.trim() : '';
  const credited = titleRaw && artistRaw ? `“${titleRaw}” by ${artistRaw}` : titleRaw ? `“${titleRaw}”` : artistRaw ? `A track by ${artistRaw}` : '';
  return credited ? `${credited} offers a strong musical fit with the current flow.` : 'Selected for its strong musical fit with the current flow.';
}

const QUEUE_LANGUAGE = /\b(?:next\s+up|up\s+next|coming\s+up|we(?:'|’)re\s+playing|we\s+have)\b/i;
const LEANINGS_REFERENCE = /\b(?:reflecting\b.*\btaste\s+for|(?:musical\s+)?leanings?|broad\s+alternative\s+taste|(?:dj|host)(?:['’]s)?\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?)|(?:my|his|her|their)\s+(?:musical\s+)?(?:taste|tastes|preference|preferences)|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}['’](?:s)?\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?))\b/i;

function usableAgenticReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  const note = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (note.length >= 24 && !QUEUE_LANGUAGE.test(note) && note !== '[selection note unavailable]') return note;
  const artist = typeof song.artist === 'string' && song.artist.trim() ? song.artist.trim() : 'This artist';
  const title = typeof song.title === 'string' && song.title.trim() ? song.title.trim() : 'this track';
  return `${artist} — ${title}: selected for its fit with the current musical flow.`;
}

// A capitalised run of two or more words in a note may be a track or an act —
// the one shape groundPickNote cannot check, since it only knows the names the
// model was shown, not one it recalled. But most runs in a real note are the
// queued track's own credit or album, the context the pick was handed, or a
// genre ("Amrinder Gill", "Coke Studio", "Taylor Swift", "Regional Indian"),
// and treating those as foreign threw away 7 of 13 accurate notes. A run is
// foreign only when no known name contains it; a sentence's opening word is
// capitalised anyway, so a run starting a sentence is also known when the
// rest of it is ("Fresh Punjabi voices").
const NAMED_RUN = /\b[\p{Lu}][\p{L}’'-]+(?:\s+[\p{Lu}][\p{L}’'-]+)+\b/gu;
const CREDIT_SPLIT = /\s*(?:,|&|\+|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i;

function trackKnownNames(track: any): string[] {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const title = str(track?.title);
  const artist = str(track?.artist);
  const genres = Array.isArray(track?.genres) ? track.genres.map(str) : str(track?.genre).split(',');
  return [title, coreName(title), artist, ...artist.split(CREDIT_SPLIT), str(track?.album), ...genres];
}

function namesForeignRun(raw: string, known: string[]): boolean {
  const names = known.map(identityComparable).filter(Boolean).map((k) => ` ${k} `);
  const isKnown = (run: string) => {
    const c = identityComparable(run.replace(/['’]s\b/g, ''));
    return !!c && names.some((k) => k.includes(` ${c} `));
  };
  for (const m of raw.matchAll(NAMED_RUN)) {
    if (isKnown(m[0])) continue;
    const opensSentence = /(?:^|[.!?]\s+)$/.test(raw.slice(0, m.index));
    if (opensSentence && isKnown(m[0].replace(/^\S+\s+/, ''))) continue;
    return true;
  }
  return false;
}

// `references` are the names a pick was handed as context (pick-note.ts
// pickNoteReferences): the track it follows, what is on air, queued and
// recently played, and the show's name, topic and genres.
export function agenticDiscoverySelectionReason(track: any, reason: unknown, references: Array<string | null | undefined> = []): string {
  const raw = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  const known = [...trackKnownNames(track), ...references.map((r) => (typeof r === 'string' ? r : ''))];
  const looksLikeNamedIdentity = /[“”"]/.test(raw) || namesForeignRun(raw, known);
  if (raw.length >= 24 && !QUEUE_LANGUAGE.test(raw) && !looksLikeNamedIdentity) {
    const title = typeof track?.title === 'string' ? track.title.trim() : '';
    const artist = typeof track?.artist === 'string' ? track.artist.trim() : '';
    const credited = title && artist ? `“${title}” by ${artist}` : title ? `“${title}”` : artist ? `A track by ${artist}` : '';
    if (credited) return `${credited} — ${/[.!?]$/.test(raw) ? raw : `${raw}.`}`;
  }
  return agenticSelectionReason(track, reason);
}

export function agenticReasonMentionsLeanings(reason: unknown): boolean {
  return LEANINGS_REFERENCE.test(String(reason ?? ''));
}

export function leaningsBlindPickReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  return agenticReasonMentionsLeanings(reason) ? usableAgenticReason('', song) : String(reason ?? '');
}

export function verifiedAgenticReason(reason: unknown, usedMusicalLeanings: boolean, song: { artist?: unknown; title?: unknown }): string {
  return usableAgenticReason(usedMusicalLeanings ? reason : leaningsBlindPickReason(reason, song), song);
}

function comparable(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKD').toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

const LEANINGS_TRIGGER = /\b(?:leans?(?:\s+strongly)?\s+towards?|(?:strongly\s+)?favou?rs?|enjoys?|values?|prefers?|loves?|(?:is|are)\s+receptive\s+to|(?:is|are)\s+curious\s+about|tastes?\s+spanning|preferences?\s+include|move(?:s)?\s+between)\b/gi;
const TRAILING_CONTEXT = /\b(?:when|while|rather\s+than|without|if|over\s+extremes)\b.*$/i;
const UNHELPFUL_SINGLE_WORDS = new Set(['music', 'track', 'tracks', 'record', 'records', 'material', 'sounds']);

// Leanings are positive-only (#1994). The review swaps only TOWARDS a phrase
// and credits it as "<owner>'s taste for <phrase>", so a line written to steer
// away has nowhere to go: read as a phrase it becomes a taste for the very
// thing it rules out. Every reading below drops it instead. "no wave" is a
// genre, and a hyphenated "no-frills" or "hate-fuelled" is one word. Idioms
// that speak of a fondness ("can't get enough of", "never tires of", "not
// least", "not to mention", "no matter") are not negations either. The
// boundaries are Unicode-aware, since \b reads "Noël" and "Ōno" as holding
// the word "no". "refused" and "nothing" stay off the list: each is also a
// band, and a cue costs any list that names one.
const NEGATIVE_CUE = /(?<![\p{L}\p{N}])(?:avoid(?:s|ed|ing)?|dislik(?:e|es|ed|ing)|hat(?:e|es|ed|ing)|detest(?:s|ed|ing)?|loath(?:e|es|ed|ing)|shun(?:s|ned|ning)?|skip(?:s|ped|ping)?|exclud(?:e|es|ed)|refus(?:e|es|ing)|steer(?:s|ed|ing)?\s+(?:clear|away)|(?:stay|keep)(?:s|ing)?\s+away|(?:stayed|kept)\s+away|never(?!\s+(?:tires?|tired|gets?\s+tired|fails?)\b)|not(?!\s+(?:just|only|merely|simply|least|to\s+mention)\b)|nor|neither|no(?!\s+(?:wave|matter)\b)|(?:cannot|[a-z]+n['’]t)(?!\s+(?:get\s+enough|resist)\b)|rarely|seldom|hardly)(?![\p{L}\p{N}-])/iu;
// A cue inside one of these qualifies the preference rather than reversing it:
// "records that never outstay their welcome", "dub with no vocals".
const QUALIFYING_TAIL = /\b(?:that|which|who|whose|where|with\s+(?:little\s+(?:or|to)\s+)?no|with\s+hardly\s+any)\b.*$/i;
// An exclusion always ends a sentence's positive text; a contrast ends it only
// when the clause it opens steers away ("anything but metal" stays one phrase).
const EXCLUSION = /\s*,?\s*\b(?:except(?:\s+for)?|excluding|apart\s+from|other\s+than)\b/i;
const CONTRAST = /\s*,?\s*(?:\b(?:but|yet|though|although|whereas|however)\b|\s[-–—]\s|[–—])/gi;

// A Japanese title's "no" ("Shingeki no Kyojin", "Mayonaka no Door") is a
// particle between two capitalised words, never a negation.
const NAME_PARTICLE = /(?<=(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}'’-]*\s+)no(?=\s+\p{Lu})/gu;

// "rarely heard deep cuts" describes the records, not the presenter: an
// adverb on a participle that opens a noun phrase belongs to that phrase.
const RARE_RECORDS = /^\s*(?:(?:the|a|an|some|those|these|their|its)\s+)?(?:rarely|seldom|hardly)\s+(?=(?:heard|played|aired|seen|known|spun|released)\s+(?!(?:on|in|at|by|to|for|here|there|now|anymore|much|often|ever|any)\b)[\p{L}\p{N}])/iu;

// An example is a name: after "like", "such as", "including", "especially" or
// "e.g." a run of capitalised words ("The Seldom Scene", "No Doubt") is an act,
// not a negation. Nobody writes "soul like Never Metal", and a lowercase cue is
// never read this way. Elsewhere a capitalised cue still ends its list, since
// "Rancid, No Doubt" and "Soul, No Metal" cannot be told apart from the text.
// No `i` flag: under it \p{Lu} matches lowercase letters too.
const EXAMPLE_NAME = /(?<=(?<![\p{L}\p{N}])(?:[Ll]ike|[Ss]uch\s+as|[Ii]ncluding|[Ee]specially|[Ee]\.g\.?)\s+)\p{Lu}[\p{L}\p{N}'’-]*(?:\s+\p{Lu}[\p{L}\p{N}'’-]*)+/gu;

function negates(text: string): boolean {
  return NEGATIVE_CUE.test(text.replace(RARE_RECORDS, '').replace(NAME_PARTICLE, ' ').replace(EXAMPLE_NAME, ' '));
}

function reversesPreference(text: string): boolean {
  const core = text.replace(TRAILING_CONTEXT, '');
  // A qualifier needs something to qualify: "with no metal" standing alone is
  // an exclusion, and kept it would be read as a taste for "no metal".
  const tail = QUALIFYING_TAIL.exec(core);
  return negates(tail && /[\p{L}\p{N}]/u.test(core.slice(0, tail.index)) ? core.slice(0, tail.index) : core);
}

function positiveText(text: string): string {
  const exclusion = EXCLUSION.exec(text);
  const end = exclusion ? exclusion.index : text.length;
  for (const contrast of text.slice(0, end).matchAll(CONTRAST)) {
    const clause = text.slice(contrast.index + contrast[0].length, end).split(',')[0];
    if (reversesPreference(clause)) return text.slice(0, contrast.index);
  }
  return text.slice(0, end);
}

// A whole item that names no taste at all: "anything", "all genres", "open to
// anything". The trigger is allowed for the noun-phrase fallback, which reads
// "Loves anything" with its verb.
const UNIVERSAL = new RegExp(String.raw`^\s*(?:(?:and|or|plays?|(?:(?:is|are)\s+)?open\s+to|${LEANINGS_TRIGGER.source})\s+)?(?:anything|everything|whatever|all|any)(?:\s+(?:genres?|styles?|kinds?|sorts?|types?|music|sounds?|records?|tracks?|songs?))?\s*$`, 'i');

// A list stops at its first item that steers away: in "soul, never stadium
// rock and metal" the "never" governs every item after it. Once anything is
// dropped, a universal item goes too: "anything except metal" kept as
// "anything" would be a taste that covers metal.
function positiveItems(text: string, separator: RegExp): string[] {
  const kept = positiveText(text);
  let dropped = kept.length < text.length;
  const items: string[] = [];
  for (const item of kept.split(separator)) {
    if (reversesPreference(item)) {
      dropped = true;
      break;
    }
    items.push(item);
  }
  return dropped ? items.filter((item) => !UNIVERSAL.test(item)) : items;
}

// What a negation left hanging needs to finish it: "Does not, and will never,
// enjoy metal", "Doesn't, and never will, …", "Never once, in years, …".
const DANGLING = /(?<![\p{L}\p{N}])(?:will|would|shall|should|can|could|may|might|must|do|does|did|ever|once)\s*$/iu;

// "Does not favour …" and "He never enjoys …" negate the trigger itself. A
// contrast before it opens a new clause, so "Avoids X but loves Y" keeps Y,
// and so does "Doesn't favour X but loves Y": the sentence is read from its
// first trigger that is not negated. A comma or "and" opens one too ("Hates X,
// loves Y", "Avoids X and loves Y"), unless the negation before it is still
// waiting for its verb: "Never, ever enjoys metal", "Doesn't, frankly, enjoy
// metal".
function negatedTrigger(sentence: string, trigger: RegExpExecArray): boolean {
  const head = sentence.slice(0, trigger.index);
  const opening = [...head.matchAll(CONTRAST)].at(-1);
  const clauses = (opening ? head.slice(opening.index + opening[0].length) : head).split(/,|\band\b/i);
  if (negates(clauses.at(-1)!)) return true;
  const negated = clauses.slice(0, -1).reverse().find(negates)?.trim();
  return negated !== undefined && (DANGLING.test(negated) || negates(negated.split(/\s+/).at(-1)!));
}

function cleanLeaningsPhrase(value: string): string | null {
  const phrase = value
    .replace(TRAILING_CONTEXT, '')
    .replace(/^(?:and|or|towards?|to|for|with|the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
  if (phrase.length < 2 || phrase.length > 100) return null;
  const words = phrase.split(/\s+/);
  if (words.length > 10) return null;
  if (words.length === 1 && UNHELPFUL_SINGLE_WORDS.has(phrase.toLocaleLowerCase('en-GB'))) return null;
  return phrase;
}

export type AgenticLeaningsOption = {
  phrase: string;
  source: 'host' | 'guest';
  ownerName: string | null;
};

function phrasesFromSource(source: string): string[] {
  const phrases: string[] = [];
  const add = (rawPart: string) => {
    const phrase = cleanLeaningsPhrase(rawPart);
    if (phrase && !phrases.some((item) => comparable(item) === comparable(phrase))) phrases.push(phrase);
  };
  // The dots of "e.g." do not end a sentence: the examples after it belong to
  // the preference before it.
  const sentences = source.split(/(?:(?!(?<=(?<![\p{L}\p{N}])e)\.g\.)(?<!(?<![\p{L}\p{N}])e\.g)\.|[!?;])+/iu).map((sentence) => sentence.trim());
  for (const sentence of sentences) {
    const trigger = [...sentence.matchAll(LEANINGS_TRIGGER)].find((match) => !negatedTrigger(sentence, match));
    if (!trigger) continue;
    const preference = sentence.slice(trigger.index + trigger[0].length).trim();
    positiveItems(preference, /\s*,\s*|\s+and\s+|\s+alongside\s+|\s+across\s+/i).forEach(add);
  }
  if (phrases.length === 0) {
    for (const sentence of sentences) positiveItems(sentence, /\s*,+\s*|\s+and\s+/i).forEach(add);
  }
  return phrases;
}

export function agenticLeaningsSources(editorialLeanings: {
  host?: string | null;
  guest?: { guest?: { name: string }; musicalLeanings?: string | null } | null;
} | null, hostName: string | null = null): AgenticLeaningsOption[] {
  const sources: AgenticLeaningsOption[] = [];
  const add = (text: string | null | undefined, source: 'host' | 'guest', ownerName: string | null) => {
    if (!text?.trim()) return;
    for (const phrase of phrasesFromSource(text).slice(0, 16)) {
      if (!sources.some((item) => comparable(item.phrase) === comparable(phrase))) sources.push({ phrase, source, ownerName });
    }
  };
  add(editorialLeanings?.host, 'host', hostName);
  add(editorialLeanings?.guest?.musicalLeanings, 'guest', editorialLeanings?.guest?.guest?.name ?? null);
  return sources;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? value.split(',') : [];
}

function energyDistance(left: unknown, right: unknown): number {
  const levels = new Map([['low', 0], ['medium', 1], ['high', 2]]);
  const a = levels.get(String(left ?? '').toLocaleLowerCase('en-GB'));
  const b = levels.get(String(right ?? '').toLocaleLowerCase('en-GB'));
  if (a === undefined || b === undefined) return 0;
  return a === b ? 2 : Math.abs(a - b) === 1 ? 0.5 : 0;
}

function overlapScore(left: unknown, right: unknown): number {
  const a = new Set(stringList(left).map(comparable).filter(Boolean));
  const b = new Set(stringList(right).map(comparable).filter(Boolean));
  return [...a].some((value) => b.has(value)) ? 1 : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ordinarySimilarity(baseline: any, candidate: any): number {
  return energyDistance(baseline?.energy, candidate?.energy)
    + 1.5 * overlapScore(baseline?.moods, candidate?.moods)
    + 0.75 * overlapScore(baseline?.genre, candidate?.genre)
    + 1.5 * bpmCompat(finiteNumber(baseline?.bpm), finiteNumber(candidate?.bpm))
    + keyCompat(typeof baseline?.key === 'string' ? baseline.key : null, typeof candidate?.key === 'string' ? candidate.key : null)
    + (baseline?.instrumental === candidate?.instrumental && baseline?.instrumental != null ? 0.25 : 0);
}

const MIN_REVIEW_FLOW_SCORE = 2.5;

const METADATA_GENERIC_WORDS = new Set(['music', 'track', 'tracks', 'record', 'records', 'material', 'sounds']);

function exactLeaningsMetadataMatches(candidate: any, leaningsOptions: string[]): string[] {
  const metadata = comparable([candidate?.genre, ...stringList(candidate?.moods), ...stringList(candidate?.lastfm_tags)].filter(Boolean).join(' '));
  const metadataWords = new Set(metadata.split(' ').filter(Boolean));
  return leaningsOptions.filter((option) => {
    const phrase = comparable(option);
    if (!phrase) return false;
    if (` ${metadata} `.includes(` ${phrase} `)) return true;
    const meaningful = phrase.split(' ').filter((word) => !METADATA_GENERIC_WORDS.has(word));
    return meaningful.length > 0 && meaningful.every((word) => metadataWords.has(word));
  });
}

function exactLeaningsMetadataScore(candidate: any, leaningsOptions: string[]): number {
  return exactLeaningsMetadataMatches(candidate, leaningsOptions).reduce(
    (score, phrase) => score + Math.min(3, comparable(phrase).split(' ').length),
    0,
  );
}

// Host preferences win whenever the baseline or a viable challenger supports
// them. A guest can nudge only a choice the host's supplied evidence cannot settle.
export function eligibleAgenticLeanings(baseline: any, candidates: any[], sources: AgenticLeaningsOption[]): AgenticLeaningsOption[] {
  const host = sources.filter(({ source }) => source === 'host');
  const hostPhrases = host.map(({ phrase }) => phrase);
  const hostSupported = [baseline, ...candidates].some((candidate) =>
    (String(candidate?.id) === String(baseline?.id) || ordinarySimilarity(baseline, candidate) >= MIN_REVIEW_FLOW_SCORE)
    && exactLeaningsMetadataMatches(candidate, hostPhrases).length > 0);
  return hostSupported ? host : sources;
}

export function selectAgenticReviewCandidates(baseline: any, candidates: any[], leaningsOptions: string[] = [], limit = 6): any[] {
  if (!baseline?.id) return [];
  const baselineId = String(baseline.id);
  // Reserve evidence slots for preferences that distinguish a challenger.
  // Repeated broad genre matches must not crowd out a genuine tie-break.
  const baselineMatches = new Set(exactLeaningsMetadataMatches(baseline, leaningsOptions).map(comparable));
  const distinguishingOptions = leaningsOptions.filter(option => !baselineMatches.has(comparable(option)));
  const ranked = candidates
    .filter((candidate) => candidate?.id && String(candidate.id) !== baselineId)
    .map((candidate) => ({
      candidate,
      ordinaryScore: ordinarySimilarity(baseline, candidate),
      leaningsScore: exactLeaningsMetadataScore(candidate, distinguishingOptions),
    }));
  const ordinaryRanked = [...ranked]
    .sort((left, right) => right.ordinaryScore - left.ordinaryScore || String(left.candidate.id).localeCompare(String(right.candidate.id)));
  const selected = ordinaryRanked.slice(0, Math.min(3, Math.max(1, limit - 1)));
  const selectedIds = new Set(selected.map(({ candidate }) => String(candidate.id)));
  const evidenceRanked = ranked
    // A stronger preference on a weak-flow track must not crowd out an
    // otherwise viable tie-break. Use the same floor as the review/validator.
    .filter(({ candidate, ordinaryScore, leaningsScore }) => ordinaryScore >= MIN_REVIEW_FLOW_SCORE
      && leaningsScore > 0 && !selectedIds.has(String(candidate.id)))
    .sort((left, right) => right.leaningsScore - left.leaningsScore || right.ordinaryScore - left.ordinaryScore || String(left.candidate.id).localeCompare(String(right.candidate.id)));
  for (const item of evidenceRanked) {
    if (selected.length >= limit - 1) break;
    selected.push(item);
    selectedIds.add(String(item.candidate.id));
  }
  for (const item of ordinaryRanked) {
    if (selected.length >= limit - 1) break;
    if (!selectedIds.has(String(item.candidate.id))) selected.push(item);
  }
  const alternatives = selected
    .sort((left, right) => right.ordinaryScore - left.ordinaryScore || String(left.candidate.id).localeCompare(String(right.candidate.id)))
    .map(({ candidate }) => candidate);
  return [baseline, ...alternatives];
}

export function compactAgenticReviewCandidate(track: any, leaningsOptions: string[] = [], baseline: any = null): Record<string, unknown> {
  const leaningsMatches = exactLeaningsMetadataMatches(track, leaningsOptions);
  const baselineMatches = new Set(exactLeaningsMetadataMatches(baseline, leaningsOptions).map(comparable));
  const leaningsAdvantages = baseline?.id && String(track?.id) !== String(baseline.id)
    ? leaningsMatches.filter(option => !baselineMatches.has(comparable(option)))
    : [];
  const similarity = baseline?.id ? ordinarySimilarity(baseline, track) : null;
  const flowCloseness = baseline?.id && String(track?.id) === String(baseline.id)
    ? 'baseline'
    : similarity != null
      ? similarity >= 4 ? 'close' : similarity >= MIN_REVIEW_FLOW_SCORE ? 'possible' : 'weak'
      : undefined;
  return Object.fromEntries(Object.entries({
    id: track?.id,
    title: track?.title,
    artist: track?.artist,
    year: track?.year,
    genre: track?.genre,
    lastfm_tags: stringList(track?.lastfm_tags).length ? stringList(track?.lastfm_tags).slice(0, 24) : undefined,
    moods: track?.moods,
    energy: track?.energy,
    instrumental: track?.instrumental,
    bpm: track?.bpm,
    key: track?.key,
    unaired: track?.unaired,
    play_count: track?.play_count,
    last_played_days_ago: track?.last_played_days_ago,
    leaningsMatches: leaningsMatches.length ? leaningsMatches : undefined,
    leaningsAdvantages: leaningsAdvantages.length ? leaningsAdvantages : undefined,
    flowCloseness,
  }).filter(([, value]) => value !== undefined && value !== null));
}

// Subjective interpretation belongs to the reviewer. The controller verifies
// supplied facts and a difference, not the truth of a musical taste judgement.
// So the facts must describe the music: two tracks almost always differ on
// year or station history (play_count, unaired, last_played_days_ago), and a
// "difference" that is always present grounds any comparison at all — a
// 2015-versus-1972 pair swapped a pick for "strong musicianship" (#1687 review).
export const EDITORIAL_LEANINGS_FIELDS = ['genre', 'moods', 'lastfm_tags', 'instrumental'] as const;
export type EditorialLeaningsFact = { field: typeof EDITORIAL_LEANINGS_FIELDS[number]; value: string };
export type EditorialLeaningsEvidence = {
  baselineFacts: EditorialLeaningsFact[];
  challengerFacts: EditorialLeaningsFact[];
  comparison: string;
};

// Which preferences an editorial comparison may support. Interpretation is for
// what tags cannot carry: a phrase some track in this pick's pool matches
// literally is one the metadata CAN carry, so a replacement claiming it must
// carry it too — "Favours punk" must not swap onto a track with no punk tag.
// Host priority holds here in code, not only in the prompt: while the host has
// any preference, a guest phrase can win only through an exact match.
export function interpretableAgenticLeanings(sources: AgenticLeaningsOption[], pool: any[]): string[] {
  const phrases = sources.map(({ phrase }) => phrase);
  const literal = new Set(pool.flatMap((track) => exactLeaningsMetadataMatches(track, phrases)).map(comparable));
  const hasHost = sources.some(({ source }) => source === 'host');
  return sources
    .filter(({ phrase, source }) => !literal.has(comparable(phrase)) && (source === 'host' || !hasHost))
    .map(({ phrase }) => phrase);
}

function quotedFacts(track: any, facts: unknown): EditorialLeaningsFact[] | null {
  if (!Array.isArray(facts) || facts.length < 1 || facts.length > 4) return null;
  for (const fact of facts) {
    if (!fact || !EDITORIAL_LEANINGS_FIELDS.includes(fact.field) || typeof fact.value !== 'string') return null;
    const raw = track?.[fact.field];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    if (!values.some(value => String(value) === fact.value)) return null;
  }
  return facts;
}

function groundedEditorialComparison(evidence: unknown, baseline: any, challenger: any, basis: string): evidence is EditorialLeaningsEvidence {
  if (!evidence || typeof evidence !== 'object') return false;
  const e = evidence as EditorialLeaningsEvidence;
  const left = quotedFacts(baseline, e.baselineFacts);
  const right = quotedFacts(challenger, e.challengerFacts);
  if (!left || !right || typeof e.comparison !== 'string' || e.comparison.trim().length < 32 || e.comparison.length > 480) return false;
  const comparison = comparable(e.comparison);
  const mentions = (value: string) => {
    const phrase = comparable(value);
    return !!phrase && ` ${comparison} `.includes(` ${phrase} `);
  };
  if (!mentions(basis) || !left.some(fact => mentions(fact.value)) || !right.some(fact => mentions(fact.value))) return false;
  return right.some(fact => {
    const raw = baseline?.[fact.field];
    const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    return !values.some(value => comparable(String(value)) === comparable(fact.value));
  });
}

export function validateAgenticLeaningsReplacement({
  musicalReason,
  leaningsBasis,
  musicalLeanings,
  allowedLeanings,
  supportedLeanings,
  baselineSupportedLeanings,
  flowCloseness,
  interpretableLeanings = [],
  editorialEvidence, baseline, challenger,
}: {
  musicalReason: unknown;
  leaningsBasis: unknown;
  musicalLeanings: unknown;
  allowedLeanings: string[];
  supportedLeanings: string[];
  baselineSupportedLeanings: string[];
  flowCloseness: unknown;
  // interpretableAgenticLeanings(); absent means none, so a caller that does
  // not compute it gets exact matching only.
  interpretableLeanings?: string[];
  editorialEvidence?: unknown; baseline?: any; challenger?: any;
}): { valid: true; basis: string; evidenceKind: 'metadata-match' | 'editorial-comparison' } | { valid: false; reason: AgenticLeaningsReviewRejection } {
  const rawBasis = typeof leaningsBasis === 'string' ? leaningsBasis.trim().replace(/\s+/g, ' ') : '';
  const basis = comparable(rawBasis);
  const allowedBasis = allowedLeanings.find((option) => comparable(option) === basis);
  if (!basis || !allowedBasis) {
    return { valid: false, reason: 'missing-leanings-basis' };
  }
  if (!comparable(musicalLeanings).includes(basis)) {
    return { valid: false, reason: 'basis-not-in-leanings' };
  }
  const exact = supportedLeanings.some((option) => comparable(option) === basis);
  if (!exact) {
    const interpretable = interpretableLeanings.some((option) => comparable(option) === basis);
    if (!interpretable || !editorialEvidence) return { valid: false, reason: 'basis-not-supported-by-candidate' };
    if (!groundedEditorialComparison(editorialEvidence, baseline, challenger, basis)) {
      return { valid: false, reason: 'invalid-editorial-evidence' };
    }
  }
  // A shared match proves compatibility, not that a preference changed the
  // choice. Enforce this independently of the model's prompt and answer.
  if (baselineSupportedLeanings.some((option) => comparable(option) === basis)) {
    return { valid: false, reason: 'basis-already-supported-by-baseline' };
  }
  if (flowCloseness !== 'close' && flowCloseness !== 'possible') {
    return { valid: false, reason: 'not-flow-tie' };
  }
  const reason = typeof musicalReason === 'string' ? musicalReason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < 16) return { valid: false, reason: 'weak-musical-reason' };
  return { valid: true, basis: allowedBasis, evidenceKind: exact ? 'metadata-match' : 'editorial-comparison' };
}

export function agenticLeaningsSelectionReason({
  replacement,
  djName,
  leaningsOwnerName,
  basis,
  musicalReason,
}: {
  replacement: { title?: unknown; artist?: unknown };
  djName: unknown;
  leaningsOwnerName?: string | null;
  basis: string;
  musicalReason: unknown;
}): string {
  const title = typeof replacement.title === 'string' ? replacement.title.trim() : 'this track';
  const artist = typeof replacement.artist === 'string' ? replacement.artist.trim() : 'the selected artist';
  const presenter = typeof djName === 'string' && djName.trim() ? djName.trim() : 'The DJ';
  const owner = leaningsOwnerName?.trim() || presenter;
  const possessive = /s$/i.test(owner) ? `${owner}’` : `${owner}’s`;
  let detail = typeof musicalReason === 'string'
    ? musicalReason.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
    : 'its musical character brings a natural change of colour to the sequence';
  const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleVariants = [...new Set([
    title,
    title.replace(/_/g, ' '),
    title.replace(/\s*\([^)]*\)\s*$/, '').trim(),
    title.replace(/_/g, ' ').replace(/\s*\([^)]*\)\s*$/, '').trim(),
  ].filter((value) => value && value !== 'this track'))]
    .sort((left, right) => right.length - left.length);

  for (const identity of titleVariants) {
    const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quotedIdentity = `[“”"'‘’]?${escapedIdentity}[“”"'‘’]?`;
    const leadingTrait = new RegExp(`^The\\s+(.{2,100}?)\\s+of\\s+${quotedIdentity}(?:\\s+by\\s+${escapedArtist})?(?=\\s|[,.;]|$)`, 'iu');
    const match = leadingTrait.exec(detail);
    if (match) {
      const trait = match[1]
        .replace(new RegExp(`^${escapedArtist}(?:[’']s)?\\s*`, 'iu'), '')
        .replace(/^the\s+/iu, '')
        .trim();
      detail = `Its ${trait || 'musical character'}${detail.slice(match[0].length)}`;
      break;
    }
  }

  detail = detail
    .replace(new RegExp(`^${escapedArtist}(?:[’']s)?\\s+`, 'iu'), 'Its ')
    .replace(/^The\s+[^,.]{2,80}?\s+of\s+this\s+(?:piece|track|song)(?=\s|[,.;]|$)/iu, (value) => `Its ${value.replace(/^The\s+/iu, '').replace(/\s+of\s+this\s+(?:piece|track|song)$/iu, '')}`)
    .replace(/^This\s+(?:piece|track|song)\s+/iu, 'It ')
    .replace(/^The\s+/iu, 'Its ');

  for (const identity of titleVariants) {
    const escapedIdentity = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    detail = detail.replace(new RegExp(`[“"'‘]${escapedIdentity}[”"'’]`, 'giu'), 'the track');
    if (identity.length >= 6 && /\s/.test(identity)) {
      detail = detail.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapedIdentity}(?![\\p{L}\\p{N}])`, 'giu'), 'the track');
    }
  }

  const escapedBasis = basis.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  detail = detail
    .replace(new RegExp(`\\b${escapedBasis}\\s+leanings?\\b`, 'giu'), 'distinctive character')
    .replace(new RegExp(`\\b${escapedBasis}\\s+sound\\b`, 'giu'), 'distinctive sound')
    .replace(/,?\s*complementing the baseline\b/giu, ' while keeping the sequence coherent')
    .replace(/\bcomplements the (?:\w+[ -])?baseline with a ([^,.;]+)/giu, 'brings a $1 without breaking the sequence')
    .replace(/\bcomplements the (?:low|medium|high)[ -]energy and moods? of the current flow\b/giu, 'keeps the sequence moving naturally')
    .replace(/\bcomplements the current flow\b/giu, 'keeps the sequence moving naturally')
    .replace(/\bcomplement the current flow\b/giu, 'keep the sequence moving naturally')
    .replace(/\b(?:the )?baseline\b/giu, 'the surrounding sequence')
    .replace(/\b(?:the )?preliminary (?:choice|pick)\b/giu, 'the surrounding sequence')
    .replace(/\b(?:the )?challenger\b/giu, 'the track')
    .replace(/\bcurrent flow\b/giu, 'current sequence')
    .replace(/\b([\p{L}-]+(?:\s+and\s+[\p{L}-]+)?)\s+moods?,\s*(?:low|medium|high) energy,\s*and\s*\d+(?:\.\d+)?\s*BPM\b/giu,
      (_value, qualities: string) => `${qualities.replace(/\s+and\s+/giu, ', ')} character and steady pulse`)
    .replace(/\b(\d+(?:\.\d+)?)\s*BPM\b/giu, 'a steady pulse')
    .replace(/\ba low energy\b/giu, 'an unhurried feel')
    .replace(/\bthe low energy\b/giu, 'the unhurried feel')
    .replace(/\blow energy\b/giu, 'unhurried feel')
    .replace(/\ba medium energy\b/giu, 'a measured lift')
    .replace(/\bthe medium energy\b/giu, 'the measured lift')
    .replace(/\bmedium energy\b/giu, 'measured lift')
    .replace(/\ba high energy\b/giu, 'an energetic character')
    .replace(/\bthe high energy\b/giu, 'the energetic character')
    .replace(/\bhigh energy\b/giu, 'energetic character')
    .replace(/\bmoods\b/giu, 'character')
    .replace(/\b(high-energy|low-energy|calm|reflective|energetic)\s+(celebratory|reflective|energetic|calm)\s+(atmosphere|character|mood|feel)\b/giu, '$1, $2 $3')
    .replace(/,?\s*perfect for relaxation\b/giu, '')
    .replace(/\bthe track\s+by\s+the selected artist\b/giu, 'it')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,:;\s]+$/, '')
    .trim();
  if (!detail || detail === MUSICAL_REASON_UNAVAILABLE || detail.length < 16) {
    detail = 'its musical character brings a natural change of colour to the sequence';
  }
  if (detail) detail = detail[0].toLocaleLowerCase('en-GB') + detail.slice(1);
  return `${presenter} chose “${title}” by ${artist}; ${detail}, reflecting ${possessive} taste for ${basis}.`;
}

export function resolveAgenticLeaningsUsage({
  hasLeanings,
  preliminaryId,
  replacementId,
  finalId,
  queued,
}: {
  hasLeanings: boolean;
  preliminaryId: string | null;
  replacementId: string | null;
  finalId: string | null;
  queued: boolean;
}): boolean {
  return hasLeanings
    && !!preliminaryId
    && !!replacementId
    && replacementId !== preliminaryId
    && finalId === replacementId
    && queued;
}
