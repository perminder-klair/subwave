// Random facts skill — LLM filler. One "did you know" sentence, lightly
// themed by the current time of day or season when it lands naturally.
// Always eligible; cooldown does the rate-limiting.

import { djText } from '../llm/sdk.js';
import { djSystem, buildContextLines, decoratePrompt } from '../llm/dj.js';

export default {
  name: 'random-facts',
  kind: 'random-facts',
  cooldownMs: 60 * 60 * 1000,

  shouldFire() {
    return true;
  },

  async script(ctx, _data, { recap, recentOpeners }) {
    const lines = buildContextLines(ctx);
    lines.push(`Task: one small "did you know" — concrete and oddly specific, not Wikipedia-rote. If a fact about ${ctx.date?.season || 'now'} or ${ctx.time?.period || 'this hour'} lands naturally, take it; otherwise drop a cold fact. One sentence. Never say "fun fact" or "interestingly".`);
    return djText({
      system: djSystem(),
      prompt: decoratePrompt(lines.join('\n'), { kind: 'random_facts', recap, recentOpeners }),
      temperature: 1.0,
      topP: 0.92,
      repeatPenalty: 1.3,
      kind: 'skill.random-facts',
    });
  },
};
