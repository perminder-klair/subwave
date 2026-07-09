// Banter — one structured call writes a whole multi-voice exchange. Exactly
// where small models struggle: per-line speaker enums, line-count bounds, and
// staying conversational without stage directions.

import type { KindSpec } from './types.js';
import { generateBanter } from '../../../src/llm/dj.js';
import { checkSpokenLine } from '../rules.js';
import { benchContext, HOST, GUESTS, SHOW, CURRENT_TRACK } from '../fixtures.js';

export const specs: KindSpec[] = [
  {
    kind: 'generateBanter',
    group: 'banter',
    mode: 'any',
    scenarios: [
      {
        name: 'host+2-guests',
        run: () => generateBanter({
          host: HOST, guests: GUESTS, show: SHOW,
          current: CURRENT_TRACK, context: benchContext(),
        }),
        check: (lines: any) => {
          // generateBanter itself returns null for a monologue or a <2-line
          // exchange — that IS the failure we're measuring.
          if (!Array.isArray(lines) || !lines.length) return ['unusable-exchange'];
          const v: string[] = [];
          if (lines.length < 3 || lines.length > 6) v.push('line-count-out-of-bounds');
          const speakers = new Set(lines.map((l: any) => l?.persona?.id).filter(Boolean));
          if (speakers.size < 2) v.push('single-voice');
          for (const l of lines) v.push(...checkSpokenLine(l?.text, { maxSentences: 3 }));
          return v;
        },
      },
    ],
  },
];
