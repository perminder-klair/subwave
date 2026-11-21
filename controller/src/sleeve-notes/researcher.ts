// Contract between Sleeve Notes collection and a future isolated researcher.
// The controller owns source retrieval, pacing, evidence validation and all
// database writes. A researcher only receives bounded source material and
// returns candidate notes; it never decides that a claim is safe to retain.

export const SLEEVE_NOTE_CATEGORIES = [
  'artist-stories',
  'release-stories',
  'track-stories',
  'musical-connections',
  'milestones',
  'credits',
  'recognition',
] as const;

export type SleeveNoteCategory = typeof SLEEVE_NOTE_CATEGORIES[number];

/** Album/release-group articles can support stories about the release itself. */
export const RELEASE_GROUP_NOTE_CATEGORIES: readonly SleeveNoteCategory[] = [
  'release-stories', 'credits', 'milestones', 'recognition',
];

/** Wikipedia supplies stories; structured writer and producer credits come from Genius. */
export function wikipediaNoteCategories(
  entityType: 'artist' | 'recording' | 'release' | 'release-group',
): readonly SleeveNoteCategory[] {
  if (entityType === 'artist') return SLEEVE_NOTE_CATEGORIES.filter((category) => category !== 'credits');
  if (entityType === 'recording') return ['track-stories', 'musical-connections', 'milestones', 'recognition'];
  return RELEASE_GROUP_NOTE_CATEGORIES.filter((category) => category !== 'credits');
}

/** Leave slots empty when the evidence does not clear the bar. */
export const MAX_CANDIDATES_PER_ARTIST_RESEARCH = 8;

export const SLEEVE_NOTE_CATEGORY_GUIDANCE: Record<SleeveNoteCategory, string> = {
  'artist-stories': 'origin, creative development, scenes, career turns, distinctive collaborations, or legacy',
  'release-stories': 'the creation, recording, concept, collaborators, or cultural story of a specific album or release',
  'track-stories': 'the creation, recording, or cultural story of a particular song or recording',
  'musical-connections': 'specific covers, samples, interpolations, or other clear links between artists and recordings',
  milestones: 'a genuinely notable career achievement; skip routine release, chart, and award listings',
  credits: 'a named writer, producer, featured performer, or other contributor and their specific role',
  recognition: 'inclusion or an explicit rank in a named editorial, critics, or award list; state inclusion without turning it into a universal quality judgement',
};

export interface ResearchDocument {
  id: string;
  entityId: string;
  entityName?: string | null;
  provider: string;
  sourceUrl: string;
  revisionId: string | null;
  text: string;
}

export interface ResearchJob {
  id: string;
  document: ResearchDocument;
  subjectKind?: 'artist' | 'album';
  categories: readonly SleeveNoteCategory[];
  maxCandidates: number;
  /** This Wikipedia section's share of the configured whole-article claim limit. */
  wikiNumber?: number;
  /** Current Wikipedia extraction requires both stored wording levels. */
  requireShortWording?: boolean;
  /** Library play associated with this research job; context, never source evidence. */
  airtimeContext?: { artist: string | null; album: string | null; track: string };
}

export interface ResearchCandidate {
  category: SleeveNoteCategory;
  topic: string;
  /** Full, complete DJ/research wording; retained in the legacy wording column. */
  wording: string;
  /** Compact semantic anchors for a link-writing model; need not be grammatical. */
  shortWording?: string;
  /** Exact supporting source text, not a model-generated paraphrase. */
  evidence: string;
  airtimeScope?: 'general' | 'matching-release-only' | 'matching-track-only';
  matchingReleaseTitle?: string;
  matchingTrackTitle?: string;
  reviewReason?: string;
  reviewIssue?: 'wording' | 'context';
  /** Rank within the source section, preserved before evidence screening. */
  extractionRank?: number;
  extractionSection?: number;
}

/** A Wikipedia extract plus the claim-level scope chosen during extraction. */
export interface WikipediaSpark {
  wording: string;
  category?: SleeveNoteCategory;
  airtimeScope?: 'general' | 'matching-release-only' | 'matching-track-only';
  matchingReleaseTitle?: string;
  matchingTrackTitle?: string;
}

export interface WikipediaSparkExtraction {
  claims: WikipediaSpark[];
  rawResponse: string;
}

export interface Researcher {
  extract(job: ResearchJob, signal: AbortSignal): Promise<ResearchCandidate[]>;
  extractWikipediaSparks?(job: ResearchJob, sectionPath: string, signal: AbortSignal,
    promptOverride?: string, onUsage?: (usage: { input: number; output: number }) => void): Promise<WikipediaSparkExtraction>;
  rankForAirtime?(job: ResearchJob, candidates: readonly ResearchCandidate[], signal: AbortSignal): Promise<string[]>;
  reviewForAirtime?(job: ResearchJob, candidates: readonly ResearchCandidate[], signal: AbortSignal): Promise<ResearchReviewDecision[]>;
  repairFullCandidates?(job: ResearchJob, candidates: readonly ResearchCandidate[], signal: AbortSignal): Promise<ResearchCandidate[]>;
  addShortWordings?(job: ResearchJob, candidates: readonly ResearchCandidate[], signal: AbortSignal): Promise<ResearchCandidate[]>;
  semanticReview?(job: ResearchJob, candidates: readonly ResearchCandidate[], signal: AbortSignal): Promise<readonly string[]>;
}

export interface ResearchReviewDecision {
  claimId: string;
  decision: 'ready' | 'matching-release-only' | 'matching-track-only' | 'bin';
  reviewIssue?: 'wording' | 'context' | null;
  reason: string;
  /** Exact release title, required for an artist-level release-specific story. */
  releaseTitle?: string;
  trackTitle?: string;
  shortSafe?: boolean;
  category?: SleeveNoteCategory;
  topic?: string;
}

export interface ValidatedResearch {
  accepted: ResearchCandidate[];
  rejected: Array<{ candidate: ResearchCandidate; reason: 'category' | 'shape' | 'incomplete' | 'short-shape' | 'unsupported' | 'short-unsupported' | 'semantic-review' | 'bare-milestone' | 'editorial' | 'topic' | 'duplicate' | 'limit' }>;
}

export interface ResearchOutcomeObserver {
  recordOutcome(job: ResearchJob, validated: ValidatedResearch): void;
}

function normal(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function validText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && normal(value).length >= min && normal(value).length <= max;
}

function isCategory(value: string): value is SleeveNoteCategory {
  return (SLEEVE_NOTE_CATEGORIES as readonly string[]).includes(value);
}

const SUPPORT_STOP_WORDS = new Set(['about', 'after', 'album', 'also', 'and', 'are', 'been', 'best', 'but', 'for', 'from', 'had', 'has', 'have', 'her', 'his', 'into', 'its', 'more', 'most', 'not', 'she', 'that', 'the', 'their', 'them', 'then', 'they', 'this', 'was', 'were', 'with']);

function materialTerms(value: string): Set<string> {
  return new Set(normal(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((term) => term.length >= 4 && !SUPPORT_STOP_WORDS.has(term)) ?? []);
}

function comparableDetail(value: string): string {
  return normal(value).toLocaleLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function detailTerms(value: string): Set<string> {
  return new Set((normal(value).match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) ?? [])
    .flatMap((term) => [comparableDetail(term), ...(/[’']s$/iu.test(term) ? [comparableDetail(term.slice(0, -2))] : [])])
    .filter(Boolean));
}

/** A paraphrase must still share concrete factual language with its citation. */
function hasMaterialEvidence(wording: string, evidence: string): boolean {
  const wordingTerms = materialTerms(wording);
  const evidenceTerms = materialTerms(evidence);
  let shared = 0;
  for (const term of wordingTerms) if (evidenceTerms.has(term)) shared++;
  const wordingNumbers = wording.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
  const evidenceNumbers = new Set(evidence.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []);
  return shared + wordingNumbers.filter((number) => evidenceNumbers.has(number)).length >= 2
    && wordingNumbers.every((number) => evidenceNumbers.has(number));
}

/** Most meaningful wording must occur in its support, not merely two anchors. */
function hasSufficientMaterialCoverage(wording: string, support: string, minimum = 0.75): boolean {
  const wordingTerms = materialTerms(wording);
  if (!wordingTerms.size) return false;
  const supportTerms = materialTerms(support);
  let shared = 0;
  for (const term of wordingTerms) if (supportTerms.has(term)) shared++;
  return shared / wordingTerms.size >= minimum;
}

/** Wikipedia Full wording must keep every material detail in source order. */
function hasOrderedMaterialCoverage(wording: string, support: string): boolean {
  const normalizeWord = (word: string) => word
    .replace(/ing$/u, '')
    .replace(/ed$/u, '')
    .replace(/es$/u, '')
    .replace(/s$/u, '');
  const terms = (value: string) => (normal(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length >= 4 && !SUPPORT_STOP_WORDS.has(term))
    .map(normalizeWord);
  const claimTerms = terms(wording);
  const sourceTerms = terms(support);
  let sourceIndex = 0;
  for (const claimTerm of claimTerms) {
    while (sourceIndex < sourceTerms.length && sourceTerms[sourceIndex] !== claimTerm) sourceIndex++;
    if (sourceIndex >= sourceTerms.length) return false;
    sourceIndex++;
  }
  return claimTerms.length > 0;
}

const DETAIL_LEADS = new Set(['a', 'an', 'and', 'for', 'from', 'her', 'his', 'in', 'it', 'its', 'she', 'the', 'their', 'they', 'this', 'was']);

/**
 * The citation must contribute a recognisable detail to the spoken note. This
 * stops `evidence: "I Follow Rivers"` being used to support an otherwise
 * anonymous "her biggest hit" sentence.
 */
function wordingCarriesEvidenceDetail(wording: string, evidence: string): boolean {
  const normalizedWording = normal(wording).toLowerCase();
  const numbers = evidence.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
  if (numbers.some((number) => normalizedWording.includes(number))) return true;
  const phrases = evidence.match(/\b[A-Z][\p{L}\p{M}'’-]*(?:\s+[A-Z][\p{L}\p{M}'’-]*){1,5}\b/gu) ?? [];
  if (phrases
    .map((phrase) => normal(phrase))
    .filter((phrase) => !DETAIL_LEADS.has(phrase.toLowerCase()))
    .some((phrase) => normalizedWording.includes(phrase.toLowerCase()))) return true;
  const sentenceInitials = new Set((normal(evidence).match(/(?:^|[.!?]\s+)([\p{Lu}][\p{L}\p{M}'’-]*)/gu) ?? [])
    .map((match) => match.trim().split(/\s+/).at(-1)?.toLowerCase() ?? ''));
  const namedWords = evidence.match(/\b[\p{Lu}][\p{L}\p{M}'’-]{2,}\b/gu) ?? [];
  const wordingDetails = detailTerms(wording);
  return namedWords.some((word) => {
    const detail = comparableDetail(word);
    const base = /[’']s$/iu.test(word) ? comparableDetail(word.slice(0, -2)) : detail;
    return !CAPITALIZED_NON_DETAILS.has(detail)
      && !sentenceInitials.has(word.toLowerCase())
      && (wordingDetails.has(detail) || wordingDetails.has(base));
  });
}

const CAPITALIZED_NON_DETAILS = new Set([
  'a', 'an', 'and', 'but', 'for', 'from', 'he', 'her', 'his', 'i', 'in', 'it',
  'its', 'she', 'the', 'their', 'they', 'this', 'we', 'with', 'you',
]);

/**
 * Shared terms alone can join two unrelated facts. Require every meaningful
 * capitalised detail in each spoken sentence to occur in its exact evidence:
 * a name, title, award or place cannot be borrowed from elsewhere in an
 * article merely because one other keyword happens to overlap.
 */
function sentenceCarriesAllNamedDetails(wording: string, evidence: string): boolean {
  const evidenceTerms = detailTerms(evidence);
  const details = wording.match(/\b[A-Z][\p{L}\p{M}'’-]*\b/gu) ?? [];
  return details.every((sourceDetail) => {
    const detail = comparableDetail(sourceDetail);
    if (detail.length < 2 || CAPITALIZED_NON_DETAILS.has(detail)) return true;
    if (evidenceTerms.has(detail)) return true;
    // detailTerms deliberately tokenises punctuation. A displayed proper name
    // such as Dâm-Funk or Oakland-based must therefore be checked by its
    // source-supported parts as well as by its joined spelling.
    const parts = sourceDetail.split(/[-‐‑‒–—]/u).map(comparableDetail).filter(Boolean);
    return parts.length > 1 && parts.every((part) => evidenceTerms.has(part));
  });
}

function claimSentences(wording: string): string[] {
  return normal(wording).split(/(?<=[.!?])\s+/).filter(Boolean);
}

function hasSentenceEnding(value: string): boolean {
  return /[.!?]["')\]]*$/.test(value);
}

/**
 * A model occasionally returns a verbatim source fragment that stops just
 * before the detail which completes its sentence. Preserve the model's chosen
 * claim only when it can be extended directly from that same evidence; this is
 * a source-grounded recovery, not a guessed editorial completion.
 */
function completeVerbatimFragment(wording: string, evidence: string): string {
  if (hasSentenceEnding(wording)) return wording;
  const start = evidence.indexOf(wording);
  if (start < 0) return wording;
  const remaining = evidence.slice(start + wording.length);
  const ending = remaining.match(/[.!?]["')\]]*(?=\s|$)/);
  // End-of-input is not sentence punctuation. A truncated evidence fragment
  // cannot make an unfinished claim complete merely because the stored quote
  // also stops there.
  if (ending?.index === undefined) return wording;
  const end = start + wording.length + ending.index + ending[0].length;
  return normal(evidence.slice(start, end));
}

/** Every sentence must independently be supported by the supplied receipt. */
function everySentenceSupported(wording: string, evidence: string): boolean {
  return claimSentences(wording).every((sentence) =>
    hasMaterialEvidence(sentence, evidence) && sentenceCarriesAllNamedDetails(sentence, evidence));
}

/** A release date alone is catalogue metadata, whatever category the model chose. */
function isBareReleaseMilestone(candidate: ResearchCandidate): boolean {
  const wording = normal(candidate.wording).toLowerCase();
  const release = /\b(released|arrived|issued|came out)\b/.test(wording);
  // Do not let a label ending in "Records" turn a catalogue announcement
  // into a recording story. The creative predicate must be explicit.
  const story = /\b(produc|recorded|recording|writ|collabor|expand|featur|concept|soundtrack|inspir|dedicat|sampl|cover|adapt|commission|rework|speak)\w*/.test(wording);
  return release && !story;
}

function isGeniusAlbumIdentity(job: ResearchJob, wording: string): boolean {
  return job.document.provider === 'genius'
    && job.categories.includes('release-stories')
    && /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th))\b.{0,30}\balbum\b/iu.test(wording)
    && comparableDetail(wording).includes(comparableDetail(job.document.entityName ?? ''));
}

/** Facts that are accurate but read as catalogue metadata rather than a DJ note. */
function isEditoriallyThin(candidate: ResearchCandidate): boolean {
  const wording = normal(candidate.wording).toLowerCase();
  const count = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)';
  const scaledCount = `${count}(?:[.,]\\d+)?(?:\\s+(?:hundred|thousand|million|billion))?`;
  const genericFormation = /\bformed\b/.test(wording)
    && /\b(?:19|20)\d{2}\b/.test(wording)
    && !/\b(?:advert\w*|after\w*|before\w*|met|friend\w*|school\w*|recruit\w*|member\w*|festival\w*|renam\w*|originally|perform\w*)\b/.test(wording);
  const discographyTally = new RegExp(`\\b(?:released|have released|has released)\\s+${count}\\s+(?:studio\\s+)?(?:album|single)s?\\b`).test(wording);
  const chartTally = new RegExp(`\\b(?:had|have had|have|has had|has)\\s+${count}\\s+(?:top\\s+(?:five|ten|forty)|number\\s+one)\\s+(?:hit|single)s?\\b`).test(wording)
    && !/\b(song|single|album|track|duet|called|named|featur)\w*/.test(wording);
  const standaloneRecognition = /\b(?:won|received|awarded|inducted|nominated)\b/.test(wording)
    && /\b(?:awards?|hall of fame)\b/.test(wording)
    && !/\b(after|following|alongside|during|while|because)\b/.test(wording);
  const routineChartResult = /\b(?:chart(?:ed|ing)?|peaked|reached|number\s+(?:one|\d+)|top\s+(?:five|ten|forty|\d+))\b/.test(wording)
    && !/\b(?:after|because|despite|following|inspir|perform|recorded|recording|replac|return|used)\w*\b/.test(wording);
  const routineSalesTotal = new RegExp(`\\bsold\\s+(?:about|around|more than|over|some)?\\s*${scaledCount}\\s+(?:albums?|copies|records?|singles?)\\b`).test(wording)
    && !/\b(?:after|because|following|independent|without)\b/.test(wording);
  const sensitivePersonalFact = /\b(?:died|death|cancer|tumou?r|surgery|divorc(?:e|ed|ing))\b/.test(wording);
  return genericFormation || discographyTally || chartTally || standaloneRecognition || routineChartResult || routineSalesTotal || sensitivePersonalFact;
}

function categoryFitsClaim(candidate: ResearchCandidate): boolean {
  if (candidate.category === 'credits') {
    return /\b(?:arrang|compos|conduct|contribut|drum|engineer|featur|guitar|instrument|master|mix|perform|play|produc|program|remix|sang|songwrit|vocal|writ|wrote)\w*\b/iu
      .test(candidate.wording);
  }
  if (candidate.category === 'recognition') {
    return /\b(?:awards?|critics?|editorial|hall of fame|lists?|magazine|poll|prize|rank(?:ed|ing|s)?|reader)\b/iu.test(candidate.wording);
  }
  if (candidate.category === 'musical-connections') {
    return /\b(?:adapt|borrow|collaborat|cover|featur|influenc|inspir|interpolat|remix|sampl)\w*\b/iu.test(candidate.wording);
  }
  return true;
}

const GENERIC_TOPICS = new Set([
  'artist', 'artist story', 'artist stories', 'biography', 'background', 'career',
  'credit', 'credits', 'discography', 'history', 'milestone', 'milestones', 'music', 'release',
  'release story', 'release stories', 'album', 'track', 'song', 'story', 'recognition',
]);
const GENERIC_TOPIC_WORDS = new Set([...GENERIC_TOPICS].flatMap((topic) => topic.split(' ')));

function hasUsefulTopic(topic: string, entityName?: string | null): boolean {
  const key = normal(topic).toLocaleLowerCase().replace(/[._-]+/g, ' ');
  const topicTokens: string[] = key.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (GENERIC_TOPICS.has(key)
    || !topicTokens.some((token) => token !== 'the' && token !== 'a' && token !== 'an' && !GENERIC_TOPIC_WORDS.has(token))) return false;
  const subject = normal(entityName ?? '').toLocaleLowerCase().replace(/[._-]+/g, ' ');
  if (!subject) return true;
  const subjectTokens: string[] = (subject.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token !== 'the' && token !== 'a' && token !== 'an');
  if (!subjectTokens.length || !subjectTokens.every((token) => topicTokens.includes(token))) return true;
  const residual = topicTokens.filter((token) => !subjectTokens.includes(token) && token !== 'the' && token !== 's');
  return residual.some((token) => !GENERIC_TOPICS.has(token));
}

const GENERIC_ENTITY_TAILS = new Set([
  'band', 'beat', 'brothers', 'club', 'crew', 'ensemble', 'experience', 'group',
  'orchestra', 'project', 'sisters', 'soundsystem',
]);

/** The selected receipt must visibly connect its fact to the article subject. */
function claimConnectsToEntity(wording: string, evidence: string, entityName?: string | null): boolean {
  const subject = normal(entityName ?? '');
  if (!subject) return true;
  const searchable = normal(`${wording} ${evidence}`).toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const subjectTokens = subject.toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const fullSubject = subjectTokens.join(' ');
  if (fullSubject && ` ${searchable} `.includes(` ${fullSubject} `)) return true;
  const distinctive = [...subjectTokens].reverse()
    .find((token) => token.length >= 4 && token !== 'the' && token !== 'and' && !GENERIC_ENTITY_TAILS.has(token));
  return !!distinctive && new RegExp(`\\b${distinctive}\\b`, 'iu').test(`${wording} ${evidence}`);
}

function hasUnresolvedReferent(value: string, entityName?: string | null): boolean {
  const normalized = normal(value);
  const subject = normal(entityName ?? '');
  return claimSentences(normalized).some((sentence) => {
    const lower = sentence.toLocaleLowerCase();
    const beginsWithNamedSubject = !!subject
      && (lower === subject.toLocaleLowerCase()
        || lower.startsWith(`${subject.toLocaleLowerCase()} `)
        || lower.startsWith(`${subject.toLocaleLowerCase()}'`)
        || lower.startsWith(`${subject.toLocaleLowerCase()}’`));
    if (beginsWithNamedSubject) return false;
    return /^(?:they|he|she|it|this|that|these|those|his|her|their|its)\b/iu.test(sentence)
      || /\b(?:his|her|their|its)\s+(?:band|brother|group|sister)\b/iu.test(sentence)
      || /\b(?:his|her|their|its)\s+(?:album|material|release|song|tour|track|work)\b/iu.test(sentence)
      || /\bthat\s+(?:gig|performance|session|show|tour)\b/iu.test(sentence)
      || /\b(?:called|credited|described|featured|named|ranked|supported)\s+them\b/iu.test(sentence)
      || /^(?:among|as)\s+(?:his|her|their|the\s+(?:band|group|duo))\b/iu.test(sentence)
      || /^(?:after|before|during|following)\s+(?:his|her|their|its)\b/iu.test(sentence)
      || /\bthe\s+(?:band|duo|group|label|release)\b/iu.test(sentence)
      || /^the\s+(?:artist|singer|rapper|musician|producer|sets?|material)\b/iu.test(sentence)
      || /^the\s+(?:film|songs?|tracks?)\b/iu.test(sentence)
      || /^(?:this|that)\s+(?:album|performance|record|release|song|track|work)\b/iu.test(sentence)
      || /^the\s+(?:album|performance|record|release|song|tour|track|work)\s+(?:became|features?|following|had|has|is|was|were)\b/iu.test(sentence)
      || /^(?:as|based on|by|during|following|from|in|to|when|while)\b[^,]{0,140},\s*(?:he|her|his|it|its|she|the\s+(?:band|group|duo)|their|they)\b/iu.test(sentence);
  });
}

function hasBalancedDelimiters(value: string): boolean {
  const pairs: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}'], ['“', '”']];
  for (const [open, close] of pairs) {
    if (value.split(open).length !== value.split(close).length) return false;
  }
  return (value.match(/"/g)?.length ?? 0) % 2 === 0;
}

function isListLikeEvidence(evidence: string): boolean {
  return /==\s*(?:discography|members|references)\s*==/iu.test(evidence);
}

function preservesSourceAttribution(wording: string, evidence: string): boolean {
  const sourceAttributes = /\b(?:according to|argu(?:ed|ing)|called|claimed|described|said|stated|wrote)\b/iu.test(evidence);
  if (!sourceAttributes) return true;
  return /\b(?:according to|argu(?:ed|ing)|called|cited|claimed|described|hailed|named|recognized|reported|said|stated|wrote)\b/iu.test(wording);
}

function namedWorkTitles(evidence: string): string[] {
  const titles: string[] = [];
  const pattern = /\b(?:song|track|album|single|film|soundtrack|record|composition)\s+(?:(?:called|named|titled)\s+)?["“]([^"“”]{2,100})["”]/giu;
  for (const match of evidence.matchAll(pattern)) titles.push(normal(match[1]));
  return titles;
}

function namesEvidenceWorks(wording: string, evidence: string): boolean {
  const normalizedWording = normal(wording).toLocaleLowerCase();
  const titles = namedWorkTitles(evidence);
  if (!titles.length) return true;
  const refersToWork = /\b(?:album|composition|film|record|release|song|soundtrack|track)\b/iu.test(wording);
  // A claim may use one fact from a passage that happens to name several
  // works. Require the relevant work to be named, rather than requiring every
  // title in the evidence passage to be repeated.
  return !refersToWork || titles.some((title) => normalizedWording.includes(title.toLocaleLowerCase()));
}

function fullWordingIsComplete(wording: string): boolean {
  if (!hasSentenceEnding(wording)) return false;
  if (!hasBalancedDelimiters(wording)) return false;
  if (/(?:\.{3}|…)\s*[.!?]?["')\]]*$/.test(wording)) return false;
  if (/\bits release\b/iu.test(wording)) return false;
  if (/\bthe album\b/iu.test(wording) && !/\b[Tt]he album\s+(?:called|named|titled|["“']?[\p{Lu}])/u.test(wording)) return false;
  if (/^(?:a|an)\s+[^.!?]{0,80}\b(?:album|mix|recording|release|song|track)\s+(?:is|was|were)\b/iu.test(wording)) return false;
  if (/^\d+\s+(?:new\s+)?(?:albums?|songs?|tracks?)\s+(?:are|had|have|were)\b/iu.test(wording)) return false;
  const startsCleanly = claimSentences(wording).every((sentence) => {
    const first = sentence.match(/[\p{L}\p{N}]/u)?.[0];
    return !!first && (/[\p{Lu}\p{N}]/u.test(first));
  });
  if (!startsCleanly) return false;
  // Reject dangling grammar that often hides the missing object or relationship
  // (for example, "used their song" or "recorded with").
  return !/(?:\b(?:a|an|and|by|for|from|in|of|on|their|them|they|to|with|its|he|she|it|this|that)\s*)[.!?]["')\]]*$/iu.test(normal(wording));
}

function shortWordCount(wording: string): number {
  return wording.match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

const SHORT_LEADING_RELATIONSHIP = /^(?:adapt(?:ed)?|appear(?:ed)?|arrang(?:ed)?|attended|awarded|became|began|blended|borrowed|built|called|collaborated|composed|contributed|covered|created|credited|dedicated|described|directed|discovered|earned|featured|fired|formed|founded|gave|hired|included|influenced|inspired|interpolated|joined|launched|led|left|met|mixed|moved|named|nominated|opened|performed|pioneered|played|produced|protested|published|quit|ranked|reached|recorded|released|remixed|replaced|retired|sampled|selected|shared|signed|sold|started|supported|toured|transformed|used|won|worked|wrote)\b/iu;
const CLAIM_QUALIFIERS = ['best', 'biggest', 'first', 'favourite', 'favorite', 'huge', 'largest', 'most', 'only', 'over', 'more than', 'worldwide'];

function shortWordingHasExplicitSubject(shortWording: string, evidence: string, entityName?: string | null): boolean {
  const wording = normal(shortWording);
  if (SHORT_LEADING_RELATIONSHIP.test(wording) || hasUnresolvedReferent(wording, entityName)) return false;
  // Do not try to maintain an exhaustive English verb list just to locate the
  // subject. A concrete detail shared with Full near the beginning is enough;
  // the relationship and its direction are checked separately and by review.
  const subject = (wording.match(/[\p{L}\p{N}]+(?:[’'][\p{L}\p{N}]+)*/gu) ?? [])
    .slice(0, 6);
  const evidenceDetails = detailTerms(evidence);
  return subject
    .map(comparableDetail)
    .some((detail) => detail.length >= 3
      && !CAPITALIZED_NON_DETAILS.has(detail)
      && !SUPPORT_STOP_WORDS.has(detail)
      && evidenceDetails.has(detail));
}

function shortWordingPreservesQualifiers(shortWording: string, evidence: string): boolean {
  const terms = (value: string) => new Set(normal(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const wordingTerms = terms(shortWording);
  const evidenceTerms = terms(evidence);
  return CLAIM_QUALIFIERS.every((qualifier) => {
    const parts = qualifier.split(' ');
    const wordingHas = parts.length === 1
      ? wordingTerms.has(qualifier)
      : new RegExp(`\\b${parts.join('\\s+')}\\b`, 'iu').test(shortWording);
    const evidenceHas = parts.length === 1
      ? evidenceTerms.has(qualifier)
      : new RegExp(`\\b${parts.join('\\s+')}\\b`, 'iu').test(evidence);
    return !wordingHas || evidenceHas;
  });
}

function shortWordingPreservesFullEssentials(shortWording: string, wording: string, evidence: string): boolean {
  const short = normal(shortWording).toLocaleLowerCase();
  const full = normal(wording).toLocaleLowerCase();
  const essentials = ['never', 'no', 'not', 'without'];
  const hasPhrase = (value: string, phrase: string) => new RegExp(`\\b${phrase.split(' ').join('\\s+')}\\b`, 'iu').test(value);
  if (!essentials.every((term) => !hasPhrase(full, term) || hasPhrase(short, term))) return false;
  if (/\bfirst\b[^.!?]{0,40}\b(?:in|for)\s+\d+\s+years?\b/iu.test(full) && !hasPhrase(short, 'first')) return false;
  const quotedTitles = [...evidence.matchAll(/["“]([^"“”]{2,100})["”]/gu)]
    .map((match) => normal(match[1]))
    .filter((title) => full.includes(title.toLocaleLowerCase()));
  return quotedTitles.every((title) => short.includes(title.toLocaleLowerCase()));
}

/** Short may be compressed, but it must retain a factual predicate as well as entities. */
function shortWordingCarriesRelationship(shortWording: string, evidence: string): boolean {
  const relationshipRoots = [
    'adapt', 'admir', 'appear', 'arrang', 'attend', 'award', 'base', 'becom', 'begin', 'blend', 'borrow',
    'build', 'call', 'collaborat', 'compos', 'contribut', 'cover', 'creat', 'credit', 'debut', 'dedicat',
    'describ', 'direct', 'discover', 'earn', 'electrif', 'endors', 'featur', 'fire', 'form', 'found',
    'give', 'gave', 'hire', 'includ', 'influenc', 'inspir', 'interpolat', 'join', 'launch', 'lead',
    'leave', 'left', 'like', 'listen', 'meet', 'met', 'mix', 'move', 'name', 'nominat', 'open',
    'perform', 'pioneer', 'place', 'play', 'produc', 'protest', 'publish', 'quit', 'rank', 'reach',
    'read', 'record', 'releas', 'remix', 'replace', 'retir', 'sampl', 'select', 'sell', 'share', 'sign',
    'sold', 'start', 'support', 'tour', 'transform', 'use', 'win', 'won', 'work', 'write', 'writ',
  ];
  const tokens = (value: string) => normal(value).toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const carriesRelationship = (value: string) => tokens(value)
    .some((term) => relationshipRoots.some((root) => term === root || term.startsWith(root)));
  // Short is semantic input rather than a quotation. Require a predicate in
  // both forms, but allow ordinary inflection changes such as produce/produced.
  return carriesRelationship(shortWording) && carriesRelationship(evidence);
}

/** Split a source at paragraph/sentence boundaries without dropping its tail. */
export function splitResearchSource(text: string, maxCharacters = 6_000): string[] {
  const normalized = normal(text);
  if (!normalized) return [];
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const sentences = [...segmenter.segment(normalized)].map(({ segment }) => normal(segment)).filter(Boolean);
  const sections: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (!current) {
      current = sentence;
      continue;
    }
    if (current.length + 1 + sentence.length <= maxCharacters) {
      current += ` ${sentence}`;
      continue;
    }
    sections.push(current);
    current = sentence;
  }
  if (current) sections.push(current);
  return sections;
}

/** Use Wikipedia's preserved headings to put narrative prose ahead of lists.
 * Each model request still receives only one bounded part of the article. */
export function planWikipediaResearchSections(text: string, subjectKind: 'artist' | 'album'): string[] {
  const blocks: Array<{ text: string; headings: string[]; order: number }> = [];
  const headings: string[] = [];
  let body: string[] = [];
  const flush = () => {
    const content = body.join('\n').trim();
    if (content) blocks.push({ text: content, headings: [...headings], order: blocks.length });
    body = [];
  };
  for (const line of text.split(/\r?\n/u)) {
    const match = line.trim().match(/^(={2,6})\s*(.*?)\s*\1$/u);
    if (!match) { body.push(line); continue; }
    flush();
    const depth = match[1].length - 2;
    headings.length = depth + 1;
    headings[depth] = match[2].trim();
  }
  flush();
  const lists = /^(?:discography|song catalogue|filmography|selected filmography|track listing|personnel|band members|lineup|awards(?: and (?:nominations|achievements))?|charts?|certifications?|references|notes|see also|external links|further reading|bibliography|concert tours|tour dates|timeline)$/iu;
  const priority = (path: string): number => {
    if (!path) return 5; // The lead summarizes the detail available in the body.
    if (subjectKind === 'artist') {
      if (/\b(?:background|origins?|formation|early years?)\b/iu.test(path)) return 0;
      if (/\b(?:artistry|musical style|influences?|musicianship|sound)\b/iu.test(path)) return 1;
      if (/\b(?:history|career)\b/iu.test(path)) return 2;
      if (/\b(?:live performances?|touring|legacy)\b/iu.test(path)) return 3;
    } else {
      if (/\b(?:background|recording|production|composition|music|lyrics|concept)\b/iu.test(path)) return 0;
      if (/\b(?:release|promotion|legacy)\b/iu.test(path)) return 1;
    }
    return 4;
  };
  return blocks
    .filter(({ headings: path }) => !path.some((heading) => lists.test(heading)))
    .flatMap((block) => splitResearchSource(block.text).filter((part) => part.length <= 6_000)
      .map((part, partIndex) => ({ text: part, priority: priority(block.headings.join(' / ')),
        order: block.order, partIndex })))
    .sort((a, b) => a.priority - b.priority || a.order - b.order || a.partIndex - b.partIndex)
    .map(({ text: part }) => part);
}

/** Give every section a fair first-choice slot before applying the global cap. */
export function interleaveResearchCandidates(sections: readonly (readonly ResearchCandidate[])[]): ResearchCandidate[] {
  const result: ResearchCandidate[] = [];
  const longest = Math.max(0, ...sections.map((section) => section.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const section of sections) {
      const candidate = section[rank];
      if (candidate) result.push(candidate);
    }
  }
  return result;
}

/** An album claim is already scoped to its article. Keep that supported
 * context when the chosen receipt says "the album" without repeating its title. */
function albumScopedWording(job: ResearchJob, wording: string, evidence: string): string {
  if (job.subjectKind !== 'album' || !job.document.entityName
    || sentenceCarriesAllNamedDetails(wording, evidence)
    || !/\bthe album\b/iu.test(evidence)) return wording;
  const prefix = `The ${normal(job.document.entityName)} album`;
  if (!wording.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    || !/^[\s,;:.!?]/u.test(wording.slice(prefix.length))) return wording;
  return `The album${wording.slice(prefix.length)}`;
}

/** Cheap receipt and storage checks. Editorial and factual judgement belongs to the DJ review. */
export function screenResearchCandidates(job: ResearchJob, candidates: readonly ResearchCandidate[]): ValidatedResearch {
  const accepted: ResearchCandidate[] = [];
  const rejected: ValidatedResearch['rejected'] = [];
  const source = normal(job.document.text);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (accepted.length >= job.maxCandidates) {
      rejected.push({ candidate, reason: 'limit' });
      continue;
    }
    const evidence = normal(candidate.evidence || '');
    const wording = albumScopedWording(job, normal(candidate.wording || ''), evidence);
    if (!validText(evidence, 24, 900) || !source.includes(evidence)) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    if (!validText(wording, 8, 360) || !hasSentenceEnding(wording) || !hasBalancedDelimiters(wording)) {
      rejected.push({ candidate, reason: 'shape' });
      continue;
    }
    const articleContext = `${normal(job.document.entityName ?? '')} ${evidence}`.trim();
    if (job.document.provider === 'wikipedia'
      && (!hasSufficientMaterialCoverage(wording, articleContext)
        || !hasMaterialEvidence(wording, articleContext))) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    // A verbatim receipt can still be attached to a claim that invents a
    // person, place or title. Keep this narrow: the DJ judges paraphrases and
    // airtime, but every proper name in Full needs to occur in its own quote.
    if (!claimSentences(wording).every((sentence) => sentenceCarriesAllNamedDetails(sentence, articleContext))) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    const category = isCategory(candidate.category) && job.categories.includes(candidate.category)
      ? candidate.category : job.categories.includes('release-stories') ? 'release-stories' : 'artist-stories';
    const topic = validText(candidate.topic, 2, 100) ? normal(candidate.topic) : normal(job.document.entityName || 'story');
    const short = normal(candidate.shortWording || '');
    const shortWording = validText(short, 4, 140) && shortWordCount(short) <= 18
      && hasBalancedDelimiters(short) ? short : '';
    const key = comparableDetail(wording);
    if (seen.has(key)) { rejected.push({ candidate, reason: 'duplicate' }); continue; }
    seen.add(key);
    accepted.push({ category, topic, wording, evidence,
      ...(candidate.extractionRank ? { extractionRank: candidate.extractionRank } : {}),
      ...(candidate.extractionSection ? { extractionSection: candidate.extractionSection } : {}), ...(shortWording ? { shortWording } : {}),
      ...(candidate.airtimeScope ? { airtimeScope: candidate.airtimeScope } : {}),
      ...(candidate.matchingReleaseTitle ? { matchingReleaseTitle: candidate.matchingReleaseTitle } : {}),
      ...(candidate.matchingTrackTitle ? { matchingTrackTitle: candidate.matchingTrackTitle } : {}),
      ...(candidate.reviewReason ? { reviewReason: candidate.reviewReason } : {}) });
  }
  return { accepted, rejected };
}

/** Review is an exception queue, never a destination for routine discards. */
export function usefulRepairCandidate(candidate: ResearchCandidate): boolean {
  return (candidate.reviewIssue === 'wording' || candidate.reviewIssue === 'context')
    && (candidate.reviewReason?.trim().length ?? 0) >= 20
    && !/(?:needs?|requires?|only|must|should).{0,70}(?:match(?:ed|ing)?|specific|particular|correct|right).{0,30}(?:album|release|track|song)/iu.test(candidate.reviewReason ?? '')
    && !/\b(?:is|was) (?:the|an?) (?:[\p{L}\d-]+\s+){0,4}album by\b/iu.test(candidate.wording)
    && !isBareReleaseMilestone(candidate) && !isEditoriallyThin(candidate)
    && hasMaterialEvidence(candidate.wording, candidate.evidence)
    && hasSufficientMaterialCoverage(candidate.wording, candidate.evidence)
    && everySentenceSupported(candidate.wording, candidate.evidence);
}

/**
 * The controller's trust boundary for researcher output.
 *
 * A candidate must use an enabled category, fit deliberately small DJ-facing
 * fields, cite a bounded exact passage from the supplied document, and not
 * duplicate an accepted category/topic. This makes an LLM useful for editorial
 * selection without making it an authority on what the source says.
 */
export function validateResearchCandidates(job: ResearchJob, candidates: readonly ResearchCandidate[]): ValidatedResearch {
  const accepted: ResearchCandidate[] = [];
  const rejected: ValidatedResearch['rejected'] = [];
  const source = normal(job.document.text);
  const enabled = new Set(job.categories);
  const seen = new Set<string>();
  const seenFacts = new Set<string>();
  const max = Math.max(0, Math.min(job.maxCandidates, 16));

  for (const candidate of candidates) {
    if (accepted.length >= max) {
      rejected.push({ candidate, reason: 'limit' });
      continue;
    }
    if (!isCategory(candidate.category) || !enabled.has(candidate.category)) {
      rejected.push({ candidate, reason: 'category' });
      continue;
    }
    // A bare name or date is not enough context to prove the relationship the
    // wording asserts. The researcher must retain at least a short clause.
    if (!validText(candidate.topic, 2, 100) || !validText(candidate.wording, 8, 360) || !validText(candidate.evidence, 24, 900)) {
      rejected.push({ candidate, reason: 'shape' });
      continue;
    }
    if (!hasUsefulTopic(candidate.topic, job.document.entityName)) {
      rejected.push({ candidate, reason: 'topic' });
      continue;
    }
    if (!categoryFitsClaim(candidate)) {
      rejected.push({ candidate, reason: 'category' });
      continue;
    }
    if (!source.includes(normal(candidate.evidence))) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    if (!hasSentenceEnding(candidate.evidence)
      || !hasBalancedDelimiters(candidate.evidence)
      || isListLikeEvidence(candidate.evidence)) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    const wording = completeVerbatimFragment(normal(candidate.wording), normal(candidate.evidence));
    // The Wikipedia article subject is trusted document metadata. It may
    // resolve the article's own surname, pronoun or generic "the band"
    // reference, but contributes no other person, work, role or relationship.
    const fullSupport = `${candidate.evidence} ${normal(job.document.entityName ?? '')}`;
    const albumTitle = job.document.provider === 'genius' && job.categories.includes('release-stories')
      ? comparableDetail(job.document.entityName ?? '') : '';
    if (!fullWordingIsComplete(wording) || hasUnresolvedReferent(wording, job.document.entityName)
      || !namesEvidenceWorks(wording, candidate.evidence)
      || (albumTitle && !comparableDetail(wording).includes(albumTitle))) {
      rejected.push({ candidate, reason: 'incomplete' });
      continue;
    }
    if (!hasMaterialEvidence(wording, fullSupport)
      || !hasSufficientMaterialCoverage(wording, fullSupport)
      || !everySentenceSupported(wording, fullSupport)
      || (job.document.provider === 'wikipedia'
        && !hasOrderedMaterialCoverage(wording, `${normal(job.document.entityName ?? '')} ${candidate.evidence}`))
      || !preservesSourceAttribution(wording, candidate.evidence)) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    if (!wordingCarriesEvidenceDetail(wording, candidate.evidence)) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    if (isBareReleaseMilestone({ ...candidate, wording }) && !isGeniusAlbumIdentity(job, wording)) {
      rejected.push({ candidate, reason: 'bare-milestone' });
      continue;
    }
    if (isEditoriallyThin({ ...candidate, wording })) {
      rejected.push({ candidate, reason: 'editorial' });
      continue;
    }
    const shortWording = typeof candidate.shortWording === 'string'
      ? normal(candidate.shortWording)
      : '';
    if (job.requireShortWording && (!validText(shortWording, 4, 140) || shortWordCount(shortWording) > 18)) {
      rejected.push({ candidate, reason: 'short-shape' });
      continue;
    }
    if (shortWording) {
      if (!validText(shortWording, 4, 140) || shortWordCount(shortWording) > 18) {
        rejected.push({ candidate, reason: 'short-shape' });
        continue;
      }
      if (!hasBalancedDelimiters(shortWording)) {
        rejected.push({ candidate, reason: 'short-shape' });
        continue;
      }
      // Full has already crossed the evidence boundary. Short is a private
      // semantic anchor, so validate it as a faithful compression of Full
      // rather than requiring it to prove the raw citation independently.
      const shortSupport = `${wording} ${normal(job.document.entityName ?? '')}`;
      if (!hasMaterialEvidence(shortWording, wording)
        || !hasSufficientMaterialCoverage(shortWording, wording, 1)
        || !wordingCarriesEvidenceDetail(shortWording, wording)
        || !sentenceCarriesAllNamedDetails(shortWording, shortSupport)
        || hasUnresolvedReferent(shortWording, job.document.entityName)
        || !namesEvidenceWorks(shortWording, wording)
        || !shortWordingHasExplicitSubject(shortWording, shortSupport, job.document.entityName)
        || !shortWordingPreservesQualifiers(shortWording, wording)
        || !shortWordingPreservesFullEssentials(shortWording, wording, wording)
        || (isBareReleaseMilestone({ ...candidate, wording: shortWording })
          && !isGeniusAlbumIdentity(job, shortWording))
        || (job.requireShortWording && !shortWordingCarriesRelationship(shortWording, wording)
          && !isGeniusAlbumIdentity(job, wording))) {
        rejected.push({ candidate, reason: 'short-unsupported' });
        continue;
      }
    }
    if (!claimConnectsToEntity(wording, candidate.evidence, job.document.entityName)) {
      rejected.push({ candidate, reason: 'unsupported' });
      continue;
    }
    const key = `${candidate.category}\u0000${normal(candidate.topic).toLowerCase()}`;
    const factKey = comparableDetail(wording);
    if (seen.has(key) || seenFacts.has(factKey)) {
      rejected.push({ candidate, reason: 'duplicate' });
      continue;
    }
    seen.add(key);
    seenFacts.add(factKey);
    accepted.push({
      category: candidate.category,
      topic: normal(candidate.topic),
      wording,
      ...(shortWording ? { shortWording } : {}),
      evidence: normal(candidate.evidence),
    });
  }
  return { accepted, rejected };
}

/**
 * Give source-grounded facts one chance to repair presentation failures. The
 * category and exact evidence stay fixed, so this cannot fill a factual gap;
 * it can only replace a generic topic, resolve the article subject or make the
 * Full wording standalone.
 */
export async function validateAndRepairFullCandidates(
  job: ResearchJob,
  researcher: Researcher,
  candidates: readonly ResearchCandidate[],
  signal: AbortSignal,
): Promise<ValidatedResearch> {
  const first = validateResearchCandidates(job, candidates);
  if (!researcher.repairFullCandidates || signal.aborted) return first;
  const source = normal(job.document.text);
  const repairable = first.rejected
    .filter(({ candidate, reason }) => reason === 'incomplete' || reason === 'topic'
      || (reason === 'shape' && !validText(candidate.topic, 2, 100)
        && validText(candidate.wording, 8, 360) && validText(candidate.evidence, 24, 900))
      || (reason === 'unsupported'
        && source.includes(normal(candidate.evidence))
        && hasBalancedDelimiters(candidate.evidence)
        && !isListLikeEvidence(candidate.evidence)))
    .map(({ candidate }) => candidate);
  if (!repairable.length) return first;
  const repairableCandidates = new Set(repairable);
  const repaired = validateResearchCandidates(
    job,
    await researcher.repairFullCandidates(job, repairable, signal),
  );
  return {
    accepted: [...first.accepted, ...repaired.accepted],
    rejected: [
      ...first.rejected.filter(({ candidate }) => !repairableCandidates.has(candidate)),
      ...repaired.rejected,
    ],
  };
}

/**
 * Generate Short anchors only after Full claims have crossed the controller's
 * trust boundary. Retry only anchors that fail Short validation, keeping the
 * accepted Full wording and exact evidence fixed across both attempts.
 */
export async function addValidatedShortWordings(
  job: ResearchJob,
  researcher: Researcher,
  fullCandidates: readonly ResearchCandidate[],
  signal: AbortSignal,
): Promise<ValidatedResearch> {
  const shortJob = { ...job, requireShortWording: true };
  if (!researcher.addShortWordings) return validateResearchCandidates(shortJob, fullCandidates);

  const first = validateResearchCandidates(
    shortJob,
    await researcher.addShortWordings(shortJob, fullCandidates, signal),
  );
  const repairable = first.rejected
    .filter(({ reason }) => reason === 'short-shape' || reason === 'short-unsupported')
    .map(({ candidate }) => ({ ...candidate, shortWording: undefined }));
  if (signal.aborted) return first;
  if (!repairable.length) return semanticReview(shortJob, researcher, first, signal);

  const repaired = validateResearchCandidates(
    shortJob,
    await researcher.addShortWordings(shortJob, repairable, signal),
  );
  return semanticReview(shortJob, researcher, {
    accepted: [...first.accepted, ...repaired.accepted],
    rejected: [
      ...first.rejected.filter(({ reason }) => reason !== 'short-shape' && reason !== 'short-unsupported'),
      ...repaired.rejected,
    ],
  }, signal);
}

/** A failed Short must not erase a source-grounded Genius album Full. */
export async function completeGeniusAlbumCandidates(
  job: ResearchJob,
  researcher: Researcher,
  fullCandidates: readonly ResearchCandidate[],
  signal: AbortSignal,
): Promise<ValidatedResearch> {
  if (!fullCandidates.length) return { accepted: [], rejected: [] };
  let shortResult: ValidatedResearch;
  try {
    shortResult = await addValidatedShortWordings(job, researcher, fullCandidates, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    shortResult = { accepted: [], rejected: [] };
  }
  const key = (candidate: ResearchCandidate) => `${candidate.category}\u0000${candidate.topic}\u0000${candidate.wording}\u0000${candidate.evidence}`;
  const withShort = new Set(shortResult.accepted.map(key));
  const fullOnly = fullCandidates
    .filter((candidate) => !withShort.has(key(candidate)))
    .map((candidate) => ({ ...candidate, shortWording: undefined }));
  // These Full wordings are extractive transformations of exact source
  // sentences and have already crossed the controller's evidence gate. The
  // local model's review can reject a valid sentence based on article-context
  // rules written for Wikipedia; keep Short failures as Full-only instead.
  const fullOnlyValidated = validateResearchCandidates(job, fullOnly);
  const retainedFullOnly = new Set(fullOnlyValidated.accepted.map(key));
  return {
    accepted: [...shortResult.accepted, ...fullOnlyValidated.accepted],
    rejected: [
      ...shortResult.rejected.filter(({ candidate }) => !retainedFullOnly.has(key(candidate))),
      ...fullOnlyValidated.rejected,
    ],
  };
}

async function semanticReview(
  job: ResearchJob,
  researcher: Researcher,
  validated: ValidatedResearch,
  signal: AbortSignal,
): Promise<ValidatedResearch> {
  if (!validated.accepted.length || !researcher.semanticReview) return validated;
  const approved = new Set(await researcher.semanticReview(job, validated.accepted, signal));
  const accepted: ResearchCandidate[] = [];
  const rejected = [...validated.rejected];
  for (const [index, candidate] of validated.accepted.entries()) {
    const claimId = `C${String(index + 1).padStart(3, '0')}`;
    if (approved.has(claimId)) accepted.push(candidate);
    else rejected.push({ candidate, reason: 'semantic-review' });
  }
  return { accepted, rejected };
}
