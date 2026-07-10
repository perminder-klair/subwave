// Free-text script kinds — intro, link, station ident, hourly time check.
// Pure rule-checking: these calls never fail structurally, they fail by
// breaking the spoken hard rules (tells, markup, digits, opener repeats).

import type { KindSpec } from './types.js';
import { generateIntro, generateLink, generateStationId, generateHourlyTime } from '../../../src/llm/dj.js';
import { checkSpokenLine } from '../rules.js';
import { benchContext, HOST, LIBRARY, RECENT_OPENERS, CURRENT_TRACK, PREVIOUS_TRACK } from '../fixtures.js';

export const specs: KindSpec[] = [
  {
    kind: 'generateIntro',
    group: 'scripts',
    mode: 'any',
    scenarios: [
      {
        name: 'normal',
        run: () => generateIntro({ track: LIBRARY[3], context: benchContext() }),
        check: (out: any) => checkSpokenLine(out),
      },
      {
        name: 'request-intro-with-openers',
        run: () => generateIntro({
          track: LIBRARY[3], context: benchContext(),
          requestedBy: 'Meera', requestText: 'something for the drive home',
          recentOpeners: RECENT_OPENERS,
        }),
        check: (out: any) => checkSpokenLine(out, { recentOpeners: RECENT_OPENERS }),
      },
    ],
  },
  {
    kind: 'generateLink',
    group: 'scripts',
    mode: 'any',
    scenarios: [
      {
        // clockIsAirTime:false — the model is told never to state the clock,
        // so a spoken HH:MM is a real failure (issue #864's class).
        name: 'normal',
        run: () => generateLink({ previous: PREVIOUS_TRACK, current: CURRENT_TRACK, context: benchContext(), persona: HOST }),
        check: (out: any) => checkSpokenLine(out, { noClock: true }),
      },
      {
        name: 'with-openers',
        run: () => generateLink({
          previous: PREVIOUS_TRACK, current: CURRENT_TRACK, context: benchContext(),
          persona: HOST, recentOpeners: RECENT_OPENERS,
        }),
        check: (out: any) => checkSpokenLine(out, { noClock: true, recentOpeners: RECENT_OPENERS }),
      },
    ],
  },
  {
    kind: 'generateStationId',
    group: 'scripts',
    mode: 'any',
    scenarios: [
      {
        name: 'normal',
        run: () => generateStationId({ context: benchContext(), persona: HOST }),
        check: (out: any) => checkSpokenLine(out),
      },
    ],
  },
  {
    kind: 'generateHourlyTime',
    group: 'scripts',
    mode: 'any',
    scenarios: [
      {
        name: 'afternoon',
        run: () => generateHourlyTime({ context: benchContext(), persona: HOST }),
        check: (out: any) => checkSpokenLine(out, { noDigits: true }),
      },
      {
        name: 'evening',
        run: () => generateHourlyTime({
          context: benchContext({
            clock: { hhmm: '21:05', isDark: true, isWeekend: false, isLateNight: false, isCommute: false },
            time: { period: 'evening', vibe: 'wind down' },
          }),
          persona: HOST,
        }),
        check: (out: any) => checkSpokenLine(out, { noDigits: true }),
      },
    ],
  },
];
