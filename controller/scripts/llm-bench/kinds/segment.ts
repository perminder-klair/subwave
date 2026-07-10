// Segment kinds — the pool-mode single-call path (generateSegment) and the
// tool-loop segment director (djAgentSegment), autonomous and forced variants.
// All builders are the live ones from skills/_agent.ts.

import type { KindSpec } from './types.js';
import { djObject } from '../../../src/llm/sdk.js';
import {
  simpleSystem, simpleSegmentSchema, dataBlock, buildSituation, effectiveContextFields,
  forcedSystem, forcedSchema, directorAgent, forcedDirectorAgent,
} from '../../../src/skills/_agent.js';
import { checkSpokenLine } from '../rules.js';
import {
  benchContext, HOST, SFX_CATALOG, weatherCap, newsCap,
  WEATHER_FRESH, WEATHER_DULL, NEWS_DATA, freshSegmentState,
} from '../fixtures.js';

const SFX_NAMES = new Set(SFX_CATALOG.map(s => s.name));

function checkSfx(sfx: any): string[] {
  return sfx != null && sfx !== '' && !SFX_NAMES.has(sfx) ? ['unknown-sfx'] : [];
}

// Autonomous simple-path shape: {reason, air, text, sfx}. Silence (air:false)
// is always a pass — the schema and prompt both bless it.
function checkSimple(out: any): string[] {
  if (!out?.air) return [];
  return [...checkSpokenLine(out.text), ...checkSfx(out.sfx)];
}

function simpleScenario(name: string, cap: any, data: any) {
  return {
    name,
    run: () => djObject({
      system: simpleSystem(HOST, cap, 'moderate', SFX_CATALOG),
      prompt: buildSituation(benchContext(), { contextFields: effectiveContextFields(cap) }) + dataBlock(data),
      schema: simpleSegmentSchema(),
      temperature: 0.9,
      kind: 'generateSegment',
    }),
    check: checkSimple,
  };
}

function directorScenario(name: string, caps: any[]) {
  return {
    name,
    run: async () => {
      const ctx = benchContext();
      const { object } = await directorAgent.run({
        messages: [{ role: 'user', content: buildSituation(ctx, {}) }],
        persona: HOST, caps, freq: 'moderate', sfxCatalog: SFX_CATALOG,
        ctx, segmentState: freshSegmentState(),
      });
      return { object, offered: caps.map(c => c.kind) };
    },
    check: (out: any) => {
      const seg = out?.object?.air ? out?.object?.segment : null;
      if (!seg) return []; // silence — a legitimate outcome for the autonomous tick
      const v: string[] = [];
      if (!out.offered.includes(seg.kind)) v.push('unoffered-kind');
      v.push(...checkSpokenLine(seg.text), ...checkSfx(seg.sfx));
      return v;
    },
  };
}

export const specs: KindSpec[] = [
  {
    kind: 'generateSegment',
    group: 'segment',
    mode: 'pool',
    scenarios: [
      simpleScenario('fresh-weather', weatherCap(WEATHER_FRESH), WEATHER_FRESH),
      simpleScenario('dull-weather', weatherCap(WEATHER_DULL), WEATHER_DULL),
      simpleScenario('news-payload', newsCap(), NEWS_DATA),
      {
        // Pool-mode forced run (operator/programme demanded a segment):
        // forcedSchema — text is mandatory, silence is not an option.
        name: 'forced-weather',
        run: () => djObject({
          system: forcedSystem(HOST, weatherCap(WEATHER_FRESH), SFX_CATALOG),
          prompt: buildSituation(benchContext(), { forced: true, contextFields: effectiveContextFields(weatherCap()) })
            + dataBlock(WEATHER_FRESH),
          schema: forcedSchema(),
          temperature: 0.9,
          kind: 'generateSegment',
        }),
        check: (out: any) => [...checkSpokenLine(out?.text), ...checkSfx(out?.sfx)],
      },
    ],
  },
  {
    kind: 'djAgentSegment',
    group: 'segment',
    mode: 'agent',
    scenarios: [
      directorScenario('autonomous-weather+news', [weatherCap(WEATHER_FRESH), newsCap()]),
      {
        name: 'forced-weather',
        run: async () => {
          const cap = weatherCap(WEATHER_FRESH);
          const ctx = benchContext();
          const { object } = await forcedDirectorAgent.run({
            messages: [{ role: 'user', content: buildSituation(ctx, { forced: true, contextFields: effectiveContextFields(cap) }) }],
            persona: HOST, cap, sfxCatalog: SFX_CATALOG,
            ctx, segmentState: freshSegmentState(),
          });
          return object;
        },
        check: (out: any) => [...checkSpokenLine(out?.text), ...checkSfx(out?.sfx)],
      },
    ],
  },
];
