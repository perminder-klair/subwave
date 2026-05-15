// Traffic skill — LLM-generated filler, no real API. SUB/WAVE is a one-room
// radio station; the joke is that "traffic" is whatever's blocking the room
// (cat on the cable, slow kettle, the M6 still being the M6).
//
// Only eligible during commute windows so it doesn't appear at 3am.

import { djText } from '../llm/sdk.js';
import { djSystem, buildContextLines, decoratePrompt } from '../llm/dj.js';

export default {
  name: 'traffic',
  kind: 'traffic',
  cooldownMs: 90 * 60 * 1000,

  shouldFire(ctx) {
    return !!ctx.clock?.isCommute;
  },

  async script(ctx, _data, { recap, recentOpeners }) {
    const lines = buildContextLines(ctx);
    lines.push('Task: a tongue-in-cheek "traffic update for the SUB/WAVE listening area" — one sentence, absurd and small-scale (cat on the cable, queue at the kettle, slow buffering somewhere on the M6). Never a real road incident.');
    return djText({
      system: djSystem(),
      prompt: decoratePrompt(lines.join('\n'), { kind: 'traffic', recap, recentOpeners }),
      temperature: 1.0,
      topP: 0.92,
      repeatPenalty: 1.25,
      kind: 'skill.traffic',
    });
  },
};
