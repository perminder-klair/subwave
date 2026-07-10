// djText — free-text DJ generation (intros, links, idents, skill segments).
//
// Runs inside withFailover (primary→fallback on host-unreachable) with a
// transient-retry on the active leg. Resolves its model + sampling per leg, so a
// primary→fallback switch across different providers picks the right path.

import { generateText } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, truncationError, usageOf, failureDiagnostics } from '../core/pure.js';
import { providerOptions, repeatPenaltyApplies, samplingWithLocalKnobs } from '../provider/capabilities.js';
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
  // Optional caller-supplied abort signal. No live caller wraps djText in
  // withDeadline today, so this is inert unless one starts to — kept in the
  // shape as a precaution so a future deadline-wrapped call can cut the
  // Retry-After sleep short and prevent a ghost retry after the abort (mirrors
  // djAgent's threading, PR #751 review).
  signal = undefined,
}: any): Promise<string> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err) }),
    async (leg) => {
      const result = await withTransientRetry(kind, () => generateText({
        model: leg.model,
        instructions: system,
        prompt,
        temperature,
        topP,
        ...(seed != null ? { seed } : {}),
        maxOutputTokens,
        providerOptions: providerOptions(leg.cfg, { repeatPenalty }),
        ...(signal ? { abortSignal: signal } : {}),
      }), signal);
      // A free-text DJ script that hit the output-token cap is never a usable
      // reply — real scripts run ~150 tokens against the 4000-token backstop,
      // so 'length' means a reasoning model ran away mid-thought (issue #947:
      // it tied up the TTS GPU for minutes). Fail the call instead —
      // announce-path callers catch and skip the segment, so the station
      // stays on air, just without this talk break.
      const truncated = truncationError(result);
      if (truncated) throw truncated;
      const out = stripThinking(result.text);
      // Only record sampling knobs that actually reached the model — see
      // repeatPenaltyApplies() and providerOptions handling.
      const sampling: any = { temperature, top_p: topP, seed };
      if (repeatPenaltyApplies(leg.cfg)) sampling.repeat_penalty = repeatPenalty;
      samplingWithLocalKnobs(leg.cfg, sampling);
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
