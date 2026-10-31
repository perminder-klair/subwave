import { createHash } from 'node:crypto';
import { z } from 'zod';
import * as settings from '../settings.js';
import * as library from '../music/library.js';
import { resolveEraYear } from '../music/era-year.js';
import { genreRuns, normGenre, tagCoversGenre } from '../music/genre-fold.js';
import { artistRootKey } from '../music/recency.js';
import { zonedParts } from '../time.js';
import type { ShowGenerationConfig } from '../schemas/show.js';
import { generatedShowPlanSchema, type GeneratedShowPlan } from '../schemas/show-preparation.js';
import { djObject } from '../llm/sdk.js';
import { DJ_SOULS } from '../settings/vocab.js';
import { ShowPlanningError, musicalDetailError, libraryFitError, missingMusicalEvidence, requiredShowArtists } from './show-planning-policy.js';
import { discoveryPalette } from './show-discovery-policy.js';
import { hasEraReference, normalizeShowProse, validateShowBrief } from './show-brief-contract.js';

export interface GeneratedShowCast {
  hostPersonaId: string;
  guestPersonaIds: string[];
}

export interface ExistingScheduledShow {
  name: string;
  moods: string[];
  genres: string[];
  eras: Array<{ fromYear: number | null; toYear: number | null }>;
  energies: Array<'low' | 'medium' | 'high'>;
  filtersStrict: boolean;
}

export interface GeneratedShowInput {
  occurrence: { id: string; startsAt: number; endsAt: number };
  template: ShowGenerationConfig['template'];
  planningPrompt: string;
  nameMode?: 'random' | 'custom';
  customName?: string;
  minimumCoverage?: number | null;
  artistSpacing?: number;
  coverageCorrection?: string;
  cast: GeneratedShowCast;
  show: any;
  existingShows?: ExistingScheduledShow[];
}

function stableIndex(key: string, length: number): number {
  if (length <= 1) return 0;
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % length;
}

function stableOrder<T>(items: readonly T[], key: string): T[] {
  return [...items].sort((a, b) => {
    const ah = createHash('sha256').update(`${key}:${String(a)}`).digest('hex');
    const bh = createHash('sha256').update(`${key}:${String(b)}`).digest('hex');
    return ah.localeCompare(bh);
  });
}

export function scheduledShowsForHost(hostId: string, currentShowId: string): ExistingScheduledShow[] {
  const station = settings.get();
  const scheduledCounts = new Map<string, number>();
  for (const day of Object.values(station.schedule ?? {})) {
    for (const id of Array.isArray(day) ? day : []) {
      if (typeof id === 'string') scheduledCounts.set(id, (scheduledCounts.get(id) ?? 0) + 1);
    }
  }
  return (station.shows ?? [])
    .filter((show: any) => show.id !== currentShowId && show.personaId === hostId
      && show.generation?.mode !== 'generated' && scheduledCounts.has(show.id))
    .sort((a: any, b: any) => scheduledCounts.get(b.id)! - scheduledCounts.get(a.id)!)
    .slice(0, 5)
    .map((show: any) => ({
      name: String(show.name || 'Untitled show'),
      moods: Array.isArray(show.moods) ? show.moods : [],
      genres: Array.isArray(show.genres) ? show.genres : [],
      eras: Array.isArray(show.eras) ? show.eras : [],
      energies: Array.isArray(show.energies) ? show.energies : [],
      filtersStrict: show.filtersStrict === true,
    }));
}

export function resolveGeneratedShowCast({ show, occurrence, personas }: {
  show: any;
  occurrence: { id: string };
  personas: readonly any[];
}): GeneratedShowCast | null {
  const config = show.generation;
  if (!config || config.mode !== 'generated') return null;
  const subShows = settings.get().subShows;
  const commonGround = config.template === 'common-ground';
  const eligible = new Map<string, any>(personas.filter(p => p && typeof p.id === 'string'
    && (!commonGround || subShows?.eligibleHostPersonaIds == null || subShows.eligibleHostPersonaIds.includes(p.id)))
    .map(p => [p.id, p] as const));
  const hostIds = config.hostMode === 'random'
    ? (subShows?.eligibleHostPersonaIds ?? [...eligible.keys()]).filter((id: string) => eligible.has(id)
      && (config.guestMode !== 'fixed' || !(show.guestPersonaIds ?? []).includes(id)))
    : [show.personaId].filter((id: string) => eligible.has(id));
  if (!hostIds.length) return null;
  const hostPersonaId = hostIds[stableIndex(occurrence.id, hostIds.length)]!;
  const guestIds: string[] = config.template === 'outside-comfort-zone' || config.guestMode === 'none'
    ? []
    : config.guestMode === 'fixed'
      ? (show.guestPersonaIds ?? []).filter((id: string) => id !== hostPersonaId && eligible.has(id))
      : stableOrder<string>(((commonGround ? subShows?.eligibleHostPersonaIds : subShows?.eligibleGuestPersonaIds) ?? [...eligible.keys()])
        .filter((id: string) => id !== hostPersonaId && eligible.has(id)), occurrence.id)
        .slice(0, commonGround ? 1 : config.guestCount.min + stableIndex(`${occurrence.id}:guest-count`, config.guestCount.max - config.guestCount.min + 1));
  if (commonGround && new Set(guestIds).size !== 1) return null;
  return { hostPersonaId, guestPersonaIds: [...new Set(guestIds)].slice(0, 3) };
}

function showTime(input: GeneratedShowInput): string {
  const p = zonedParts(new Date(input.occurrence.startsAt));
  const end = zonedParts(new Date(input.occurrence.endsAt));
  const hour12 = settings.get().locale === 'en-US';
  const fmt = new Intl.DateTimeFormat(settings.get().locale || 'en-GB', {
    timeZone: settings.get().timezone || undefined,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const clock = (hour: number, minute: number) => {
    return new Intl.DateTimeFormat(settings.get().locale || 'en-GB', {
      timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12,
    }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)));
  };
  const date = fmt.format(new Date(input.occurrence.startsAt));
  const hours = Math.round((input.occurrence.endsAt - input.occurrence.startsAt) / 3_600_000 * 10) / 10;
  return `${date}, ${clock(p.hour, p.minute)}–${clock(end.hour, end.minute)} (${hours} hours)`;
}

function mergeEraWindows(eras: GeneratedShowPlan['eras']): GeneratedShowPlan['eras'] {
  const sorted = [...eras].sort((a, b) => (a.fromYear ?? -Infinity) - (b.fromYear ?? -Infinity));
  const merged: GeneratedShowPlan['eras'] = [];
  for (const era of sorted) {
    const previous = merged.at(-1);
    if (!previous || (previous.toYear != null && era.fromYear != null && era.fromYear > previous.toYear + 1)) {
      merged.push({ ...era });
      continue;
    }
    previous.fromYear = previous.fromYear == null || era.fromYear == null
      ? null : Math.min(previous.fromYear, era.fromYear);
    previous.toYear = previous.toYear == null || era.toYear == null
      ? null : Math.max(previous.toYear, era.toYear);
  }
  return merged;
}

export function discoveryGenreCounts(names: string[], tracks: readonly { genres?: readonly string[] | null; genre?: string | null }[]): Record<string, number> {
  const counts = new Map(names.map(name => [normGenre(name), 0]));
  const runsByTag = new Map<string, string[]>();
  for (const track of tracks) {
    const matches = new Set<string>();
    for (const tag of track.genres ?? (track.genre ? [track.genre] : [])) {
      let runs = runsByTag.get(tag);
      if (!runs) {
        runs = genreRuns(tag).filter(key => counts.has(key));
        runsByTag.set(tag, runs);
      }
      for (const key of runs) matches.add(key);
    }
    for (const key of matches) counts.set(key, counts.get(key)! + 1);
  }
  return Object.fromEntries(names.map(name => [name, counts.get(normGenre(name)) ?? 0]));
}

export async function loadDiscoveryGenreCounts(): Promise<Record<string, number>> {
  await library.load();
  return discoveryGenreCounts(Object.keys(library.stats().byGenre ?? {}), library.candidateFilterTracks());
}

export function showGenreChoices(byGenre: Record<string, number>, template: string, repertoireEstimate = 1) {
  const genres = Object.entries(byGenre)
    .filter(([name, count]) => name && count > 0)
    .map(([name, tracks]) => ({ name, tracks }));
  if (template === 'deep-discovery') return discoveryPalette(byGenre, repertoireEstimate).choices;
  return genres.sort((a, b) => b.tracks - a.tracks || a.name.localeCompare(b.name)).slice(0, 80);
}

export function normalizeGeneratedEditorialSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const value = { ...raw } as Record<string, unknown>;
  if (typeof value.rationale === 'string') value.rationale = value.rationale.trim().slice(0, 500);
  return value;
}

export async function generateShowPlan(input: GeneratedShowInput): Promise<GeneratedShowPlan> {
  const discovery = input.template === 'deep-discovery';
  const djChoice = input.template === 'dj-choice';
  const commonGround = input.template === 'common-ground';
  const outside = input.template === 'outside-comfort-zone';
  const timeCapsule = input.template === 'time-capsule';
  const genreLimit = 15;
  const requiredTracks = Math.max(input.minimumCoverage ?? 0, Math.ceil(2 * (input.occurrence.endsAt - input.occurrence.startsAt) / 240_000));
  const artistSpacing = input.artistSpacing ?? settings.get().llm.artistVarietyWindow;
  const requiredArtists = requiredShowArtists(requiredTracks, artistSpacing);
  const generationPass = input.coverageCorrection ? 'coverage-correction' : 'initial';
  const personas = settings.get().personas ?? [];
  const moodNames = settings.moodVocab();
  const hostPersona = personas.find((p: any) => p.id === input.cast.hostPersonaId);
  if (!hostPersona) throw new Error('The selected host is no longer available');
  const guests = input.cast.guestPersonaIds
    .map(id => personas.find((p: any) => p.id === id))
    .filter(Boolean);
  if (commonGround && (input.cast.guestPersonaIds.length !== 1 || guests.length !== 1 || guests[0]?.id === hostPersona.id)) {
    throw new Error('Common Ground requires a host and exactly one distinct guest');
  }
  if (outside && input.cast.guestPersonaIds.length) throw new Error('Outside the Comfort Zone requires a solo host');
  const host = {
    name: String(hostPersona.name || 'Host'),
    soul: String(hostPersona.soul || ''),
    musicLean: String(hostPersona.musicLean || '').trim(),
  };
  const existingShows = input.existingShows ?? scheduledShowsForHost(hostPersona.id, input.show?.id);
  const familiarGenres = new Set(existingShows.flatMap(show => show.genres).map(normGenre));
  const umbrellaGenres = new Set(['Rock', 'Pop', 'Electronic', 'Experimental'].map(normGenre));
  const evidencePersonas = [hostPersona, ...(commonGround ? guests : [])].map(persona => ({
    id: String(persona.id), name: String(persona.name || 'Selected DJ'), soul: String(persona.soul || '').trim(), musicLean: String(persona.musicLean || '').trim(),
  }));
  const knownUnready = evidencePersonas.filter(persona => !persona.musicLean && (!persona.soul || DJ_SOULS.includes(persona.soul))).map(persona => persona.name);
  if (knownUnready.length) throw musicalDetailError(knownUnready);
  let libraryStats: ReturnType<typeof library.stats> | null = null;
  try {
    await library.load();
    libraryStats = library.stats();
  } catch { /* Report unavailable coverage below; do not guess library suitability. */ }
  const indexedGenreCounts = libraryStats?.byGenre as Record<string, number> | undefined;
  const byGenre = input.template === 'deep-discovery' && libraryStats
    ? discoveryGenreCounts(Object.keys(indexedGenreCounts ?? {}), library.candidateFilterTracks())
    : indexedGenreCounts;
  // The model needs artist breadth as well as track totals: an album-sized
  // genre can pass track coverage while making the spacing setting impossible.
  const artistsByGenre = new Map(Object.keys(byGenre ?? {}).map(name => [normGenre(name), new Set<string>()]));
  const runsByTag = new Map<string, string[]>();
  for (const track of library.candidateFilterTracks()) {
    const artist = artistRootKey(track.artist ?? '');
    if (!artist) continue;
    for (const tag of track.genres?.length ? track.genres : track.genre ? [track.genre] : []) {
      let runs = runsByTag.get(tag);
      if (!runs) { runs = genreRuns(tag).filter(key => artistsByGenre.has(key)); runsByTag.set(tag, runs); }
      for (const key of runs) artistsByGenre.get(key)!.add(artist);
    }
  }
  const artistCounts = Object.fromEntries(Object.keys(byGenre ?? {}).map(name => [name, artistsByGenre.get(normGenre(name))!.size]));
  const repertoireEstimate = discovery ? Math.max(1, Math.ceil(requiredTracks / 2))
    : input.minimumCoverage ?? Math.max(1, Math.ceil((input.occurrence.endsAt - input.occurrence.startsAt) / 240_000));
  const discoveryAnchors = discovery ? [...existingShows.flatMap(show => show.genres),
    ...Object.keys(byGenre ?? {}).filter(genre => tagCoversGenre(`${host.soul} ${host.musicLean}`, normGenre(genre)))] : [];
  const discoveryOptions = discovery ? discoveryPalette(byGenre ?? {}, repertoireEstimate, discoveryAnchors, Math.random, { counts: artistCounts, minimum: requiredArtists }) : null;
  if (discoveryOptions && !discoveryOptions.core.length) throw libraryFitError('Deep Discovery needs meaningfully less-represented genres, but this catalogue has no smaller genre pools to explore.');
  const genreChoices = discoveryOptions?.choices ?? showGenreChoices(byGenre ?? {}, input.template, repertoireEstimate);
  const choices = genreChoices.filter(genre => (!outside || !familiarGenres.has(normGenre(genre.name)))
    && (!(outside || timeCapsule) || !umbrellaGenres.has(normGenre(genre.name)))
    && (!outside || artistCounts[genre.name] >= requiredArtists));
  if (!libraryStats) throw new ShowPlanningError('library-unavailable', 'Music library information is unavailable. Check the library connection and indexing, then try again.');
  if (!choices.length) throw libraryFitError('The indexed library has no available genre palette supporting this template.');
  const counts = byGenre ?? {};
  const paletteEntry = (genre: typeof choices[number]) => `${genre.name} [${genre.tracks} tracks; ${artistCounts[genre.name]} artists]`;
  const moods = moodNames;
  const estimate = Math.max(1, Math.ceil((input.occurrence.endsAt - input.occurrence.startsAt) / 240_000));
  const currentYear = new Date(input.occurrence.startsAt).getUTCFullYear();
  const periodCounts = new Map<number, Map<string, number>>();
  if (timeCapsule) for (const track of library.candidateFilterTracks()) {
    const year = resolveEraYear(track.year, track.originalYear, track.yearUntrusted ?? track.isCompilation);
    if (year == null || year < 1900 || year > currentYear) continue;
    const start = Math.floor(year / 5) * 5;
    const counts = periodCounts.get(start) ?? new Map<string, number>();
    for (const genre of new Set(track.genres?.length ? track.genres : track.genre ? [track.genre] : [])) {
      if (choices.some(choice => choice.name === genre)) counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
    periodCounts.set(start, counts);
  }
  const periodEvidence = [...periodCounts].sort(([a], [b]) => a - b).map(([start, counts]) => ({
    years: `${start}–${Math.min(start + 4, currentYear)}`,
    genres: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 6)),
  }));
  const allowEra = hasEraReference(`${input.planningPrompt} ${input.nameMode === 'custom' ? input.customName ?? '' : ''}`);
  const conceptErasSchema = generatedShowPlanSchema.shape.eras.max(allowEra ? 15 : 0)
    .describe('Explicit operator music restriction only. Otherwise empty, including when persona preferences mention favourite decades.');
  const baseConceptSchema = z.object({
    topic: generatedShowPlanSchema.shape.topic.max(1600),
    name: generatedShowPlanSchema.shape.name,
    intendedGenres: z.array(z.enum(choices.map(g => g.name) as [string, ...string[]])).min(1).max(genreLimit),
    eras: conceptErasSchema,
    talkingPoint: z.string().trim().min(1).max(300)
      .describe('one optional question anchored in the selected palette, inviting listening observations, subjective taste, associations or differing views; no invented memories, factual claims or extra music restriction'),
  });
  // Put the pair-specific evidence before the brief in the concept output
  // contract so the model must identify a connection rather than just name two styles.
  const timePeriodSchema = z.object({
    fromYear: z.number().int().min(1900).max(currentYear),
    toYear: z.number().int().min(1900).max(currentYear),
  }).describe('one closed music period, normally 1–5 years and never more than 10 years inclusive');
  const conceptSchema = discovery ? z.object({
    discoveryFocus: z.string().min(1).max(400).describe('Name one specific underrepresented musical neighbourhood and the audible characteristic connecting it to a stated host taste. "Cultural collisions", "genre-bending" and "distinctive voices and beats" alone are too generic.'),
    intendedGenres: baseConceptSchema.shape.intendedGenres,
    eras: conceptErasSchema,
    name: baseConceptSchema.shape.name,
    topic: baseConceptSchema.shape.topic.min(160).max(650)
      .describe('2–3 sentences naming the selected genres and their specific audible thread. Explain the host’s connection to THIS music. Do not substitute a list of the host’s broader tastes or promise those tastes as additional styles.'),
    talkingPoint: baseConceptSchema.shape.talkingPoint,
  }) : timeCapsule ? z.object({
    period: timePeriodSchema,
    musicalAngle: z.string().min(1).max(300).describe('why this period and coherent genre palette suit this particular DJ’s musical tastes'),
    name: baseConceptSchema.shape.name.describe('short musical title; no claims about the birth, invention, firsts, rise or definitive history of a genre'),
    topic: baseConceptSchema.shape.topic.min(160).max(650).describe('2–3 sentences: exact period, specific genre palette and this host’s musical angle. No named artists, tracks, historical claims or invented personal memories.'),
    talkingPoint: baseConceptSchema.shape.talkingPoint,
    intendedGenres: baseConceptSchema.shape.intendedGenres.max(3),
  }) : outside ? z.object({
    departure: z.object({
      familiarTerritory: z.string().min(1).max(300).describe('musical interests supported by Soul/Leanings and established repertoire from regular-show filters'),
      destination: z.enum(choices.map(genre => genre.name) as [string, ...string[]])
        .describe('the exact name of the primary destination genre, copied from the available choices'),
      bridge: z.string().min(1).max(300).describe('a concrete musical characteristic linking the host’s interests to the destination'),
      whyOutside: z.string().min(1).max(300).describe('how this departs from regular-show filters; distinguish documented repertoire from inferred taste'),
    }),
    eras: conceptErasSchema,
    name: baseConceptSchema.shape.name,
    topic: baseConceptSchema.shape.topic.min(160).max(650)
      .describe('State this host’s specific familiar musical interest, the audible bridge and the exact destination genre from departure in 2–3 sentences. Do not merely invite a journey or describe the destination.'),
    talkingPoint: baseConceptSchema.shape.talkingPoint,
  }) : commonGround ? z.object({
    musicalConnection: z.object({
      hostTaste: z.string().min(1).max(300).describe('a specific musical interest supported by the host Soul or Leanings, not presentation style'),
      guestTaste: z.string().min(1).max(300).describe('a specific musical interest supported by the guest Soul or Leanings, not presentation style'),
      sharedThread: z.string().min(1).max(300).describe('one concrete musical characteristic connecting these interests, without inventing a shared preference'),
    }),
    eras: conceptErasSchema,
    intendedGenres: baseConceptSchema.shape.intendedGenres,
    name: baseConceptSchema.shape.name,
    topic: baseConceptSchema.shape.topic.min(160).max(650)
      .describe('2–3 sentences explaining the musical connection and what each DJ brings; reflect musicalConnection; put the optional conversational thread in talkingPoint'),
    talkingPoint: baseConceptSchema.shape.talkingPoint,
  }) : baseConceptSchema;
  const proseInstruction = `The music pool must support at least ${requiredArtists} distinct artists after filters and exclusions for the operator’s Artist Spacing setting of ${artistSpacing} slots. More tracks by the same few artists do not provide variety. Indexed artist counts are advisory: overlapping genre counts cannot be summed. Prefer a connected palette with artist breadth beyond the minimum; a large track count by a few artists is insufficient. Do not impose unnecessary mood or energy filters. Write grammatical prose with intact punctuation. Apostrophes are valid inside JSON strings: retain them in contractions and possessives, never replace them with spaces ("we'll", not "we ll"; "the DJ's taste", not "the DJ s taste"). If unsure, use full forms such as "we will" or "the tastes of the host" instead. Preserve correct punctuation when copying or editing the concept.`;
  const talkingPointInstruction = 'Return talkingPoint separately from topic: one short, open question naturally suggested by this episode’s music and cast. Choose the angle that offers a fresh conversation for this episode rather than defaulting to a technical discussion of sound. Musical qualities are welcome, but subjective taste, listening habits, hypothetical settings or associations, discovery and what might change someone’s mind are equally valid. Invite room for different views without assigning opinions, manufacturing an argument or requiring agreement. Include at least one selected genre naturally so the question remains explicitly connected to the music; do not list the whole palette. It must be usable across the episode rather than depend on a named artist, particular track or sequence. Frame personal angles as opinions or possibilities, never invented memories, gigs or past listening experiences. Keep it within the declared palette and era; do not promise extra music or assume lyrics, instruments, production facts, history or social/cultural effects. This is an optional thread for occasional comments, not a script, mandatory feature or question to repeat on every link. Keep it to one sentence, with no Talking point label; the controller adds the label.';
  const identity = (p: any) => ({ name: p.name, soul: p.soul, ...(p.musicLean ? { musicalLeanings: p.musicLean } : {}) });
  const assessmentSchema = z.object({
    evidence: z.array(z.object({ personaId: z.enum(evidencePersonas.map(p => p.id) as [string, ...string[]]), source: z.enum(['soul', 'musicLean']), quote: z.string().min(1).max(500).describe('Copy a short musical preference verbatim from this persona’s selected source. Do not paraphrase, combine fields or quote another participant.') })).max(12),
    problem: z.enum(['none', 'persona-readiness', 'library-fit']),
    reason: z.string().max(500),
  });
  const responseSchema = z.object({ assessment: assessmentSchema, proposal: conceptSchema.nullable() });
  const readinessInstruction = `Before planning, apply a mandatory musical-readiness gate to the required participants supplied in the user data. Quote exact musical evidence from each participant's own soul or musicLean. An explicit preference for even one genre, artist, instrument, songwriting quality or musical style is sufficient. Soul OR musicLean is enough; either field may be empty, and no existing shows are needed. Copy a short relevant passage verbatim, not a summary. A participant with clear genres in musicLean is ready even if their Soul only describes presentation. Evidence must explicitly describe a taste in MUSIC. Never infer music from warmth, dry humour, plainspoken delivery, wistfulness, brevity, leaving conversational space, a welcoming voice, concise links, an eye for everyday details or presenter/station comparisons. These describe speech or personality, not music tastes. For example, Soul="a relaxed presenter with dry humour" and empty musicLean MUST return persona-readiness, evidence=[], proposal=null. Soul="loves folk rock" with empty musicLean supplies musical evidence; presentation-only Soul plus musicLean="loves folk rock" also supplies it. Regular-show filters are supporting repertoire evidence, not quotations from Soul or Leanings. If ANY required participant lacks musical evidence, return assessment.problem=persona-readiness, evidence only for supported participants, and proposal=null. Do not invent preferences or repertoire to fill this gap. Otherwise assess whether the supplied library supports THIS template's musical idea: a coherent palette, a genuinely less-represented territory for Deep Discovery, a credible neighbouring departure for Outside the Comfort Zone, a real musical connection for Common Ground, or a covered period for Time Capsule. A large track count or a long unrelated genre list alone is not sufficient. If no credible musical fit exists, include the exact evidence for every required participant, return library-fit with a short reason and proposal=null, even if many tracks exist. On success return problem=none, exact evidence for every required participant and the requested proposal. Never force a proposal when not ready.

`;
  const response = await djObject({
    system: readinessInstruction + proseInstruction + '\n\n' + (timeCapsule
      ? 'Plan one era-led radio episode interpreted through this host’s musical tastes. Choose a precise closed period with library coverage, then a coherent genre palette and short brief. Describe a partial decade using its exact four-digit year bounds or era-neutral wording, never a whole-decade label or early/mid/late shorthand. Do not invent historical facts or personal memories. Return only requested JSON.'
      : outside
      ? 'Plan one solo musical radio episode exploring a neighbouring territory outside the DJ’s familiar repertoire. Establish a supported starting point, a credible musical bridge and one focused destination, then write the brief and title. Return only the requested JSON.'
      : commonGround
      ? 'Plan one specific musical radio episode finding common ground between two DJs with equal musical influence. Write its short brief, derive its title, and declare the genre palette it promises. Return only the requested JSON.'
      : discovery ? 'Plan Deep Discovery: a coherent episode anchored in the library’s underrepresented genres. Start with a rare core connected to the host’s musical tastes, then use only adjacent supporting styles. Familiar broad genres alone cannot satisfy this template. Return only the requested JSON.'
      : 'Plan one specific musical radio episode led by the host. Write its short brief, derive its title, and explicitly declare the small genre palette the brief promises. Return only the requested JSON.'),
    prompt: `Required participants: ${JSON.stringify(evidencePersonas)}\n\nDeclared music contract: derive the genre palette from the musical brief and declare any operator-requested era with it. ${timeCapsule ? 'The period supplies the required era.' : 'Return eras in the proposal: [] unless the operator explicitly restricts the music by period. A custom title alone must only imply an era when it actually names one.'} Do not add performers, artist appearances, personal memories or historical claims. Only the supplied cast presents the show. No geographic artist/scene filter exists: a DJ's regional taste may explain their perspective, but never promise that the selected records come from that place. Unless an agreed era supports it, do not promise modern, contemporary, recent or new releases; describe the sound instead. Return normal readable punctuation, not literal Unicode escape sequences.\n\n` + (timeCapsule ? [
      `Host: ${JSON.stringify(identity(host))}`,
      `Guest perspectives (optional, host remains musical lead): ${JSON.stringify(guests.map(identity))}`,
      `Supporting regular-show music filters: ${JSON.stringify(existingShows)}`,
      `Local slot: ${showTime(input)}. Available genres: ${choices.map(paletteEntry).join('; ')}`,
      `Library period evidence (five-year bins, top six genres each; counts overlap): ${JSON.stringify(periodEvidence)}`,
      input.planningPrompt ? `Operator direction: ${input.planningPrompt}` : null,
      input.coverageCorrection || null,
      `Choose period first: a specific year or short closed window, preferably 1–5 years, at most 10 years inclusive. Both numeric bounds are required. Choose 1–3 specific coherent genres fitting that period and this host’s Soul plus optional Musical Leanings. Prefer a period supporting at least ${requiredTracks} unique tracks after era and genre filters; evidence bins are context, not proof of exact coverage. Rarity and a departure from familiar tastes are not required.`,
      'No country, regional scene or nationality restriction is available. Do not promise a British, American or other geographically exclusive selection. Do not turn period atmosphere into claims about where a genre emerged. Keep the talking point connected to this palette and period; subjective tastes and listening associations are welcome, but do not name artists or bands.',
      'Fill period and musicalAngle before writing. Use only specific genre choices; umbrella Rock, Pop, Electronic and Experimental are excluded, and must not be promised in the brief as extra music. Do not add padding genres when the main style already has coverage.',
      'The brief must state both exact numeric year bounds from period (or the single year); never replace a narrower window with a whole-decade label. It must also state the selected genre palette and this host’s particular musical angle. Use 2–3 concise sentences, at most 80 words. Do not broaden the period to present day, promise other decades, or make a definitive history programme. Do not name any artists, bands, albums or tracks. Do not claim the birth, emergence, invention, rise or golden age of a genre, including in the title. Do not invent release milestones, firsts, influence, remembered gigs or personal listening history. Discuss musical qualities and tastes rather than unsupported historical events.',
      talkingPointInstruction,
      'For this template, talkingPoint can concern musical qualities, subjective tastes, discovery or hypothetical listening associations within the chosen palette and period. Do not ask about the rise, influence, origin, impact or historical role of a genre, and do not introduce an unselected genre or compare with present-day music. No research is provided.',
      input.nameMode === 'custom' ? `Use this exact title: ${input.customName}` : 'Derive a distinctive short title from the musical idea. Avoid generic time-travel slogans and presenter names.',
      'Return name, topic, talkingPoint, intendedGenres, period and musicalAngle. Only promise the declared music and period. Mood and energy filters will remain unrestricted.',
    ].filter(Boolean).join('\n\n') : outside ? [
      `Host: ${JSON.stringify(identity(host))}`,
      `Scheduled regular-show filters, evidence of established repertoire rather than limits on taste: ${JSON.stringify(existingShows)}`,
      `Local slot: ${showTime(input)}. Available destination genres and indexed counts: ${choices.map(paletteEntry).join('; ')}`,
      input.planningPrompt ? `Operator direction: ${input.planningPrompt}` : null,
      input.coverageCorrection || null,
      'Fill departure first. Soul is primary; optional Musical Leanings supplement it. Use regular-show filters to distinguish documented repertoire from a plausible new destination. If no shows exist, explicitly acknowledge that the familiar territory is inferred from persona preferences. Never invent a dislike, a lack of knowledge or a past listening habit.',
      'State the exact destination genre in the brief and make its difference from the starting point clear. A genre absent from show filters may still be an explicit persona preference: do not pretend it is unfamiliar without explaining a more specific departure. Make ONE coherent sideways move, following something the DJ already appreciates into a related territory they do not normally programme. The musical bridge must explain why this DJ would be curious. The destination, not the familiar starting point, supplies the music throughout the show. Do not make a familiar set with occasional adjacent tracks, several unrelated excursions, or a deliberately distant challenge. Underrepresentation is not required. Presentation style and speaking pace do not define music taste.',
      `Choose ONE specific destination genre, copied exactly from the supplied choices, with enough music for ${requiredTracks} unique eligible tracks (twice airtime at a four-minute average). The controller uses departure.destination as the sole strict genre filter. If a destination lacks coverage, choose another coherent destination rather than padding it with an umbrella genre. Broad tags such as Electronic, Rock, Pop or Experimental do not describe a focused destination. Exact regular-show genres have already been excluded. Rarity is not a goal.`,
      'The bridge must name a concrete audible feature supported by this particular persona: instrumentation, rhythm, arrangement, texture or songwriting. Generic curiosity, atmosphere or experimentation alone is insufficient. Consider several plausible directions internally and choose the one with the strongest individual connection; do not default every host to post-punk or industrial. Do not invent genre history, classify a rock genre as electronic music, or claim the regular shows feature a sound not established by their filters or the persona.',
      'Write a concise brief of 2–3 sentences, at most 80 words: identify the starting interest, the musical bridge and the exact destination genre. Introduce familiar genres explicitly as the host’s existing tastes, then describe the move into the destination. Do not promise a blend, intersection or alternation with those familiar genres; the destination supplies all music. Invite an open-minded exploration without claiming that the DJ dislikes this music, is already an expert or has actually played particular records. Do not promise specific artists, tracks, genre alternation or a scripted journey. Only promise music in departure.destination.',
      talkingPointInstruction,
      input.nameMode === 'custom' ? `Use this exact title: ${input.customName}` : 'Derive an original short title from the musical idea, without presenter names, genre lists or the template name.',
      'Before returning, check that the brief actually states the specific starting interest, audible bridge and destination from departure, rather than just promising a journey. The talking point must be musically accurate. Keep the title and brief era-neutral unless the operator explicitly requests a music period. Return departure, eras, name, topic and talkingPoint.',
    ].filter(Boolean).join('\n\n') : commonGround ? [
      `Host (presentation lead only): ${JSON.stringify(identity(host))}`,
      `Guest (equal musical influence): ${JSON.stringify(identity(guests[0]))}`,
      `Supporting repertoire filters: ${JSON.stringify([{ dj: host.name, shows: existingShows }, { dj: guests[0]?.name, shows: scheduledShowsForHost(guests[0]!.id, input.show?.id) }])}`,
      `Local slot: ${showTime(input)}. Available genre names and indexed counts: ${choices.map(paletteEntry).join('; ')}`,
      input.planningPrompt ? `Operator direction: ${input.planningPrompt}` : null,
      input.coverageCorrection || null,
      'Fill musicalConnection first with a specific supported taste for each DJ and the musical thread connecting them. Do not infer a preference for a different genre just because its name shares a word with a stated preference. Find ONE specific musical connection that this particular pair could explore together. First identify each DJ’s actual musical interests in their Soul and optional Musical Leanings, then find a shared musical characteristic or a defensible bridge between them. Persona preferences take precedence over supporting show filters. Presentation style, speaking pace and personality are not musical preferences. Where a taste is inferred rather than stated, frame the territory as an invitation to explore it, not an established shared love.',
      'Give both DJs equal musical influence. Choose music that can serve the connection throughout the show. Each selected genre must belong to that same connection and offer something to both DJs. Do not assemble one DJ’s favourites beside the other’s in separate genre groups. Replacing either DJ should change the idea. Do not chase rarity or claim the connection is surprising merely because the genres differ.',
      `Select the smallest coherent palette that expresses the connection, usually 2–5 styles. Use more, up to 15, only when adjacent styles are needed to reach ${requiredTracks} unique matching tracks (twice airtime at a four-minute average). Prefer informative styles over broad umbrella tags that would admit unrelated music. A large pool is fine when musically appropriate; do not narrow it arbitrarily. Counts overlap and are not proof of combined coverage. Copy intendedGenres exactly from the supplied names.`,
      'Write topic as a concise commissioning brief of 2–3 sentences, at most 80 words. State the concrete musical thread and why it offers something to EACH DJ. Put the optional musical question in talkingPoint rather than repeating it in topic. Describe an idea for a show, without predicting dialogue, announcing the episode, narrating how they discover mutual understanding or promising specific artists, tracks or invented personal history. The brief must promise only the chosen genres.',
      talkingPointInstruction,
      input.nameMode === 'custom' ? `Use this exact title: ${input.customName}` : 'Derive a distinctive short show title from the musical thread. Do not use the template name, “Finding Common Ground”, presenter names or a list of genres as the title. Avoid generic discovery slogans.',
      'Keep the name and brief era-neutral. Favourite decades in persona notes or regular shows do not impose a date restriction. Only include a period when the operator explicitly requests that restriction. Return musicalConnection, intendedGenres, eras, name, topic and talkingPoint.',
    ].filter(Boolean).join('\n\n') : [
      `Host: ${JSON.stringify(identity(host))}`,
      `Guests (secondary): ${JSON.stringify(guests.map(identity))}`,
      `Template: ${input.template}; local slot: ${showTime(input)}.`,
      `Familiar repertoire, not speech instructions: ${JSON.stringify(existingShows)}`,
      discoveryOptions ? `These choices are present in the indexed library and have been pre-screened for this slot’s repertoire cue. Exact filtered coverage will be verified by the controller. Track/artist counts are advisory indexed coverage before other filters; they overlap across labels and cannot be summed. Choose enough artist breadth, not simply enough album tracks. Their order varies between runs and is not a suggested playlist or genre combination. Explore any part of the host’s musical tastes, choosing the musical connection before its genres. Underrepresented core choices: ${choices.filter(genre => genre.tracks <= discoveryOptions.ceiling).map(paletteEntry).join('; ')}. Supporting neighbours (not core): ${choices.filter(genre => genre.tracks > discoveryOptions.ceiling).map(paletteEntry).join('; ')}.` : `Available genre palette, with indexed matching-track counts: ${choices.map(paletteEntry).join('; ')}`,
      input.planningPrompt ? `Operator direction: ${input.planningPrompt}` : null,
      input.coverageCorrection || null,
      input.nameMode === 'custom' ? `Use this exact title: ${input.customName}` : 'Derive an original title from the brief.',
      'The Soul is primary and may contain all musical preferences. Musical Leanings is optional supplementary guidance. Choose a musical angle that fits stated preferences; calm speech, banter and personality do not impose music filters.',
      input.template === 'deep-discovery'
        ? `Fill discoveryFocus first: identify one specific musical neighbourhood suggested by this host’s stated tastes, with one audible thread such as a particular approach to rhythm, texture, arrangement or songwriting. Then select a coherent core from the CORE choices that realises that idea. intendedGenres must include at least one CORE choice. Prefer a musically connected CORE choice that already reaches the required artist breadth; use narrower styles only in a connected combination with enough distinct artists overall. Do not combine unrelated folk, jazz, rock and electronic labels simply because they are all small pools. The musical connection must explain every selected genre, not just the first two. At least half of the final unique eligible track pool must match core genres; a token rare tag beside a large popular genre fails. Supporting neighbours are optional, must follow the same musical thread, and cannot replace the core. Regular-show filters describe familiar territory, not the target palette. Build a coherent neighbourhood around this core, expanding into adjacent genres to provide at least ${requiredTracks} unique matching tracks at a four-minute average: twice the slot airtime, to allow for playback exclusions. Use up to 15 genres as needed. Counts overlap; include enough breadth, not only tiny tags. Adjacent neighbours may support the rare core only while core-matching tracks remain at least half the eligible pool. Rarity alone does not connect genres; avoid a generic genre journey or repeating the Soul.`
        : djChoice
          ? `Make this recognisably the host’s usual musical territory, with occasional sideways steps. Build the main genre core from their regular show filters, interpreted through the Soul and optional Musical Leanings. Add only a few musically adjacent genres absent from those shows; guests may suggest connections without displacing the host’s familiar centre. If there are no regular shows, infer the familiar core from the Soul and optional Musical Leanings. Do not chase rarity or invent a restrictive theme that crowds out familiar favourites. Choose specific styles where supported rather than unexplained catch-all genres. Use up to 15 genres as needed, covering at least ${requiredTracks} unique matching tracks at a four-minute average, twice the slot airtime. A smaller number of adjacent genres does not guarantee an occasional playback proportion; do not promise a fixed running order or ratio.`
          : 'Include familiar anchors when available and related wider-reaching choices from the supplied palette.',
      talkingPointInstruction,
      `Write a concise brief and name. Declare 1–${genreLimit} intendedGenres copied exactly from the available palette, never a catalogue dump. The brief must describe those same styles. Do not promise other genres, particular tracks or artists, a fixed playlist, release chronology or unsupported artistic influence. Do not invent personal history or airplay.`,
      'Keep the brief and title era-neutral by default. Do not promise decades or date ranges, including phrases such as “the 80s and beyond”, just because they appear in the Soul, Musical Leanings or regular shows. Only describe a bounded period when the operator explicitly requests it as a music restriction; the settings must then include matching era windows. Otherwise describe the musical connection without dates.',
      `Counts overlap; roughly ${estimate} four-minute records is a pacing estimate, not a hard minimum. Do not force era, mood or energy restrictions from favourite decades or presentation. Return intendedGenres, eras, name, topic and talkingPoint.`,
    ].filter(Boolean).join('\n\n')),
    schema: responseSchema, temperature: 0.7,
    kind: 'generateShowPlan.concept',
    telemetry: { show: input.show?.id, occurrence: input.occurrence.id, template: input.template, pass: generationPass },
  }) as z.infer<typeof responseSchema>;
  const assessment = response.assessment;
  const missing = missingMusicalEvidence(evidencePersonas, assessment.evidence, Object.keys(counts));
  if (missing.length) throw musicalDetailError(missing);
  if (assessment.problem === 'library-fit') throw libraryFitError(assessment.reason || 'No coherent musical direction is supported by the available music.');
  if (!response.proposal) throw new Error('The planner could not create a proposal from the supplied musical preferences. Please try again.');
  const concept = {
    ...response.proposal,
    name: input.nameMode === 'custom' ? input.customName! : normalizeShowProse(response.proposal.name),
    topic: normalizeShowProse(response.proposal.topic),
    talkingPoint: normalizeShowProse(response.proposal.talkingPoint),
  };
  const period = timeCapsule ? timePeriodSchema.parse('period' in concept ? concept.period : null) : null;
  if (period && (period.toYear < period.fromYear || period.toYear - period.fromYear >= 10)) throw new Error('Time Capsule requires a closed period of at most ten years');
  const intended = 'departure' in concept ? [concept.departure.destination] : [...new Set(concept.intendedGenres)];
  const agreedEras = mergeEraWindows(period ? [period] : 'eras' in concept ? concept.eras : []);
  const personaNames = personas.map((persona: { name: string }) => persona.name);
  const castNames = [host.name, ...guests.map(persona => persona.name)];
  const sourceTastes = [host.soul, host.musicLean, ...guests.map(persona => `${persona.soul} ${persona.musicLean ?? ''}`)].join(' ');
  const contextGenres = [
    ...existingShows.flatMap(show => show.genres),
    ...(commonGround ? scheduledShowsForHost(guests[0]!.id, input.show?.id).flatMap(show => show.genres) : []),
    ...Object.keys(counts).filter(genre => tagCoversGenre(sourceTastes, normGenre(genre))),
  ];
  // Genre-name matches are editorial feedback: comparisons to familiar tastes
  // are not necessarily playback promises. Fixed filters are assembled below.
  const genreContract = { known: Object.keys(counts), selected: intended, context: contextGenres };
  let draftIssue: string | null = null;
  try {
    validateShowBrief({ name: input.nameMode === 'custom' ? input.customName! : concept.name, topic: concept.topic, talkingPoint: concept.talkingPoint }, agreedEras, personaNames, castNames, { ...genreContract, inspectAmbiguous: discovery });
  } catch (error) { draftIssue = error instanceof Error ? error.message : 'The draft contradicts the music contract.'; }
  let fixedTitle: string | null = input.nameMode === 'custom' ? input.customName! : concept.name;
  if (fixedTitle != null && input.nameMode !== 'custom') {
    try { validateShowBrief({ name: fixedTitle, topic: '', talkingPoint: '' }, agreedEras, personaNames, castNames, genreContract); }
    catch { fixedTitle = null; }
  }
  const settingsSchema = generatedShowPlanSchema.omit({ genres: true, eras: true, filtersStrict: true }).extend({
    name: fixedTitle == null ? generatedShowPlanSchema.shape.name : z.literal(fixedTitle),
    topic: generatedShowPlanSchema.shape.topic.max(1200)
      .describe('A fuller presentation brief, aiming for 80–120 words when useful, with no minimum. Expand the host/guest perspective and listening invitation, never the fixed music filters.'),
    talkingPoint: baseConceptSchema.shape.talkingPoint,
    moods: generatedShowPlanSchema.shape.moods.max(timeCapsule || outside && !input.planningPrompt.trim() ? 0 : 2),
    energies: generatedShowPlanSchema.shape.energies.max(timeCapsule || outside && !input.planningPrompt.trim() ? 0 : 15),
  });
  let music: z.infer<typeof settingsSchema>;
  try {
    music = await djObject({
      system: `${proseInstruction} Compile and edit the accepted musical proposal. ${discovery ? 'Make the brief describe the required genres and discoveryFocus specifically. Name the selected styles in its opening sentence. Rewrite a generic or contradictory draft around that music; do not merely remove a few genre words while keeping an unrelated premise. Host tastes explain the connection, not additional music being played.' : 'Expand a short accepted topic into a fuller presentation brief while preserving its musical premise and concrete details. Preserve a correct talkingPoint. Repair contradictions and unsupported promises, but do not anonymise the DJs or replace the idea with a generic journey.'} Keep its distinctive musical idea, genre palette, agreed era, title and cast. Return a final name, fuller topic, separate talkingPoint, moods, energies and rationale. The controller supplies fixed genres, eras and strictness. Extra prose adds presentation context only, never new selection constraints. Remove unsupported promises; do not introduce another idea. Describe the required genre palette faithfully. ${timeCapsule ? 'Preserve the required closed era exactly; describe it with its full four-digit year bounds or era-neutral wording, never decade shorthand or early/mid/late qualifiers. Leave moods and energies empty.' : 'Default mood and energy lists to empty.'}`,
      prompt: [
        `Accepted proposal: ${JSON.stringify(concept)}`,
        draftIssue ? `Detected draft problem: ${draftIssue.replace(' Please regenerate the episode.', '')} Repair this before publishing. Check the entire draft for similar contradictions; do not merely copy it. Remove unselected style promises rather than adding filters. Preserve the musical angle that fits the selected palette.` : 'No concrete contract mismatch was found. Preserve the premise and concrete details while expanding only the presentation context where useful.',
        `Required music contract: ${JSON.stringify({ genres: intended, eras: agreedEras, filtersStrict: true })}. Do not return the fixed genres, eras or filtersStrict fields. They are supplied by the controller; use them as the immutable contract for the prose.`,
        `Allowed genre labels in the brief and talking point: ${JSON.stringify({ selectedMusic: intended, familiarTasteContext: [...new Set(contextGenres)] })}. Only selectedMusic describes records being played. familiarTasteContext may explain supported existing tastes or the bridge, never extra music. Use only labels from these lists, even when the accepted concept uses another label in its starting point. Do not refine a broad preference into an unlisted subgenre. If a starting label is absent, describe the supported interest in plain terms such as melodic guitars rather than naming that style. Do not add or change filters to justify prose.`,
        `Actual cast: ${JSON.stringify({ host: host.name, guests: guests.map(persona => persona.name) })}. These are the only presenters. Artists whose records might be selected are not studio guests. Do not promise surprise guests, special artists, interviews, particular records or artist appearances.`,
        input.nameMode === 'custom' ? `Preserve this exact operator title: ${input.customName}` : 'Keep the concept title unless it contradicts the contract; then make a short truthful revision.',
        `Write topic as a fuller presentation brief, aiming for 80–120 words when the idea benefits from it; this is a target, not a minimum, and shorter focused briefs are fine. Explain the musical idea, why it suits the host, what the actual guests bring when present, and what listeners can listen for or consider. Add useful subjective perspective rather than filler, invented facts, biography or predicted dialogue. Do not repeat the separate talking point or script a disagreement. State the selected styles naturally. Expand only within the fixed music contract: no extra genres, eras, moods, energy locks, geographic selection promises, artists or running order. ${outside ? 'Preserve the specific familiar interest, audible bridge and exact destination from departure. Do not merely describe the destination. Familiar tastes explain the bridge, but the destination alone supplies the music; never promise a blend or alternation with the starting genre.' : 'Do not promise additional genres.'}`,
        agreedEras.length ? 'Mention the agreed period accurately. Do not broaden a short window to a whole decade, other periods or present day unless the agreed bounds cover that music.' : 'Keep name, topic and talkingPoint era-neutral. Remove all decade/year promises, including “the 80s and beyond”, and unsupported modern/contemporary/recent/new-release promises. Do not add era filters to justify them.',
        'No research is provided. Remove historical milestones, origins, firsts, golden ages, influence claims, invented memories, existing-airplay claims and geographical exclusivity. Describe supported musical qualities or subjective listening perspectives instead. A DJ’s regional musical interests explain their perspective, not the origin of the records selected: rewrite scene-exclusive promises as persona perspective. Do not name artists, bands, tracks or albums in the brief. Use normal readable punctuation, not literal Unicode escape sequences.',
        talkingPointInstruction,
        'The talking point must fit this same music contract. A subjective opinion, listening association or contrast is welcome; it is not a factual claim, history lesson or promise of extra music.',
        `Indexed counts (overlapping coverage context only): ${JSON.stringify(Object.fromEntries(intended.map(name => [name, counts[name]])))}`,
        `Allowed moods: ${moods.join(', ')}. Leave moods and energies empty unless an explicit operator music requirement needs them. Presentation style, a theme or favourite decade is not such a requirement.`,
        input.planningPrompt ? `Operator direction: ${input.planningPrompt}` : null,
        `Return name, topic, talkingPoint, moods, energies and a rationale under 500 characters. Explain the musical idea${djChoice ? ', its familiar core and connected departures' : commonGround ? ' and the connection between the two DJs' : outside ? ' and the musical bridge into the destination' : timeCapsule ? ' and why the period suits the host' : ' and its coherent discovery neighbourhood'}, not merely that genres were copied.`,
      ].filter(Boolean).join('\n\n'),
      schema: settingsSchema, temperature: 0.1,
      kind: 'generateShowPlan.musicSettings',
      telemetry: { show: input.show?.id, occurrence: input.occurrence.id, template: input.template, pass: generationPass },
    }) as z.infer<typeof settingsSchema>;
  } catch (error) {
    // Bound an overlong rationale without another model call.
    try {
      if (!error || typeof error !== 'object' || !('text' in error) || typeof error.text !== 'string') throw error;
      music = settingsSchema.parse(normalizeGeneratedEditorialSettings(JSON.parse(error.text)));
    } catch { throw error; }
  }
  const parsed = settingsSchema.parse(normalizeGeneratedEditorialSettings({
    ...music,
    name: input.nameMode === 'custom' ? input.customName! : normalizeShowProse(music.name),
    topic: normalizeShowProse(music.topic),
    talkingPoint: normalizeShowProse(music.talkingPoint),
    rationale: normalizeShowProse(music.rationale),
  }));
  const validateProse = () => validateShowBrief(parsed, agreedEras, personaNames, castNames);
  try { validateProse(); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('The show brief promises')) throw error;
    // One bounded editorial repair. The accepted music contract is fixed
    // and are deliberately absent from the response schema.
    const proseSchema = z.object({
      name: input.nameMode === 'custom' ? z.literal(input.customName!) : generatedShowPlanSchema.shape.name,
      topic: settingsSchema.shape.topic,
      talkingPoint: baseConceptSchema.shape.talkingPoint,
    });
    const repaired = proseSchema.parse(await djObject({
      system: `${proseInstruction} Repair only the dated wording in this radio brief. Return name, topic and talkingPoint. Do not return or change music settings.`,
      prompt: [
        `Problem: ${error.message}`,
        `Fixed contract: ${JSON.stringify({ genres: intended, eras: agreedEras, cast: castNames })}`,
        agreedEras.length
          ? 'Use only exact full four-digit years or year ranges from the supplied eras, or remove date wording. Remove ALL decade shorthand and early/mid/late qualifiers from name, topic and talkingPoint; replace them with the exact numeric range or era-neutral wording. Do not broaden a short period to a whole decade or present day.'
          : 'The music has NO era restriction. Remove EVERY year, decade and period promise from ALL three fields, even dates used to describe the DJs’ tastes. Do not replace them with modern, contemporary, recent or new-release promises. Describe tastes and the musical connection without dates.',
        `Keep the selected musical idea and actual presenters. Preserve the title unless it contradicts the period; an operator title must remain exact. Do not invent history or add styles. Current prose: ${JSON.stringify({ name: parsed.name, topic: parsed.topic, talkingPoint: parsed.talkingPoint })}`,
      ].join('\n\n'),
      schema: proseSchema, temperature: 0.1, kind: 'generateShowPlan.briefRepair',
      telemetry: { show: input.show?.id, occurrence: input.occurrence.id, template: input.template, pass: generationPass },
    }));
    parsed.name = input.nameMode === 'custom' ? input.customName! : normalizeShowProse(repaired.name);
    parsed.topic = normalizeShowProse(repaired.topic);
    parsed.talkingPoint = normalizeShowProse(repaired.talkingPoint);
    validateProse();
  }
  if (parsed.moods.some(mood => !moods.includes(mood))) throw new Error('Music settings returned a mood outside the station vocabulary');
  return generatedShowPlanSchema.parse({
    ...parsed, genres: intended, eras: agreedEras, filtersStrict: true,
    topic: `${period ? `${host.name} explores ${intended.join(', ')} from ${period.fromYear === period.toYear ? period.fromYear : `${period.fromYear}–${period.toYear}`}.\n\n` : ''}${parsed.topic}\n\nTalking point (optional thread): ${parsed.talkingPoint}`,
    moods: [...new Set(parsed.moods)], energies: [...new Set(parsed.energies)],
    name: input.nameMode === 'custom' ? input.customName : parsed.name,
  });
}
