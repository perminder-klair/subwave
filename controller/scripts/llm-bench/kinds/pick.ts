// Pick kinds — the pool picker (one djObject call over a candidate pool), the
// tool-loop pick agent (picker-test.mjs's scenarios, ported) and the Track
// Shortlist (a controller-run source plan, then one bounded djObject choice).

import type { KindSpec } from './types.js';
import { pickNextTrack } from '../../../src/llm/dj.js';
import { djAgent, nearestId } from '../../../src/llm/sdk.js';
import { pickerScope } from '../../../src/llm/tools.js';
import * as settings from '../../../src/settings.js';
import { pickerAgent } from '../../../src/broadcast/dj-agent.js';
import { agenticDiscoverySchema, pickSystem } from '../../../src/broadcast/dj-agent/schemas.js';
import { MUSICAL_REASON_UNAVAILABLE } from '../../../src/broadcast/dj-agent/leanings-review.js';
import {
  djPick, shortlistClauseSelectionReason, shortlistSituation, type ShortlistSelectionContext,
} from '../../../src/broadcast/dj-agent/shortlist-pick.js';
import {
  balanceShortlist, executeShortlistPlan, planShortlistSources, type ShortlistCandidate, type ShortlistSourceCall,
} from '../../../src/music/shortlist.js';
import {
  benchContext, candidateSet, recentPlays, pickerToolsSynthetic,
  pickMessagesShort, pickMessagesLong, SHOW, TRANSITIONS, TRAP_ARTIST, CURRENT_TRACK,
} from '../fixtures.js';

function checkPoolPick(out: any, candidates: any[]): string[] {
  const v: string[] = [];
  const byId = new Map(candidates.map(c => [c.id, c]));
  if (!out?.id) v.push('missing-id');
  else if (!byId.has(out.id)) v.push('hallucinated-id');
  if (out?.transition != null && !TRANSITIONS.includes(out.transition)) v.push('invalid-transition');
  return v;
}

function poolScenario(name: string, shape: Parameters<typeof candidateSet>[0], extraCheck?: (out: any, candidates: any[]) => string[]) {
  const candidates = candidateSet(shape);
  // The on-air anchor the live call site (pickViaPool) passes — analysed, so
  // the FLOW tempo/key matching has something real to work against.
  const current = { title: 'Hanju', artist: 'Amrinder Gill', bpm: 92, key: '8A', pace: 0.42 };
  return {
    name,
    run: () => pickNextTrack({ candidates, recentPlays: recentPlays(), context: benchContext(), show: SHOW, current }),
    check: (out: any) => [...checkPoolPick(out, candidates), ...(extraCheck ? extraCheck(out, candidates) : [])],
  };
}

const agentDeadlineMs = () =>
  typeof (pickerAgent as any).timeoutMs === 'function' ? (pickerAgent as any).timeoutMs() : (pickerAgent as any).timeoutMs;

// An id outside the offered set, split by whether the live call site's free
// near-miss repair (nearestId) would have saved it. Both routes repair and
// then re-pick before giving up, so 'near-miss-id' is a slip the station
// survives and 'hallucinated-id' is one that costs a corrective model call.
function idViolation(id: unknown, offered: Iterable<string>): string | null {
  if (!id) return 'missing-id';
  const ids = new Set(offered);
  if (ids.has(String(id))) return null;
  return nearestId(String(id), ids) ? 'near-miss-id' : 'hallucinated-id';
}

// Mirrors pickerAgent (dj-agent/agents.ts) — its system, discovery schema,
// per-provider discovery budget and native-path acceptance — over the
// synthetic tools, since the live agent's buildTools reads the real library.
function agentScenario(name: string, messages: () => any[]) {
  return {
    name,
    run: async () => {
      const { tools, seen } = pickerToolsSynthetic();
      const result = await djAgent({
        system: pickSystem(null, false, false, { host: null, guest: null, promptValue: null }),
        messages: messages(),
        tools,
        schema: agenticDiscoverySchema(),
        maxSteps: (pickerAgent as any).maxSteps,
        timeoutMs: agentDeadlineMs(),
        kind: 'djAgentPick',
        providerDiscoveryBudget: true,
        validate: (object: any) => !!(object?.id && seen.has(object.id)),
      });
      return { object: result.object, toolCount: (result.toolCalls || []).length, seen };
    },
    check: (out: any) => {
      const v: string[] = [];
      const idV = idViolation(out?.object?.id, out?.seen?.keys?.() ?? []);
      if (idV) v.push(idV);
      if (out?.object?.transition != null && !TRANSITIONS.includes(out.object.transition)) v.push('invalid-transition');
      return v;
    },
  };
}

// --- Track Shortlist ---------------------------------------------------------

const CURRENT_ID = 'bench-current-hanju';
const CURRENT = { id: CURRENT_ID, ...CURRENT_TRACK, bpm: 92, key: '8A', pace: 0.42 };
const CAMELOT_RING = ['8A', '9A', '7A', '8B', '10A', '6A', '9B', '11A'];

// The synthetic tools hand back bare library rows; the live registry's slim
// projection also carries tags and analysis, so give each one a deterministic
// set for the model to read.
function enrich(candidate: ShortlistCandidate, i: number): ShortlistCandidate {
  return {
    ...candidate,
    moods: i % 3 === 2 ? ['night'] : ['driving'],
    energy: ['medium', 'high', 'low'][i % 3],
    bpm: 84 + (i * 7) % 40,
    key: CAMELOT_RING[i % CAMELOT_RING.length],
    duration_sec: 170 + (i * 23) % 120,
    play_count: i % 4,
    last_played_days_ago: i % 4 ? 3 + i : undefined,
  };
}

// The selection context pickViaSelectionRoute builds for a Shortlist pick, in
// its order: predecessor, journey, link, transitions (effects only), then
// shortlistSignals and shortlistSituation.
function shortlistContext(extra: Partial<ShortlistSelectionContext> = {}): ShortlistSelectionContext {
  return {
    currentTrack: CURRENT,
    journeyActive: false,
    link: 'No link airs for this pick.',
    ...(settings.effectsActive() ? { recentTransitions: ['washout', 'normal', 'washout'] } : {}),
    recentPlays: recentPlays(),
    ...extra,
    ...shortlistSituation(benchContext()),
  };
}

// The live pipeline over the synthetic tools: buildShortlist's plan, top-ups,
// minimum and artist cap, then djPick. A fixed rotation seed keeps the offered
// set identical across models (the live pick draws a fresh one).
async function plannedShortlist(passes: number) {
  const { tools, seen } = pickerToolsSynthetic();
  const plan = planShortlistSources({
    scope: pickerScope(),
    currentTrackId: CURRENT_ID,
    discoveryPasses: passes,
    moods: SHOW.moods,
    dominantMood: 'driving',
    rotationSeed: 0,
  }, new Set(Object.keys(tools)));
  const topUps: ShortlistSourceCall[] = ['starredSongs', 'randomSongs']
    .filter(source => source in tools)
    .map(source => ({ source, args: {}, family: 'diversity' }));
  const result = await executeShortlistPlan(tools, seen, plan, { topUps, minimumCandidates: 4, maxPerArtist: 3 });
  return { candidates: result.candidates.map(enrich), sourceRuns: result.sourceRuns };
}

// A fixed candidate set, put through the same three-per-artist cap
// buildShortlist applies outside strict playlists and episodes — so the trap
// offers the model three of the over-played artist and one way out, which is
// the most pressure a live Shortlist can apply.
function fixedShortlist(shape: Parameters<typeof candidateSet>[0]) {
  const offered = candidateSet(shape).map((c: any) => ({ ...c, shortlistSources: [c.source] })) as ShortlistCandidate[];
  return { candidates: balanceShortlist(offered, 3), sourceRuns: [] };
}

function shortlistScenario(
  name: string,
  build: () => Promise<{ candidates: ShortlistCandidate[]; sourceRuns: any[] }> | { candidates: ShortlistCandidate[]; sourceRuns: any[] },
  extra: Partial<ShortlistSelectionContext> = {},
  extraCheck?: (pick: any, candidates: ShortlistCandidate[]) => string[],
) {
  return {
    name,
    run: async () => {
      const { candidates, sourceRuns } = await build();
      const pick = await djPick({ candidates, playlistResolved: false, sourceRuns, context: shortlistContext(extra) });
      return { pick, candidateIds: candidates.map(c => c.id), candidates };
    },
    check: (out: any) => {
      const v: string[] = [];
      const pick = out?.pick;
      const idV = idViolation(pick?.id, out?.candidateIds ?? []);
      if (idV) v.push(idV);
      if (pick?.transition != null && !TRANSITIONS.includes(pick.transition)) v.push('invalid-transition');
      // The Booth reason. 'reason-unavailable': the model omitted or broke
      // musicalReason and the schema's fallback filled it. 'reason-rejected':
      // it wrote one, but the controller's safety check (names the track,
      // backstage words, first person, queue talk) replaced it.
      const track = (out?.candidates ?? []).find((c: any) => c.id === pick?.id);
      if (pick?.musicalReason === MUSICAL_REASON_UNAVAILABLE) v.push('reason-unavailable');
      else if (track && pick?.selectionReason === shortlistClauseSelectionReason(track, null)) v.push('reason-rejected');
      if (extraCheck && track) v.push(...extraCheck(pick, out.candidates));
      return v;
    },
  };
}

export const specs: KindSpec[] = [
  {
    kind: 'pickNextTrack',
    group: 'pick',
    mode: 'pool',
    scenarios: [
      poolScenario('baseline-10', 'baseline'),
      poolScenario('analysed-candidates', 'analysed'),
      poolScenario('same-artist-trap', 'same-artist-trap', (out, candidates) => {
        const picked = candidates.find(c => c.id === out?.id);
        // The VARIETY criterion under pressure: the trap artist just played
        // twice and fills 9 of 10 slots. Editorial signal, not a crash.
        return picked && picked.artist === TRAP_ARTIST ? ['variety:same-artist'] : [];
      }),
      poolScenario('big-pool-18', 'big'),
    ],
  },
  {
    kind: 'djAgentPick',
    group: 'pick',
    mode: 'agent',
    scenarios: [
      agentScenario('short-context', pickMessagesShort),
      agentScenario('long-context', pickMessagesLong),
    ],
  },
  {
    kind: 'djShortlistPick',
    group: 'pick',
    mode: 'shortlist',
    scenarios: [
      shortlistScenario('planned-3-pass', () => plannedShortlist(3)),
      shortlistScenario('planned-5-pass', () => plannedShortlist(5)),
      shortlistScenario('analysed-mix-run', () => fixedShortlist('analysed'), { mixRun: { bpm: 92, key: '8A' } }),
      shortlistScenario('same-artist-trap', () => fixedShortlist('same-artist-trap'), {}, (pick, candidates) => {
        const picked = candidates.find(c => c.id === pick?.id);
        return picked && picked.artist === TRAP_ARTIST ? ['variety:same-artist'] : [];
      }),
    ],
  },
];
