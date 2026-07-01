// djText — free-text DJ generation (intros, links, idents, skill segments).
//
// Runs inside withFailover (primary→fallback on host-unreachable) with a
// transient-retry on the active leg. Resolves its model + sampling per leg, so a
// primary→fallback switch across different providers picks the right path.

import { generateText } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, usageOf, failureDiagnostics } from '../core/pure.js';
import { providerOptions, repeatPenaltyApplies, samplingWithNumCtx } from '../provider/capabilities.js';
import { resolveMaxOutputTokens } from '../../../settings.js';

// Hard output-token cap. A reasoning model with no cap can generate until it
// fills the whole context window — one runaway <think> ramble then ties up the
// inference slot for minutes. Generous backstop for normal output (idents are
// ~150 tokens); raise it if you turn `llm.reasoning` on and need room for the
// chain-of-thought. The operator can override via settings.llm.maxOutputTokens
// (issue #712); 0 there keeps this default.
const MAX_TOKENS_TEXT = 4000;

export async function djText({
  system,
  prompt,
  temperature = 0.9,
  topP = 0.95,
  repeatPenalty = 1.15,
  seed = null,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_TEXT),
  kind = 'sdk.djText',
}: any): Promise<string> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err) }),
    async (leg) => {
      const result = await withTransientRetry(kind, () => generateText({
        model: leg.model,
        system,
        prompt,
        temperature,
        topP,
        ...(seed != null ? { seed } : {}),
        maxOutputTokens,
        providerOptions: providerOptions(leg.cfg, { repeatPenalty }),
      }));
      const out = stripThinking(result.text);
      // Only record sampling knobs that actually reached the model — see
      // repeatPenaltyApplies() and providerOptions handling.
      const sampling: any = { temperature, top_p: topP, seed };
      if (repeatPenaltyApplies(leg.cfg)) sampling.repeat_penalty = repeatPenalty;
      samplingWithNumCtx(leg.cfg, sampling);
      return {
        value: out,
        via: 'ai-sdk',
        sampling,
        usage: usageOf(result),
        // Full, untruncated — the /debug surface shows the whole system prompt.
        extra: { system, user: prompt, response: out },
      };
    },
  );
}
