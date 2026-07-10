// Pick kinds — the pool picker (one djObject call over a candidate pool) and
// the tool-loop pick agent (picker-test.mjs's scenarios, ported).

import type { KindSpec } from './types.js';
import { pickNextTrack } from '../../../src/llm/dj.js';
import { djAgent } from '../../../src/llm/sdk.js';
import { pickSystem, pickSchema, pickerAgent } from '../../../src/broadcast/dj-agent.js';
import {
  benchContext, candidateSet, recentPlays, pickerToolsSynthetic,
  pickMessagesShort, pickMessagesLong, SHOW, TRANSITIONS, TRAP_ARTIST,
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

function agentScenario(name: string, messages: () => any[]) {
  return {
    name,
    run: async () => {
      const { tools, seen } = pickerToolsSynthetic();
      const result = await djAgent({
        system: pickSystem(),
        messages: messages(),
        tools,
        schema: pickSchema(),
        maxSteps: (pickerAgent as any).maxSteps,
        timeoutMs: agentDeadlineMs(),
        kind: 'djAgentPick',
      });
      return { object: result.object, toolCount: (result.toolCalls || []).length, seen };
    },
    check: (out: any) => {
      const v: string[] = [];
      if (!out?.object?.id) v.push('missing-id');
      else if (!out.seen.has(out.object.id)) v.push('hallucinated-id');
      if (out?.object?.transition != null && !TRANSITIONS.includes(out.object.transition)) v.push('invalid-transition');
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
];
