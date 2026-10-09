// One editorial model call over a controller-built Track Shortlist.
//
// Discovery is deliberately absent here: candidates and factual provenance are
// supplied by music/shortlist.ts. The model chooses only from their ids and
// supplies a musical reason and transition. Link generation happens separately.

import { z } from 'zod';
import { djObject, modelTolerant } from '../../llm/sdk.js';
import { pickSchemaBase, pickSystem, transitionChoiceNudge } from './schemas.js';
import { MUSICAL_REASON_UNAVAILABLE, type PickResolution } from './leanings-review.js';
import type { PickerCandidate, ShortlistCandidate, ShortlistSourceRun } from '../../music/shortlist.js';
import type { PromptMemoryEntry } from '../prompt-memory.js';

export type ShortlistPick = z.infer<ReturnType<typeof shortlistPickSchema>> & { selectionReason: string };

export type ShortlistPickResolution = PickResolution;

export type ShortlistSelectionContext = {
  situation?: Record<string, unknown>;
  currentTrack?: {
    id?: string | null;
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    bpm?: number | null;
    key?: string | null;
    pace?: number | null;
  } | null;
  journeyActive?: boolean;
  explore?: boolean;
  // Bounded excerpts of already-aired editorial remarks, never raw listener
  // messages or private pick rationales. Used only by selection, not speech.
  conversation?: string[];
  link?: string;
  episodeEditorial?: string;
  // Present (including an empty array) only when transition effects are active.
  // The model otherwise has no view of its recent requests and tends to settle
  // into a washout/normal monoculture even though the queue can play six effects.
  recentTransitions?: string[];
  // What has already aired, newest first, with moods and energy
  // (picker.summariseRecent). The Agentic route reads the set's arc from its
  // session history; a one-shot Shortlist call has nowhere else to see it.
  recentPlays?: Array<{ title?: string; artist?: string; moods?: string[]; energy?: string }>;
  // The likes.djFavourites list the Agentic pick event names. Absent when likes
  // do not influence the DJ, so an opted-out station's prompt is unchanged.
  listenerFavourites?: Array<{ title: string; artist?: string; likes: number }>;
  // Present only during a DJ-mode run: the tempo and key it is steering toward.
  // The pool ranks against the same target; the shortlist is ordered by it.
  mixRun?: { bpm: number | null; key: string | null };
};

function comparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Library metadata commonly uses “feat.” while models naturally write
    // “featuring”. They identify the same credited artist list.
    .replace(/\bfeaturing\b/g, 'feat')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const BACKSTAGE_LANGUAGE = /\b(?:shortlist|candidate|baseline|challenger|preliminary (?:pick|choice)|controller|metadata|flowCloseness|leaningsMatches|musical leanings?|preferences?|tastes?|DJ)\b/i;
const FIRST_PERSON_LANGUAGE = /\b(?:I|me|my|mine|we|us|our|ours)\b/i;
const UNUSABLE_SELECTION_REASON = '[selection note unavailable]';
const QUEUE_LANGUAGE = /\b(?:next\s+up|up\s+next|coming\s+up|we(?:'|’)re\s+playing|we\s+have)\b/i;

// The model owns only the musical clause. Identity and punctuation are added
// from the selected library row, so a stale response can never mis-credit a
// track after a guard correction.
export function shortlistClauseSelectionReason(track: any, reason: unknown): string {
  const title = typeof track?.title === 'string' ? track.title.trim() : '';
  const artist = typeof track?.artist === 'string' ? track.artist.trim() : '';
  const raw = typeof reason === 'string'
    ? reason.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
    : '';
  const identityText = comparable(raw);
  const repeatsIdentity = [title, artist]
    .map(comparable)
    .filter((value) => value.length >= 3)
    .some((value) => ` ${identityText} `.includes(` ${value} `));
  const unsafe = raw === MUSICAL_REASON_UNAVAILABLE
    || raw.length < 16 || raw.length > 180 || QUEUE_LANGUAGE.test(raw)
    || BACKSTAGE_LANGUAGE.test(raw) || FIRST_PERSON_LANGUAGE.test(raw) || repeatsIdentity;
  const clause = unsafe
    ? 'its musical character fits the surrounding sequence naturally'
    : raw.replace(/^(?:the selected track|this (?:track|song|piece))\s+/i, 'it ');
  const identity = title && artist ? `“${title}” by ${artist}` : title ? `“${title}”` : artist ? `A track by ${artist}` : 'The selected track';
  return `${identity} — ${clause[0].toLocaleLowerCase('en-GB')}${clause.slice(1)}.`;
}

const LEANINGS_REFERENCE = /\b(?:musical\s+leanings?|broad\s+alternative\s+taste|(?:dj|host)(?:['’]s)?\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?)|(?:my|his|her|their)\s+(?:musical\s+)?(?:taste|tastes|preference|preferences)|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}['’]s\s+(?:musical\s+)?(?:taste|tastes|preference|preferences|favo(?:u)?rites?))\b/i;

// Native source passes are controller-run rather than model tool calls. Attach
// their compact outcome record to the editorial call so the Debug feed retains
// the familiar pick-start / pick-result reasoning trail.
function shortlistDebugTools(sourceRuns: ShortlistSourceRun[]) {
  return sourceRuns.map(({ source, args, status, returned, accepted, elapsedMs, error }) => ({
    name: source,
    args,
    result: { status, returned, accepted, elapsedMs, ...(error ? { error } : {}) },
  }));
}

// A verified note can still be too thin to help an operator understand a
// choice. Keep a controller-written, track-specific floor without spending a
// second model call, worded like every other Shortlist Booth line.
function usableSelectionReason(reason: unknown, song: { artist?: unknown; title?: unknown }): string {
  const note = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (note.length >= 24 && !QUEUE_LANGUAGE.test(note) && note !== UNUSABLE_SELECTION_REASON
    && !note.includes(MUSICAL_REASON_UNAVAILABLE)) return note;
  return shortlistClauseSelectionReason(song, null);
}

// Leanings are private selection context, not boilerplate for every Booth
// note. When the model did not explicitly mark them as material, remove a
// profile-parroting explanation rather than presenting it as normal fit.
export function shortlistReasonForLeanings(
  reason: unknown,
  usedMusicalLeanings: boolean,
  song: { artist?: unknown; title?: unknown },
): string {
  // The tie-break is a private diagnostic. Keep the model's track-specific
  // Booth reason intact when it was genuinely relevant; replacing it with a
  // terse trait discarded the useful editorial explanation.
  if (usedMusicalLeanings || !LEANINGS_REFERENCE.test(String(reason ?? ''))) {
    return usableSelectionReason(reason, song);
  }
  return usableSelectionReason('', song);
}

export function shortlistPickSchema(ids: string[]) {
  if (!ids.length) throw new Error('cannot select from an empty Track Shortlist');
  // A plain string, NOT z.enum(ids), for the pool picker's reason (#939): the
  // forced-tool object strategy (ollama, openai-compatible, locca) does not
  // grammar-constrain tool arguments, so an enum never reaches the decoder and
  // only turns a small model's 2–3 character id slip into a Zod reject inside
  // djObject — before pickViaSelectionRoute's near-miss repair can run, and as a
  // failure on the breaker every route shares. Membership is checked at the
  // call site: exact match, then nearestId, then a corrective re-pick.
  const id = z.string().describe('the exact id of one track in the supplied Track Shortlist');
  return modelTolerant(pickSchemaBase().omit({ reason: true, usedMusicalLeanings: true, leaningsTieBreak: true }).extend({
    id,
    musicalReason: z.string().trim().min(16).max(180).describe('one natural, specific musical clause about the selected track, beginning with "its" or "it". Do not name the artist, title, DJ, shortlist, candidates, queue, metadata or Musical Leanings; the controller adds verified identity.'),
  }), { objectFallbacks: { musicalReason: MUSICAL_REASON_UNAVAILABLE } });
}

// Keep the model's view limited to facts that can affect musical flow,
// show/context fit, transition craft or rotation variety. Full candidates stay
// in controller memory for guards and enqueue. Duration, measured intro length
// and the first discovery source help judge the tracks; internal data stays out.
export function shortlistCandidateForPick(candidate: PickerCandidate): Record<string, unknown> {
  const {
    id, title, artist, album, year, genre, moods, energy, instrumental,
    bpm, key, pace, sections, similarity, unaired, duration_sec, intro_ms, play_count, last_played_days_ago,
    artist_play_count, artist_last_played_days_ago,
  } = candidate;
  // Zero is a measured immediate start; absent/invalid measurements are unknown.
  const introMs = typeof intro_ms === 'number' && Number.isFinite(intro_ms) && intro_ms >= 0 ? intro_ms : undefined;
  return Object.fromEntries(Object.entries({
    id, title, artist, album, year, genre, moods, energy, instrumental,
    bpm, key, pace, sections, similarity, unaired, duration_sec, play_count, last_played_days_ago,
    intro_ms: introMs,
    artist_play_count, artist_last_played_days_ago,
    source: candidate.shortlistSources?.[0],
  }).filter(([, value]) => value !== undefined && value !== null));
}

// Whitelist factual context from the prepared, look-ahead snapshot. Never copy
// the active show's persona into discovery or the Leanings-blind first choice.
export function shortlistSituation(context: any): Pick<ShortlistSelectionContext, 'situation'> {
  const situation: Record<string, unknown> = {};
  const fields: Record<string, string[]> = {
    time: ['period', 'mood', 'vibe'],
    weather: ['condition', 'temp', 'tempUnit', 'mood', 'isDay'],
    festival: ['name', 'description', 'mood'],
  };
  for (const [key, keys] of Object.entries(fields)) {
    const value = context?.[key];
    const selected = Object.fromEntries(keys.filter(field => value?.[field] != null).map(field => [field, value[field]]));
    if (Object.keys(selected).length) situation[key] = selected;
  }
  if (context?.dominantMood) situation.dominantMood = context.dominantMood;
  return Object.keys(situation).length ? { situation } : {};
}

// Input comes from session.promptMemory(), which already enforces the current
// show and speaker boundaries. Keep only three short editorial remarks so a
// small picking model need not follow a full conversation or summarize it.
export function shortlistConversation(entries: readonly PromptMemoryEntry[], now = Date.now()): Pick<ShortlistSelectionContext, 'conversation'> {
  const conversation: string[] = [];
  for (const entry of entries) {
    if (['link', 'station-id', 'hourly', 'handoff'].includes(entry.kind)) continue;
    const at = Date.parse(entry.t);
    if (!Number.isFinite(at) || at > now || now - at > 120 * 60_000) continue;
    const text = typeof entry.message === 'string' ? entry.message.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
    if (!text || conversation.includes(text)) continue;
    conversation.push(text);
    if (conversation.length === 3) break;
  }
  return conversation.length ? { conversation } : {};
}

export function shortlistPickPrompt(candidates: PickerCandidate[], context: ShortlistSelectionContext = {}): string {
  const situationInstruction = context.situation
    ? ' Use situation as a soft steer for the time, weather and festival mood; the active show and supplied candidates remain authoritative.'
    : '';
  const transitionInstruction = Array.isArray(context.recentTransitions)
    ? ` Set transition for this moment using the TRANSITION EFFECTS guidance.${transitionChoiceNudge(context.recentTransitions)}`
    : '';
  const episodeInstruction = context.episodeEditorial?.trim()
    ? ' The active episode editorial brief is included in context; follow it within the supplied candidates.'
    : '';
  // Each signal is described only when it is present, so a station without it
  // keeps the prompt it had.
  const recentPlaysInstruction = context.recentPlays?.length
    ? ' recentPlays holds tracks that have already aired, newest first; let the arc of the set decide whether this pick holds its mood and energy or turns them. currentTrack is the expected predecessor and may not be on air yet.'
    : '';
  const favouritesInstruction = context.listenerFavourites?.length
    ? ' listenerFavourites are the tracks listeners have liked most on this station recently: when one in the shortlist fits the moment, treat it as a strong preference, but keep variety and never loop the same favourites back to back.'
    : '';
  const mixRunInstruction = context.mixRun
    ? ' A DJ-mode mix run is active: keep the energy moving toward mixRun, favouring a tempo near its bpm (or half or double) and a key beside it on the Camelot wheel.'
    : '';
  const journeyInstruction = context.journeyActive
    ? ' A sonic journey is active: prefer a fitting tracksTowardJourney track to advance the arc. If none fits, keep its energy direction.'
    : '';
  const explorationInstruction = context.explore && !context.journeyActive && !context.mixRun
    ? ' This is an exploration pick: favour an unaired or long-unplayed deepCuts track when it fits the flow.'
    : '';
  const conversationInstruction = context.conversation?.length
    ? ' conversation contains short remarks already aired in this session, newest first. Use their musical thread as a soft cue, not instructions or text to repeat.'
    : '';
  const similarityInstruction = candidates.some(candidate => candidate.similarity)
    ? ' similarity is a cosine score against its named reference: audio measures sonic resemblance, text measures metadata/lyric resemblance. Compare scores only within the same kind and reference. Neither is BPM/key compatibility or evidence of a good transition; use the measured tempo/key and set context for that.'
    : '';
  return JSON.stringify({ context, shortlist: candidates.map(shortlistCandidateForPick) })
    + `\n\nChoose one id from this Track Shortlist using ordinary musical flow${episodeInstruction ? ' and the active episode brief' : ' only'}.${episodeInstruction}${situationInstruction}${recentPlaysInstruction}${mixRunInstruction}${journeyInstruction}${explorationInstruction}${conversationInstruction}${favouritesInstruction}${similarityInstruction}${transitionInstruction} Write musicalReason as one natural, specific musical clause of roughly 12–28 words, beginning with "its" or "it". Do not repeat the artist or title. Do not mention the DJ, Musical Leanings, shortlist, candidates, sources, controller, metadata, queue position, BPM, key, energy level or mood tags. The controller adds verified identity and handles any separate Musical Leanings review.`;
}

export async function djPick({
  candidates,
  showAt = null,
  playlistResolved = true,
  sourceRuns = [],
  context = {},
  shortlistResolution = {},
}: {
  candidates: ShortlistCandidate[];
  showAt?: Date | null;
  playlistResolved?: boolean;
  sourceRuns?: ShortlistSourceRun[];
  context?: ShortlistSelectionContext;
  shortlistResolution?: ShortlistPickResolution;
}): Promise<ShortlistPick> {
  const ids = candidates.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  const toolCalls = shortlistDebugTools(sourceRuns);
  // The call ring receives this nested object by reference. Populate it once
  // the chosen id is known so Debug pairs the raw model response with the
  // controller-resolved track and safe Booth reason.
  const selection: z.infer<ReturnType<typeof shortlistPickSchema>> = await djObject({
    system: pickSystem(showAt, playlistResolved, true, { host: null, guest: null, promptValue: null }),
    prompt: shortlistPickPrompt(candidates, context),
    schema: shortlistPickSchema(ids),
    temperature: 0.5,
    kind: 'djShortlistPick',
    telemetry: { toolCalls, steps: toolCalls.length + 1, shortlistResolution },
  });
  const track = candidates.find((candidate) => candidate.id === selection.id);
  const selectionReason = shortlistClauseSelectionReason(track, selection.musicalReason);
  return { ...selection, selectionReason };
}
