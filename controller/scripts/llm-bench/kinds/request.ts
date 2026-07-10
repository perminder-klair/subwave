// Request kinds — the structured request matcher (query → search plan) and
// the tool-loop request agent (query → concrete track id + ack + intro).

import type { KindSpec } from './types.js';
import { matchRequest } from '../../../src/llm/dj.js';
import { djAgent } from '../../../src/llm/sdk.js';
import { requestSystem, requestSchema, requestAgent } from '../../../src/broadcast/dj-agent.js';
import { checkSpokenLine, checkAck } from '../rules.js';
import { pickerToolsSynthetic, requestMessages, CURRENT_TRACK } from '../fixtures.js';

const MOODS = new Set([
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual', 'focus', 'workout',
  'driving', 'cooking', 'rainy', 'sunny', 'night', 'morning', 'evening', 'festival', 'cultural',
]);

// Vibe words that must never leak into search_terms (they'd match nothing in
// a title/artist lookup — the schema routes them to `mood`).
const VIBE_WORDS = /calm|overcast|chill|mellow|cosy|cozy|moody|vibe|relax/i;

const agentDeadlineMs = () =>
  typeof (requestAgent as any).timeoutMs === 'function' ? (requestAgent as any).timeoutMs() : (requestAgent as any).timeoutMs;

function agentScenario(name: string, requestText: string, check: (out: any) => string[]) {
  return {
    name,
    run: async () => {
      const { tools, seen } = pickerToolsSynthetic();
      const result = await djAgent({
        system: requestSystem(),
        messages: requestMessages(requestText),
        tools,
        schema: requestSchema(),
        maxSteps: (requestAgent as any).maxSteps,
        timeoutMs: agentDeadlineMs(),
        kind: 'djAgentRequest',
      });
      return { object: result.object, seen };
    },
    check,
  };
}

export const specs: KindSpec[] = [
  {
    kind: 'matchRequest',
    group: 'request',
    mode: 'any',
    scenarios: [
      {
        name: 'artist-request',
        run: () => matchRequest('play some Sidhu Moose Wala', { listenerName: 'Meera', nowPlaying: CURRENT_TRACK }),
        check: (out: any) => {
          const v = checkAck(out?.ack);
          const artist = String(out?.artist || '').toLowerCase();
          const terms = (out?.search_terms || []).map((t: any) => String(t).toLowerCase());
          if (!artist.includes('sidhu') && !terms.some((t: string) => t.includes('sidhu'))) v.push('artist-missed');
          return v;
        },
      },
      {
        name: 'vibe-request',
        run: () => matchRequest('something calm for an overcast evening', { nowPlaying: CURRENT_TRACK }),
        check: (out: any) => {
          const v = checkAck(out?.ack);
          if (!out?.mood || !MOODS.has(String(out.mood))) v.push('mood-missed');
          const terms = (out?.search_terms || []).map((t: any) => String(t));
          if (terms.some((t: string) => VIBE_WORDS.test(t))) v.push('vibe-in-search-terms');
          return v;
        },
      },
      {
        name: 'title-request',
        run: () => matchRequest('can you play Hanju by Amrinder Gill?', { nowPlaying: CURRENT_TRACK }),
        check: (out: any) => {
          const v = checkAck(out?.ack);
          const terms = (out?.search_terms || []).map((t: any) => String(t).toLowerCase());
          if (!terms.some((t: string) => t.includes('hanju')) && !String(out?.artist || '').toLowerCase().includes('amrinder')) {
            v.push('title-missed');
          }
          return v;
        },
      },
    ],
  },
  {
    kind: 'djAgentRequest',
    group: 'request',
    mode: 'agent',
    scenarios: [
      agentScenario('exact-hit', 'play Cold Start by Sidhu Moose Wala', (out: any) => {
        const v: string[] = [];
        if (!out?.object?.id) v.push('missing-id');
        else if (!out.seen.has(out.object.id)) v.push('hallucinated-id');
        else {
          const picked = out.seen.get(out.object.id);
          if (picked?.title !== 'Cold Start') v.push('wrong-track');
        }
        v.push(...checkAck(out?.object?.ack), ...checkSpokenLine(out?.object?.intro));
        return v;
      }),
      agentScenario('fuzzy-hit', 'something moody for a night drive, your pick', (out: any) => {
        const v: string[] = [];
        if (!out?.object?.id) v.push('missing-id');
        else if (!out.seen.has(out.object.id)) v.push('hallucinated-id');
        v.push(...checkAck(out?.object?.ack), ...checkSpokenLine(out?.object?.intro));
        return v;
      }),
    ],
  },
];
