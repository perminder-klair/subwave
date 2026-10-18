// Track Shortlist discovery: a deterministic source plan run against the same
// picker-tool registry the Agentic route uses, so every candidate passes the
// identical show, recency and policy guards. Nothing here calls an LLM, chooses
// a track, or writes queue state.

import { PICKER_TOOL_TIMEOUT_MS } from '../llm/internal/tools/picker/defs.js';
import { buildPickerTools, type PickerScope } from '../llm/tools.js';
import { SHORTLIST_PASSES_BOUNDS, SHORTLIST_PASSES_DEFAULT } from '../schemas/settings.js';
import * as library from './library.js';
import { mixCompat, type Analysis } from './mix.js';
import { artistCreditsOverlap, artistRootKey, creditInRoots, filterPickerCandidates } from './recency.js';
import { type YearRange, hasEraBound } from './show-filter.js';
import { shortlistOffers, type CandidateOffers } from './shortlist-offers.js';
import { shortlistSearchCalls, type ShortlistSearch } from './shortlist-search.js';
import { allowsMoodWildcardDiscovery } from './discovery-policy.js';

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
  // queue.neighbourArtistRoots(artistVarietyWindow): the acts just played or
  // already queued. Absent (a prepared episode, the Discovery Bench), the
  // list is offered without spacing.
  recentArtistRoots?: ReadonlySet<string>;
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
  for (const mood of moods) add('context', 'moodPlaylistTracks', { mood });
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
        ...(moods.length && allowsMoodWildcardDiscovery({ ...context.scope,
          hasPinnedMoods: context.scope.hasPinnedMoods || !!strings(context.moods).length,
        }) ? ['moodWildcard'] : [])],
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
  if (!ownsDirection && budget - calls.length >= 2 && targeted.length) {
    const target = rotated(targeted, Math.floor(offset / 3))[0];
    calls.push(target);
    lanes.context = lanes.context.filter(call => !targeted.includes(call));
  } else if (!ownsDirection && targeted.length && calls.length) {
    const ordinary = lanes.context.filter(call => !targeted.includes(call));
    lanes.context = rotated([...targeted, ...ordinary], Math.floor(offset / 3));
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
  // Candidates left out because their artist is inside the spacing window.
  // Zero when nothing fresher was found and the window was waived.
  spacingSkipped?: number;
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
  options: { topUps?: ShortlistSourceCall[]; minimumCandidates?: number; maxPerArtist?: number; avoidArtist?: string | null; recentArtistRoots?: ReadonlySet<string>; offers?: CandidateOffers; sourceTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ShortlistResult> {
  const started = performance.now();
  const sourceRuns: ShortlistSourceRun[] = [];
  const sourcesById = new Map<string, string[]>();

  const avoidRoot = artistRootKey(options.avoidArtist || '');
  const offerable = () => withRecentSpacing(withoutArtist(
    balanceShortlist([...seen.values()], options.maxPerArtist, options.offers), avoidRoot,
  ), options.recentArtistRoots);
  const calls = [...plan];
  // Recovery is at most the supplied top-up sources, not an unbounded retry.
  // It never weakens scope locks or changes how either route handles models.
  for (const call of options.topUps ?? []) {
    if (!calls.some(planned => planned.source === call.source)) calls.push(call);
  }
  for (let index = 0; index < calls.length; index++) {
    // Counted after the anchor exclusion, so a list that is mostly the anchor
    // artist still earns its top-ups.
    if (index >= plan.length && offerable().fresh.length >= (options.minimumCandidates ?? 4)) break;
    if (options.signal?.aborted) break;
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
        abortSignal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.sourceTimeoutMs ?? PICKER_TOOL_TIMEOUT_MS)])
          : AbortSignal.timeout(options.sourceTimeoutMs ?? PICKER_TOOL_TIMEOUT_MS),
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

  // Never-starve: when every candidate is the anchor artist, offer them all and
  // let the artist guard's pool rescue answer it, exactly as before. Spacing
  // yields the same way: with no fresher artist, the recent ones stay offered.
  const { fresh, other, all } = offerable();
  const offered = fresh.length ? fresh : other.length ? other : all;
  const candidates = offered.map(candidate => ({
    ...candidate,
    shortlistSources: sourcesById.get(candidate.id) || [],
  }));
  return {
    candidates,
    sourceRuns,
    uniqueCandidates: candidates.length,
    elapsedMs: Math.round(performance.now() - started),
    spacingSkipped: fresh.length ? other.length - fresh.length : 0,
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
    avoidArtist: shortlistAvoidArtist(context),
    recentArtistRoots: context.scope.episodeSource ? undefined : context.recentArtistRoots,
    offers,
  });
  if (!context.transitionTarget) return result;
  return {
    ...result,
    candidates: orderByTransitionFit(result.candidates, context.transitionTarget, (candidate) => library.bpmKeyFor(candidate), offers),
  };
}

// How many sources journeyCompanions runs: what the Shortlist's default plan
// spends beside tracksTowardJourney on the same pick.
export const JOURNEY_COMPANION_PASSES = SHORTLIST_PASSES_DEFAULT - 1;

// The Shortlist's companions to a sonic journey, for the Agentic Leanings
// review (#1977). On a journey this plan pairs tracksTowardJourney with the
// show's context lane and the anchor's continuity lane. The Agentic model is
// told to call the journey tool and does, often several times, so its own
// candidate map holds the waypoint's neighbourhood and nothing else: the
// review could only weigh one lane, and never the show's tracks a host's
// Leanings point at. This runs the companions controller-side, through the
// same scope and planner, with no prepared searches (preparing those is a
// model call). Only tracks the artist guard would accept are returned, since
// a review replacement it refused would cost a corrective model call.
export async function journeyCompanions(
  context: Omit<ShortlistPlanningContext, 'discoveryPasses' | 'searches' | 'explore' | 'rotationSeed' | 'transitionTarget'>,
): Promise<{ candidates: PickerCandidate[]; sourceRuns: ShortlistSourceRun[] }> {
  if (!context.scope.audioWaypoint?.length) return { candidates: [], sourceRuns: [] };
  const { tools, seen } = buildPickerTools(context.scope);
  const sources = new Set(Object.keys(tools));
  sources.delete('tracksTowardJourney');
  // With no show moods the planner lets the station's own mood (weather, time
  // of day — always set on a live pick) stand in, ahead of the show's genres,
  // eras and energies. A journey fixes the plan's order, so that stand-in took
  // the context pass on every pick and the show's lane never ran. The review
  // needs the show's lane, so a show that places itself keeps its own.
  const energies = strings(context.energies).filter(value => ENERGY_VALUES.has(value));
  const genres = strings(context.genres?.length ? context.genres : context.scope.genreLock);
  const showPlaced = !!(context.scope.playlistTracks?.length || energies.length || genres.length
    || hasEraBound(context.eras ?? context.scope.eraLock ?? []));
  const dominantMood = showPlaced && !strings(context.moods).length ? null : context.dominantMood;
  const plan = planShortlistSources({ ...context, dominantMood, discoveryPasses: JOURNEY_COMPANION_PASSES }, sources);
  const { sourceRuns } = await executeShortlistPlan(tools as PickerToolSet, seen, plan);
  const maxPerArtist = context.scope.playlistLock || context.scope.episodeSource ? Infinity : 3;
  const { fresh } = withRecentSpacing(
    withoutArtist(balanceShortlist([...seen.values()], maxPerArtist), artistRootKey(shortlistAvoidArtist(context) || '')),
    context.scope.episodeSource ? undefined : context.recentArtistRoots,
  );
  return { candidates: fresh, sourceRuns };
}

// The pick-anchor artist guard rejects the anchor's artist after the model
// chooses it, at the cost of a second model call; offering the list without
// that artist avoids the call. Prepared episodes are exempt here as they are
// from the guard, since an artist episode is that artist by design.
export function shortlistAvoidArtist(context: Pick<ShortlistPlanningContext, 'scope' | 'currentArtist'>): string | null {
  return context.scope.episodeSource ? null : context.currentArtist || null;
}

// `other` is the balanced list minus every track sharing a credit with the
// pick-anchor artist, beside the unfiltered `all` for the never-starve case.
// The same overlap test the artist guard uses (artistCreditsOverlap over
// artistRootKey), so a track in `other` is one that guard would accept. Order
// is preserved; with no avoided artist, `other` is the whole list.
export function withoutArtist<T extends PickerCandidate>(candidates: T[], avoidRoot: string): { other: T[]; all: T[] } {
  if (!avoidRoot) return { other: candidates, all: candidates };
  const other = candidates.filter(candidate => !artistCreditsOverlap(artistRootKey(candidate), avoidRoot));
  return { other, all: candidates };
}

// The spacing half of the artist guard, applied before the model reads the
// list. The guard refuses a pick whose credit names an act in the window and
// re-picks from the run's other candidates (artist-guard.alternativeCandidates,
// the same creditInRoots test), so offering only those up front reaches the
// same outcome without the second model call — seen live at 3 re-picks in 17
// Shortlist picks. `fresh` is `other` minus the window; empty when the run found
// no other artist, in which case the guard's own "spacing yields" posture
// applies and the recent acts stay offered. An untagged track is never dropped.
export function withRecentSpacing<T extends PickerCandidate>(
  { other, all }: { other: T[]; all: T[] }, recentRoots?: ReadonlySet<string>,
): { fresh: T[]; other: T[]; all: T[] } {
  if (!recentRoots?.size) return { fresh: other, other, all };
  const fresh = other.filter(candidate => !artistRootKey(candidate) || !creditInRoots(candidate, recentRoots));
  return { fresh, other, all };
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
