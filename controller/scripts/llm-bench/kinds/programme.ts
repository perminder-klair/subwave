// Programme kinds — the producer plan (structured), the three solo beat
// scripts (free text), and the multi-voice open/close exchanges.

import type { KindSpec } from './types.js';
import {
  generateProgrammePlan, generateProgrammeIntro, generateProgrammeOutro,
  generateProgrammeFeature, generateProgrammeExchange,
} from '../../../src/llm/dj.js';
import { checkSpokenLine } from '../rules.js';
import { benchContext, HOST, GUESTS, SHOW } from '../fixtures.js';

const SKILL_MENU = [
  { kind: 'weather', desc: 'A short weather check, in character.' },
  { kind: 'news', desc: 'One story from the feed worth a listener\'s attention.' },
];
const MENU_KINDS = new Set(SKILL_MENU.map(k => k.kind));

// A fixed plan so the beat scripts get realistic producer notes without
// depending on a live plan call earlier in the run.
const PLAN = {
  angle: 'Dusk slows things down — small confessions from the hard shoulder and the soundtracks that make lonely miles feel less lonely.',
  introNote: 'Open on the emptying motorway; tease the roadside-confessions feature.',
  outroNote: 'Call back to the confessions; hand the night over gently.',
  features: [{ topic: 'Roadside confessions — one true under-two-minute story from the hard shoulder.', kind: null }],
};

function checkPlan(spanHours: number) {
  return (out: any): string[] => {
    const v: string[] = [];
    const feats = out?.features;
    if (!Array.isArray(feats) || feats.length !== spanHours) v.push('feature-count-mismatch');
    for (const f of feats || []) {
      if (!String(f?.topic || '').trim()) v.push('empty-feature-topic');
      if (f?.kind != null && !MENU_KINDS.has(f.kind)) v.push('unoffered-feature-kind');
    }
    if (!String(out?.angle || '').trim()) v.push('empty-angle');
    return v;
  };
}

function checkExchange(lines: any): string[] {
  if (!Array.isArray(lines) || !lines.length) return ['unusable-exchange'];
  const v: string[] = [];
  if (lines.length < 2 || lines.length > 5) v.push('line-count-out-of-bounds');
  for (const l of lines) v.push(...checkSpokenLine(l?.text, { maxSentences: 3 }));
  return v;
}

export const specs: KindSpec[] = [
  {
    kind: 'generateProgrammePlan',
    group: 'programme',
    mode: 'any',
    scenarios: [
      {
        name: '2-hour-show',
        run: () => generateProgrammePlan({ show: SHOW, spanHours: 2, host: HOST, guests: GUESTS, context: benchContext(), skillKinds: SKILL_MENU }),
        check: checkPlan(2),
      },
      {
        name: '3-hour-show',
        run: () => generateProgrammePlan({ show: SHOW, spanHours: 3, host: HOST, guests: GUESTS, context: benchContext(), skillKinds: SKILL_MENU }),
        check: checkPlan(3),
      },
    ],
  },
  {
    kind: 'generateProgrammeIntro',
    group: 'programme',
    mode: 'any',
    scenarios: [{
      name: 'with-plan',
      run: () => generateProgrammeIntro({ show: SHOW, plan: PLAN, persona: HOST, context: benchContext() }),
      check: (out: any) => checkSpokenLine(out),
    }],
  },
  {
    kind: 'generateProgrammeOutro',
    group: 'programme',
    mode: 'any',
    scenarios: [{
      name: 'with-plan',
      run: () => generateProgrammeOutro({ show: SHOW, plan: PLAN, persona: HOST, context: benchContext(), nextShowName: 'Night Signal' }),
      check: (out: any) => checkSpokenLine(out),
    }],
  },
  {
    kind: 'generateProgrammeFeature',
    group: 'programme',
    mode: 'any',
    scenarios: [{
      name: 'with-plan',
      run: () => generateProgrammeFeature({ show: SHOW, topic: PLAN.features[0].topic, plan: PLAN, persona: HOST, context: benchContext() }),
      // Features run longer than links by design — a storytelling beat, so the
      // sentence ceiling is looser than the default spoken line.
      check: (out: any) => checkSpokenLine(out, { maxSentences: 10 }),
    }],
  },
  {
    kind: 'generateProgrammeExchange',
    group: 'programme',
    mode: 'any',
    scenarios: [
      {
        name: 'intro-beat',
        run: () => generateProgrammeExchange({ beat: 'intro', show: SHOW, plan: PLAN, host: HOST, guests: GUESTS, context: benchContext() }),
        check: checkExchange,
      },
      {
        name: 'outro-beat',
        run: () => generateProgrammeExchange({ beat: 'outro', show: SHOW, plan: PLAN, host: HOST, guests: GUESTS, context: benchContext(), nextShowName: 'Night Signal' }),
        check: checkExchange,
      },
    ],
  },
];
