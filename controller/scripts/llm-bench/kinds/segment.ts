// Segment kinds — all Segment generation uses the one-call generateSegment
// runtime. Builders are the live ones from skills/_agent.ts.

import type { KindSpec } from './types.js';
import { djObject } from '../../../src/llm/sdk.js';
import {
  simpleSystem, simpleSegmentSchema, dataBlock, buildSituation, effectiveContextFields,
  forcedSystem, forcedSchema,
} from '../../../src/skills/_agent.js';
import { checkSpokenLine } from '../rules.js';
import {
  benchContext, HOST, SFX_CATALOG, weatherCap, newsCap,
  WEATHER_FRESH, WEATHER_DULL, NEWS_DATA,
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
];
