// Weather skill — fires only when the observed condition changes from the
// last time the DJ talked about weather. ctx.weather is populated by
// context.getFullContext(); this skill doesn't fetch its own weather.
//
// Replaces the old scheduler.maybeWeatherUpdate handler. ctx.weather stays
// in the shared context so picker.js, dj.buildContextLines, and the
// festival > weather > time mood priority keep working untouched.

import { djText } from '../llm/sdk.js';
import { djSystem, buildContextLines, decoratePrompt } from '../llm/dj.js';

export default {
  name: 'weather',
  kind: 'weather',
  cooldownMs: 25 * 60 * 1000,

  shouldFire(ctx, state) {
    const c = ctx.weather?.condition;
    if (!c || c === 'unknown') return false;
    return c !== state.lastCondition;
  },

  async script(ctx, _data, { recap, recentOpeners, state }) {
    state.lastCondition = ctx.weather.condition;
    const lines = buildContextLines(ctx);
    lines.push('Task: a brief weather check, in character. 1-2 sentences.');
    return djText({
      system: djSystem(),
      prompt: decoratePrompt(lines.join('\n'), { kind: 'weather', recap, recentOpeners }),
      temperature: 0.9,
      topP: 0.95,
      repeatPenalty: 1.15,
      kind: 'skill.weather',
    });
  },
};
