// Controller-owned proof that Musical Leanings changed an Agentic pick.
//
// The review model can propose a replacement, but it cannot certify its own
// influence. A replacement only counts when it differs from the Leanings-blind
// preliminary pick, remains the final choice after the station guards, and is
// actually accepted by the queue.

import { bpmCompat, keyCompat } from '../../music/mix.js';

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
  | 'not-flow-tie'
  | 'weak-musical-reason';

export type AgenticPickResolution = {
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
    proposedReplacementId?: string | null;
    rejectionReason?: AgenticLeaningsReviewRejection | null;
  };
  guardOutcome?: 'none' | 'artist-repick' | 'album-repick' | 'artist-and-album-repick' | 'pool-rescue';
  final?: AgenticTrackRef;
  reason?: string | null;
  queued?: boolean;
  usedMusicalLeanings?: boolean;
};

export function agenticTrackRef(song: { id: unknown; title?: unknown; artist?: unknown }): AgenticTrackRef {
  return {
    id: String(song.id),
    title: typeof song.title === 'string' ? song.title : null,
    artist: typeof song.artist === 'string' ? song.artist : null,
  };
}

function comparable(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKD').toLocaleLowerCase('en-GB').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
    : '';
}

const LEANINGS_TRIGGER = /\b(?:leans?(?:\s+strongly)?\s+towards?|(?:strongly\s+)?favou?rs?|enjoys?|values?|prefers?|loves?|(?:is|are)\s+receptive\s+to|(?:is|are)\s+curious\s+about|tastes?\s+spanning|preferences?\s+include|move(?:s)?\s+between)\b/i;
const TRAILING_CONTEXT = /\b(?:when|while|rather\s+than|without|if|over\s+extremes)\b.*$/i;
const UNHELPFUL_SINGLE_WORDS = new Set(['music', 'track', 'tracks', 'record', 'records', 'material', 'sounds']);

function cleanLeaningsPhrase(value: string): string | null {
  const phrase = value
    .replace(TRAILING_CONTEXT, '')
    .replace(/^(?:and|or|towards?|to|for|with|the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,;:\s]+|[,;:\s]+$/g, '')
    .trim();
  if ((phrase.length < 5 && !/^[A-Z0-9]{2,5}$/.test(phrase)) || phrase.length > 100) return null;
  const words = phrase.split(/\s+/);
  if (words.length > 10) return null;
  // A single genre such as "house" or "rock" is broad but still useful when
  // the operator explicitly wrote it and the selected candidate carries that
  // exact genre. Drop only nouns that cannot describe a musical preference.
  if (words.length === 1 && UNHELPFUL_SINGLE_WORDS.has(phrase.toLocaleLowerCase('en-GB'))) return null;
  return phrase;
}

// Turn the operator's prose into a small closed set of exact phrases. The
// review model is told to copy from that set rather than inventing free text,
// and the controller enforces the set after generation, removing
// the two weak-model failure modes observed in live runs: null evidence beside
// a changed id, and generic mood wording invented as preference evidence.
export function agenticLeaningsPhrases(editorialLeanings: {
  host?: string | null;
  guest?: { musicalLeanings?: string | null } | null;
} | null): string[] {
  const sources = [editorialLeanings?.host, editorialLeanings?.guest?.musicalLeanings]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const phrases: string[] = [];
  for (const source of sources) {
    for (const rawSentence of source.split(/[.!?;]+/)) {
      const sentence = rawSentence.trim();
      const trigger = LEANINGS_TRIGGER.exec(sentence);
      if (!trigger) continue;
      const preference = sentence.slice((trigger.index ?? 0) + trigger[0].length).trim();
      for (const rawPart of preference.split(/\s*,\s*|\s+and\s+|\s+alongside\s+|\s+across\s+/i)) {
        const phrase = cleanLeaningsPhrase(rawPart);
        if (phrase && !phrases.some((item) => comparable(item) === comparable(phrase))) phrases.push(phrase);
      }
    }
  }
  // Short operator-authored fields are often already a comma-separated list
  // ("Warm voices, patient dub, deeper cuts") with no preference verb. Fall
  // back to those exact clauses rather than refusing to run the review.
  if (phrases.length === 0) {
    for (const source of sources) {
      for (const rawPart of source.split(/[.!?;,]+|\s+and\s+/i)) {
        const phrase = cleanLeaningsPhrase(rawPart);
        if (phrase && !phrases.some((item) => comparable(item) === comparable(phrase))) phrases.push(phrase);
      }
    }
  }
  return phrases.slice(0, 16);
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

const METADATA_GENERIC_WORDS = new Set(['music', 'track', 'tracks', 'record', 'records', 'material', 'sounds']);

function exactLeaningsMetadataMatches(candidate: any, leaningsOptions: string[]): string[] {
  const metadata = comparable([candidate?.genre, ...stringList(candidate?.moods), ...stringList(candidate?.lastfm_tags)].filter(Boolean).join(' '));
  const metadataWords = new Set(metadata.split(' ').filter(Boolean));
  return leaningsOptions.filter((option) => {
    const phrase = comparable(option);
    if (!phrase) return false;
    if (` ${metadata} `.includes(` ${phrase} `)) return true;
    // Preserve the exact operator phrase as evidence while allowing harmless
    // nouns such as "music" to be absent from a genre tag ("Electronic" is
    // direct support for the profile phrase "electronic music"). Every
    // meaningful phrase word must still be present in candidate metadata.
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

// The discovery pick is the real Leanings-blind baseline. Review it against a
// handful of challengers instead of asking a small model to rerank a sprawling
// discovery pool: three metadata-near ordinary-flow choices, plus up to two
// candidates whose own genre/mood tags exactly match a supplied profile phrase.
// Inclusion is not influence — the reviewer must still declare an equally
// sound flow tie and choose that exact phrase. Stable scores and ids make the
// reviewed set invariant to tool/source insertion order.
export function selectAgenticReviewCandidates(baseline: any, candidates: any[], leaningsOptions: string[] = [], limit = 6): any[] {
  if (!baseline?.id) return [];
  const baselineId = String(baseline.id);
  const ranked = candidates
    .filter((candidate) => candidate?.id && String(candidate.id) !== baselineId)
    .map((candidate) => ({
      candidate,
      ordinaryScore: ordinarySimilarity(baseline, candidate),
      leaningsScore: exactLeaningsMetadataScore(candidate, leaningsOptions),
    }));
  const ordinaryRanked = [...ranked]
    .sort((left, right) => right.ordinaryScore - left.ordinaryScore || String(left.candidate.id).localeCompare(String(right.candidate.id)));
  const selected = ordinaryRanked.slice(0, Math.min(3, Math.max(1, limit - 1)));
  const selectedIds = new Set(selected.map(({ candidate }) => String(candidate.id)));
  const evidenceRanked = ranked
    .filter(({ candidate, leaningsScore }) => leaningsScore > 0 && !selectedIds.has(String(candidate.id)))
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
  const flowCloseness = baseline?.id && String(track?.id) === String(baseline.id)
    ? 'baseline'
    : baseline?.id
      ? ordinarySimilarity(baseline, track) >= 4 ? 'close' : ordinarySimilarity(baseline, track) >= 2.5 ? 'possible' : 'weak'
      : undefined;
  return Object.fromEntries(Object.entries({
    id: track?.id,
    title: track?.title,
    artist: track?.artist,
    year: track?.year,
    genre: track?.genre,
    moods: track?.moods,
    energy: track?.energy,
    instrumental: track?.instrumental,
    bpm: track?.bpm,
    key: track?.key,
    unaired: track?.unaired,
    play_count: track?.play_count,
    last_played_days_ago: track?.last_played_days_ago,
    leaningsMatches: leaningsMatches.length ? leaningsMatches : undefined,
    flowCloseness,
  }).filter(([, value]) => value !== undefined && value !== null));
}

// A model-proposed replacement is only evidence of a Leanings tie-break when
// its public rationale is internally consistent and exposes the exact profile
// wording that settled the choice. This prevents a valid alternative id paired
// with a reason for the preliminary track from producing a false badge.
export function validateAgenticLeaningsReplacement({
  musicalReason,
  leaningsBasis,
  musicalLeanings,
  allowedLeanings,
  supportedLeanings,
  flowCloseness,
}: {
  musicalReason: unknown;
  leaningsBasis: unknown;
  musicalLeanings: unknown;
  allowedLeanings: string[];
  supportedLeanings: string[];
  flowCloseness: unknown;
}): { valid: true; basis: string } | { valid: false; reason: AgenticLeaningsReviewRejection } {
  const rawBasis = typeof leaningsBasis === 'string' ? leaningsBasis.trim().replace(/\s+/g, ' ') : '';
  const basis = comparable(rawBasis);
  if (!basis || !allowedLeanings.some((option) => comparable(option) === basis)) {
    return { valid: false, reason: 'missing-leanings-basis' };
  }
  if (!comparable(musicalLeanings).includes(basis)) {
    return { valid: false, reason: 'basis-not-in-leanings' };
  }
  if (!supportedLeanings.some((option) => comparable(option) === basis)) {
    return { valid: false, reason: 'basis-not-supported-by-candidate' };
  }
  if (flowCloseness !== 'close' && flowCloseness !== 'possible') {
    return { valid: false, reason: 'not-flow-tie' };
  }
  const reason = typeof musicalReason === 'string' ? musicalReason.replace(/\s+/g, ' ').trim() : '';
  if (reason.length < 16) return { valid: false, reason: 'weak-musical-reason' };
  return { valid: true, basis: rawBasis };
}

export function agenticLeaningsSelectionReason({
  replacement,
  djName,
  basis,
  musicalReason,
}: {
  replacement: { title?: unknown; artist?: unknown };
  djName: unknown;
  basis: string;
  musicalReason: unknown;
}): string {
  const title = typeof replacement.title === 'string' ? replacement.title.trim() : 'this track';
  const artist = typeof replacement.artist === 'string' ? replacement.artist.trim() : 'the selected artist';
  const presenter = typeof djName === 'string' && djName.trim() ? djName.trim() : 'The DJ';
  const possessive = /s$/i.test(presenter) ? `${presenter}’` : `${presenter}’s`;
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

  // Small local models often ignore the request not to repeat identity. Turn
  // constructions such as "the reflective mood of Rand McNally" or "the
  // Goldfrapp remix of You Never Know" into a natural pronoun-led clause.
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
    // Avoid corrupting ordinary prose when a title is itself a common short
    // word (for example "It" or "Easy"). Unquoted identity is cleaned only
    // for a sufficiently distinctive multiword title.
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
  if (!detail || detail === '[musical reason unavailable]' || detail.length < 16) {
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
