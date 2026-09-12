// Native shortlist execution.
//
// This first seam deliberately accepts an explicit source plan. It lets us
// replay recorded vanilla picker calls through the exact existing source
// registry before we introduce a native source-planning policy of our own.
// Nothing here calls an LLM, chooses a track, or writes queue state.

import { buildPickerTools, type PickerScope } from '../llm/tools.js';

export type ShortlistSourceCall = {
  source: string;
  args: Record<string, unknown>;
};

export type ShortlistPlanningContext = {
  scope: PickerScope;
  // The current track remains a discovery seed, never a shortlist candidate.
  currentTrackId: string | null;
  discoveryPasses: number;
  // Resolved from the show snapshot by the eventual controller call site. The
  // scope carries strict locks; these soft values are only source arguments.
  moods?: string[] | null;
  energies?: string[] | null;
  // Mirrors the existing ε-greedy deep-cut nudge. Callers decide the random
  // draw once, outside this deterministic planner.
  explore?: boolean;
};

const ENERGY_VALUES = new Set(['low', 'medium', 'high']);

// A small stable hash spreads otherwise-identical picks across each lane
// without introducing mutable process state.  Current-track ids are already a
// natural rotation key: one station restart cannot reset the exploration mix,
// while a new track naturally gets a new starting point.
function stableIndex(value: string, size: number): number {
  if (size < 2) return 0;
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = ((hash * 31) + value.charCodeAt(i)) | 0;
  return Math.abs(hash) % size;
}

// Produce the native source plan from already-resolved station state.  Three
// lanes prevent a short budget repeatedly favouring the same familiar source:
//
//   1. Context: the active journey/show or its mood-and-energy brief.
//   2. Continuity: audio, semantic, or catalogue similarity to what is airing.
//   3. Exploration: deep cuts, recent additions, favourites, and a wildcard.
//
// Passes cycle through those lanes (context → continuity → exploration), then
// repeat for four and five passes.  Within a lane the stable rotation above
// varies the source chosen without sacrificing reproducibility.  Every source
// still comes from the existing registry, so its normal availability and hard
// guards apply unchanged.
export function planShortlistSources(
  context: ShortlistPlanningContext,
  availableSources: ReadonlySet<string>,
): ShortlistSourceCall[] {
  const budget = Math.max(1, Math.min(5, Math.floor(context.discoveryPasses) || 1));
  const source = (name: string, args: Record<string, unknown> = {}): ShortlistSourceCall | null => {
    return availableSources.has(name) ? { source: name, args } : null;
  };

  const mood = context.moods?.find((value): value is string => typeof value === 'string' && value.length > 0) ?? null;
  const energy = context.energies?.find((value): value is 'low' | 'medium' | 'high' => ENERGY_VALUES.has(value)) ?? null;

  const compact = (items: Array<ShortlistSourceCall | null>) => items.filter((item): item is ShortlistSourceCall => item !== null);
  const contextual = compact([
    // A strict playlist is the only source guaranteed to contribute an
    // in-set track, so it remains the entire context lane for that show.
    ...(context.scope.playlistLock && context.scope.playlistTracks?.length
      ? [source('showPlaylistTracks')]
      : [
          context.scope.audioWaypoint?.length ? source('tracksTowardJourney') : null,
          context.scope.playlistTracks?.length ? source('showPlaylistTracks') : null,
          mood ? source('tracksByMood', { mood, energy }) : energy ? source('tracksByEnergy', { energy }) : null,
        ]),
  ]);
  const continuity = context.currentTrackId ? compact([
    source('tracksThatSoundLikeThis', { songId: context.currentTrackId }),
    source('tracksLikeThis', { songId: context.currentTrackId }),
    source('similarSongs', { songId: context.currentTrackId }),
  ]) : [];
  // `explore` is the existing epsilon-greedy deep-cut nudge.  On that draw
  // the exploration lane is deliberately just deep cuts; ordinary picks make
  // the wider rotation available instead.
  const exploration = context.explore
    ? compact([source('deepCuts')])
    : compact([
        source('deepCuts'),
        source('recentlyAdded'),
        source('starredSongs'),
        source('randomSongs'),
      ]);
  const lanes = [contextual, continuity, exploration];
  if (!lanes.some((lane) => lane.length)) return [];

  const rotationKey = context.currentTrackId || [mood, energy, context.scope.playlistTracks?.length || 0].join(':');
  const laneRuns = [0, 0, 0];
  return Array.from({ length: budget }, (_, pass) => {
    // If a lane cannot be built in the current station state, use the next
    // available lane rather than wasting a discovery pass on an empty call.
    let laneIndex = pass % lanes.length;
    while (!lanes[laneIndex].length) laneIndex = (laneIndex + 1) % lanes.length;
    const lane = lanes[laneIndex];
    const occurrence = laneRuns[laneIndex]++;
    return lane[(stableIndex(`${rotationKey}:${laneIndex}`, lane.length) + occurrence) % lane.length];
  });
}

export type ShortlistSourceRun = ShortlistSourceCall & {
  status: 'ok' | 'unavailable' | 'invalid' | 'error';
  returned: number;
  accepted: number;
  elapsedMs: number;
  // A compact, non-prompt record for the paired-comparison report. Normal
  // shortlist telemetry continues to expose counts only.
  tracks?: Array<{ id: string; title: string; artist: string }>;
  error?: string;
};

export type ShortlistCandidate = any & { shortlistSources: string[] };

export type ShortlistResult = {
  candidates: ShortlistCandidate[];
  sourceRuns: ShortlistSourceRun[];
  uniqueCandidates: number;
  elapsedMs: number;
};

type ReplayToolCall = {
  name?: string;
  args: unknown;
  result: unknown;
  round?: number;
};

function resultTrackIds(result: unknown): string[] {
  const tracks = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { tracks?: unknown }).tracks)
      ? (result as { tracks: unknown[] }).tracks
      : [];
  return tracks
    .map((track: any) => track?.id)
    .filter((id): id is string => typeof id === 'string');
}

// The durable replay record deliberately contains only data required to rerun
// discovery: resolved guards, source calls, and stable candidate ids. It keeps
// prompts, model responses, credentials, and unrelated session history out of
// the fixture stream.
export function replayFixtureTrace({
  currentTrack,
  show,
  scope,
  toolCalls,
}: {
  currentTrack: any;
  show: any;
  scope: PickerScope;
  toolCalls: ReplayToolCall[];
}) {
  return {
    version: 1,
    currentTrack: currentTrack ? {
      id: currentTrack.id ?? null,
      title: currentTrack.title ?? null,
      artist: currentTrack.artist ?? null,
      album: currentTrack.album ?? null,
    } : null,
    show: show ? {
      id: show.id ?? null,
      name: show.name ?? null,
      genres: show.genres ?? [],
      moods: show.moods ?? [],
      energies: show.energies ?? [],
      eras: show.eras ?? [],
      filtersStrict: !!show.filtersStrict,
      playlistStrict: !!show.playlistStrict,
    } : null,
    scope: {
      recentIds: [...scope.recentIds].sort(),
      recentKeys: [...scope.recentKeys].sort(),
      hardRecentIds: [...scope.hardRecentIds].sort(),
      hardRecentKeys: [...scope.hardRecentKeys].sort(),
      genreLock: scope.genreLock,
      eraLock: scope.eraLock,
      moodLock: scope.moodLock,
      energyLock: scope.energyLock,
      vocalLock: scope.vocalLock,
      playlistLock: scope.playlistLock ? [...scope.playlistLock].sort() : null,
      playlistTrackIds: scope.playlistTracks?.map((track: any) => track?.id).filter(Boolean) ?? null,
      excludedIds: scope.excludedIds ? [...scope.excludedIds].sort() : null,
      audioWaypoint: scope.audioWaypoint,
    },
    sourceCalls: toolCalls
      .filter((call) => typeof call.name === 'string')
      .map((call) => ({
        source: call.name,
        args: call.args && typeof call.args === 'object' ? call.args : {},
        round: call.round ?? 1,
        candidateIds: resultTrackIds(call.result),
      })),
  };
}

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

function returnedTracks(result: unknown): Array<{ id: string; title: string; artist: string }> {
  const tracks = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { tracks?: unknown }).tracks)
      ? (result as { tracks: unknown[] }).tracks
      : [];
  return tracks.flatMap((track: any) => (
    typeof track?.id === 'string'
      ? [{ id: track.id, title: String(track.title || ''), artist: String(track.artist || '') }]
      : []
  ));
}

function resultError(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const error = (result as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : undefined;
}

// Execute an explicit source plan against a freshly-built picker registry.
// `seen` is the existing registry's authoritative, already-filtered and
// de-duplicated candidate accumulator; the size delta is therefore the exact
// number this source contributed to a vanilla agent run.
export async function executeShortlistPlan(
  tools: PickerToolSet,
  seen: Map<string, any>,
  plan: ShortlistSourceCall[],
): Promise<ShortlistResult> {
  const started = performance.now();
  const sourceRuns: ShortlistSourceRun[] = [];
  const sourcesById = new Map<string, string[]>();

  for (const call of plan) {
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
        tracks: returnedTracks(result),
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

  const candidates = [...seen.entries()].map(([id, candidate]) => ({
    ...candidate,
    shortlistSources: sourcesById.get(id) || [],
  }));
  return {
    candidates,
    sourceRuns,
    uniqueCandidates: candidates.length,
    elapsedMs: Math.round(performance.now() - started),
  };
}

// Replay entry point. Keeping it separate from executeShortlistPlan makes
// recorded vanilla runs transport-neutral and lets planner changes be measured
// without duplicating source execution semantics.
export async function replayShortlistPlan(scope: PickerScope, plan: ShortlistSourceCall[]): Promise<ShortlistResult> {
  const { tools, seen } = buildPickerTools(scope);
  return executeShortlistPlan(tools as PickerToolSet, seen, plan);
}

// Native entry point: build the same source-owned registry the agent used,
// plan only from sources it actually exposed, then reuse the shared filtered
// accumulator for execution. No LLM calls, choice, or queue writes occur here.
export async function buildShortlist(context: ShortlistPlanningContext): Promise<ShortlistResult> {
  const { tools, seen } = buildPickerTools(context.scope);
  const plan = planShortlistSources(context, new Set(Object.keys(tools)));
  return executeShortlistPlan(tools as PickerToolSet, seen, plan);
}
