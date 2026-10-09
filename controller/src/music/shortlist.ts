// Track Shortlist discovery: a deterministic source plan run against the same
// picker-tool registry the Agentic route uses, so every candidate passes the
// identical show, recency and policy guards. Nothing here calls an LLM, chooses
// a track, or writes queue state.

import { buildPickerTools, type PickerScope } from '../llm/tools.js';
import { SHORTLIST_PASSES_BOUNDS } from '../schemas/settings.js';
import * as library from './library.js';
import { mixCompat, type Analysis } from './mix.js';
import { filterPickerCandidates } from './recency.js';
import { type YearRange, hasEraBound } from './show-filter.js';
import { shortlistOffers, type CandidateOffers } from './shortlist-offers.js';
import { shortlistSearchCalls, type ShortlistSearch } from './shortlist-search.js';

export type ShortlistSourceCall = {
  source: string;
  args: Record<string, unknown>;
  family: 'context' | 'continuity' | 'diversity';
};

export type ShortlistPlanningContext = {
  scope: PickerScope;
  // The current track remains a discovery seed, never a shortlist candidate.
  currentTrackId: string | null;
  currentArtist?: string | null;
  discoveryPasses: number;
  // Resolved from the show snapshot by the eventual controller call site. The
  // scope carries strict locks; these soft values are only source arguments.
  moods?: string[] | null;
  energies?: string[] | null;
  genres?: string[] | null;
  eras?: YearRange[] | null;
  dominantMood?: string | null;
  // Mirrors the existing ε-greedy deep-cut nudge. Callers decide the random
  // draw once, outside this deterministic planner.
  explore?: boolean;
  // Prepared query data only. The controller chooses executable sources.
  searches?: readonly ShortlistSearch[];
  // Where the family and source rotation starts. The live pick passes a fresh
  // draw so a station does not run the same plan every time one anchor (or a
  // cold start with no anchor) comes round; absent, the rotation is keyed on
  // the anchor id, which keeps a given input reproducible for tests and the
  // Discovery Bench.
  rotationSeed?: number;
  // What the next track should meet: a DJ-mode run's tempo/key target, else
  // the expected predecessor's measured analysis. Orders the finished
  // shortlist (orderByTransitionFit); absent, the plan's order stands.
  transitionTarget?: Analysis | null;
};

const ENERGY_VALUES = new Set(['low', 'medium', 'high']);

function strings(values: string[] | null | undefined): string[] {
  return [...new Set((values ?? []).filter(value => typeof value === 'string' && value.length > 0))];
}

function stableOffset(value: string | null): number {
  let hash = 0;
  for (const char of value || '') hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function rotated<T>(values: T[], offset: number): T[] {
  if (!values.length) return [];
  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

// Build a bounded mix of musical context, local continuity and catalogue
// diversity. Targeted searches need prepared editorial intent; request-only
// tools never belong in this plan. All candidates pass through the shared
// picker registry and its show, recency and policy guards.
export function planShortlistSources(
  context: ShortlistPlanningContext,
  availableSources: ReadonlySet<string>,
): ShortlistSourceCall[] {
  const budget = Math.max(
    SHORTLIST_PASSES_BOUNDS.min,
    Math.min(SHORTLIST_PASSES_BOUNDS.max, Math.floor(context.discoveryPasses) || SHORTLIST_PASSES_BOUNDS.min),
  );
  const offset = Number.isFinite(context.rotationSeed)
    ? Math.abs(Math.floor(context.rotationSeed as number)) >>> 0
    : stableOffset(context.currentTrackId);
  const lanes: Record<ShortlistSourceCall['family'], ShortlistSourceCall[]> = {
    context: [], continuity: [], diversity: [],
  };
  const add = (
    family: ShortlistSourceCall['family'],
    source: string,
    args: Record<string, unknown> = {},
  ) => {
    if (availableSources.has(source)) lanes[family].push({ source, args, family });
  };

  const moods = strings(context.moods);
  if (!moods.length && context.dominantMood) moods.push(context.dominantMood);
  const energies = strings(context.energies).filter(value => ENERGY_VALUES.has(value));
  const genres = strings(context.genres?.length ? context.genres : context.scope.genreLock);
  const ownsDirection = !!(context.scope.episodeSource || context.scope.playlistLock || context.scope.audioWaypoint?.length);

  if (context.scope.episodeSource) add('context', 'episodeArtistTracks');
  if (context.scope.audioWaypoint?.length) add('context', 'tracksTowardJourney');
  if (context.scope.playlistTracks?.length) add('context', 'showPlaylistTracks');
  const targeted: ShortlistSourceCall[] = shortlistSearchCalls(context.searches ?? [], availableSources);
  lanes.context.push(...targeted);
  // Every allowed value participates in rotation; a bounded pick need not
  // query every value, but the first chip must not own discovery indefinitely.
  for (const mood of moods) {
    for (const energy of energies.length ? energies : [null]) add('context', 'tracksByMood', { mood, energy });
  }
  if (!context.scope.hasPlaylistAnchor && !context.scope.playlistTracks?.length && !context.scope.playlistLock) {
    for (const mood of moods) add('context', 'moodPlaylistTracks', { mood });
  }
  if (!moods.length) for (const energy of energies) add('context', 'tracksByEnergy', { energy });
  for (const genre of genres) add('context', 'songsByGenre', { genre });
  for (const era of context.eras ?? context.scope.eraLock ?? []) {
    if (hasEraBound([era])) add('context', 'songsByEra', { fromYear: era.fromYear ?? null, toYear: era.toYear ?? null });
  }
  // The audience is context too, but a station-wide lean. Where an episode,
  // journey or strict playlist owns the direction, a favourites pass either
  // comes back intersected to nothing or pulls against that direction.
  if (!ownsDirection) add('context', 'listenerFavourites');

  if (context.currentTrackId) {
    add('continuity', 'tracksThatSoundLikeThis', { songId: context.currentTrackId });
    add('continuity', 'tracksLikeThis', { songId: context.currentTrackId });
    add('continuity', 'similarSongs', { songId: context.currentTrackId });
    add('continuity', 'sonicSimilarTracks', { songId: context.currentTrackId });
  }

  if (context.currentArtist) add('continuity', 'similarArtistTracks', { artist: context.currentArtist });

  // Strict playlists and sonic journeys own the direction, so they do not
  // spend a pass on an unfocused diversity source.
  const diversity = (context.scope.playlistLock || context.scope.audioWaypoint?.length
    ? []
    : rotated(
      ['deepCuts', 'starredSongs', 'recentlyAdded', 'randomSongs', 'frequentAlbums',
        ...(!strings(context.moods).length && !context.scope.moodLock?.length && moods.length && !ownsDirection ? ['moodWildcard'] : [])],
      Math.floor(offset / 3),
    )
  ).filter((source) => availableSources.has(source));
  if (context.explore && diversity.includes('deepCuts')) {
    diversity.splice(diversity.indexOf('deepCuts'), 1);
    diversity.unshift('deepCuts');
  }
  for (const source of diversity) add('diversity', source, source === 'moodWildcard' ? { excludeMoods: moods } : {});

  const calls: ShortlistSourceCall[] = [];
  const families: ShortlistSourceCall['family'][] = ['context', 'continuity', 'diversity'];
  const familyOrder = ownsDirection ? families : rotated(families.filter(family => lanes[family].length), offset);
  if (!ownsDirection) {
    lanes.context = rotated(lanes.context, Math.floor(offset / families.length));
    lanes.continuity = rotated(lanes.continuity, Math.floor(offset / families.length));
    if (context.explore && familyOrder.includes('diversity')) {
      familyOrder.splice(familyOrder.indexOf('diversity'), 1);
      familyOrder.unshift('diversity');
    }
  }
  // A soft playlist is operator direction too. Reserve one of the configured
  // passes for it; stronger episode/journey direction keeps its precedence.
  if (!ownsDirection && context.scope.playlistTracks?.length) {
    const playlistIndex = lanes.context.findIndex(call => call.source === 'showPlaylistTracks');
    if (playlistIndex >= 0) calls.push(...lanes.context.splice(playlistIndex, 1));
  }
  // Reserve at most one existing pass for the show's targeted intent when
  // there is room for another source. A one-pass station rotates it normally;
  // episodes, strict playlists and journeys retain their precedence.
  if (!ownsDirection && budget >= 2 && targeted.length && calls.length < budget) {
    const target = rotated(targeted, Math.floor(offset / 3))[0];
    calls.push(target);
    lanes.context = lanes.context.filter(call => !targeted.includes(call));
  }
  const cycle = () => ({
    context: [...lanes.context],
    continuity: [...lanes.continuity],
    diversity: [...lanes.diversity],
  });
  let remaining = cycle();
  while (calls.length < budget && familyOrder.some((family) => remaining[family].length)) {
    let added = false;
    for (const family of familyOrder) {
      const call = remaining[family].shift();
      if (call) {
        calls.push(call);
        added = true;
      }
      if (calls.length === budget) break;
    }
    if (!added) break;
    if (!familyOrder.some((family) => remaining[family].length) && calls.length < budget) {
      remaining = cycle();
    }
  }
  return calls;
}

export type ShortlistSourceRun = ShortlistSourceCall & {
  status: 'ok' | 'unavailable' | 'invalid' | 'error';
  returned: number;
  accepted: number;
  elapsedMs: number;
  error?: string;
};

// The picker registry's own slim projection of a track: the same object a
// tool returned to the Agentic model and a corrective re-pick reads from `seen`.
export type PickerCandidate = Record<string, any> & { id: string };
// A Shortlist candidate is that projection plus the source that surfaced it.
export type ShortlistCandidate = PickerCandidate & { shortlistSources: string[] };

export type ShortlistResult = {
  candidates: ShortlistCandidate[];
  sourceRuns: ShortlistSourceRun[];
  uniqueCandidates: number;
  elapsedMs: number;
};

type PickerTool = {
  inputSchema?: { safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ message?: string }> } } };
  execute?: (args: unknown, context: unknown) => Promise<unknown>;
};

type PickerToolSet = Record<string, PickerTool | undefined>;

function trackCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== 'object') return 0;
  const value = result as { tracks?: unknown; candidates?: unknown };
  if (Array.isArray(value.tracks)) return value.tracks.length;
  if (Array.isArray(value.candidates)) return value.candidates.length;
  return 0;
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : undefined;
}

// Execute an explicit source plan against a freshly-built picker registry.
// `seen` is the existing registry's authoritative, already-filtered and
// de-duplicated candidate accumulator; the size delta is therefore the exact
// number this source contributed to a vanilla agent run. It is also why a
// candidate carries exactly ONE source: a later source that returns an
// already-seen track has it filtered out before this code can see it, so
// provenance is "the source that first surfaced it", never a full list.
export async function executeShortlistPlan(
  tools: PickerToolSet,
  seen: Map<string, any>,
  plan: ShortlistSourceCall[],
  options: { topUps?: ShortlistSourceCall[]; minimumCandidates?: number; maxPerArtist?: number; offers?: CandidateOffers } = {},
): Promise<ShortlistResult> {
  const started = performance.now();
  const sourceRuns: ShortlistSourceRun[] = [];
  const sourcesById = new Map<string, string[]>();

  const balanced = () => balanceShortlist([...seen.values()], options.maxPerArtist, options.offers);
  const calls = [...plan];
  // Recovery is at most the supplied top-up sources, not an unbounded retry.
  // It never weakens scope locks or changes how either route handles models.
  for (const call of options.topUps ?? []) {
    if (!calls.some(planned => planned.source === call.source)) calls.push(call);
  }
  for (let index = 0; index < calls.length; index++) {
    if (index >= plan.length && balanced().length >= (options.minimumCandidates ?? 4)) break;
    const call = calls[index];
    const tool = tools[call.source];
    if (!tool?.execute) {
      sourceRuns.push({ ...call, status: 'unavailable', returned: 0, accepted: 0, elapsedMs: 0 });
      continue;
    }

    const parsed = tool.inputSchema?.safeParse?.(call.args);
    if (parsed && !parsed.success) {
      sourceRuns.push({
        ...call,
        status: 'invalid',
        returned: 0,
        accepted: 0,
        elapsedMs: 0,
        error: parsed.error?.issues?.[0]?.message || 'invalid source input',
      });
      continue;
    }

    const before = new Set(seen.keys());
    const callStarted = performance.now();
    try {
      const result = await tool.execute(parsed?.data ?? call.args, {
        toolCallId: `shortlist:${call.source}`,
        messages: [],
      });
      const added = [...seen.keys()].filter((id) => !before.has(id));
      for (const id of added) sourcesById.set(id, [call.source]);
      sourceRuns.push({
        ...call,
        status: resultError(result) ? 'error' : 'ok',
        returned: trackCount(result),
        accepted: added.length,
        elapsedMs: Math.round(performance.now() - callStarted),
        ...(resultError(result) ? { error: resultError(result) } : {}),
      });
    } catch (err) {
      sourceRuns.push({
        ...call,
        status: 'error',
        returned: 0,
        accepted: 0,
        elapsedMs: Math.round(performance.now() - callStarted),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const candidates = balanced().map(candidate => ({
    ...candidate,
    shortlistSources: sourcesById.get(candidate.id) || [],
  }));
  return {
    candidates,
    sourceRuns,
    uniqueCandidates: candidates.length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// Native entry point: build the same source-owned registry the agent used,
// plan only from sources it actually exposed, then reuse the shared filtered
// accumulator for execution. No LLM calls, choice, or queue writes occur here.
export async function buildShortlist(context: ShortlistPlanningContext, offers: CandidateOffers = shortlistOffers): Promise<ShortlistResult> {
  const { tools, seen } = buildPickerTools(context.scope);
  const plan = planShortlistSources(context, new Set(Object.keys(tools)));
  const topUps: ShortlistSourceCall[] = ['starredSongs', 'randomSongs']
    .filter(source => source in tools)
    .map(source => ({ source, args: {}, family: 'diversity' }));
  const result = await executeShortlistPlan(tools as PickerToolSet, seen, plan, {
    topUps, minimumCandidates: 4,
    maxPerArtist: context.scope.playlistLock || context.scope.episodeSource ? Infinity : 3,
    offers,
  });
  if (!context.transitionTarget) return result;
  return {
    ...result,
    candidates: orderByTransitionFit(result.candidates, context.transitionTarget, (candidate) => library.bpmKeyFor(candidate), offers),
  };
}

// Apply the cap to the merged set at choice time, leaving Agentic discovery
// intact. Strict single-artist playlists and prepared episodes are exempt.
export function balanceShortlist<T extends PickerCandidate>(
  candidates: T[], maxPerArtist = Infinity, offers?: CandidateOffers,
): T[] {
  const ordered = offers ? offers.order(candidates) : candidates;
  return filterPickerCandidates(ordered, { maxPerArtist });
}

// Soft order, never a filter: the candidates that meet the target cleanly lead
// the list the model reads — the pool's softRankByCompat does the same job
// before its cap. Scored with mix.mixCompat, the station's one tempo + key fit
// (the target's ending key against the candidate's opening key). Stable, so
// ties keep the plan's order, and an unanalysed target changes nothing.
export function orderByTransitionFit<T>(
  candidates: T[],
  target: Analysis | null | undefined,
  analysisOf: (candidate: T) => Analysis,
  offers?: CandidateOffers,
): T[] {
  if (!target || (target.bpm == null && target.key == null && target.keyEnd == null)) return candidates;
  return candidates
    .map((candidate, index) => ({
      candidate, index,
      fit: mixCompat(target, analysisOf(candidate)) - (offers ? offers.penalty((candidate as PickerCandidate).id) : 0),
    }))
    .sort((a, b) => b.fit - a.fit || a.index - b.index)
    .map(({ candidate }) => candidate);
}
