// Plain-text, schema-validated object output for callers that must support
// models with no tool interface. This deliberately avoids the SDK structured
// output helper because some adapters implement it as a synthetic tool call.

import { generateText } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, perfOf, warningsOf, failureDiagnostics, schemaHint } from '../core/pure.js';
import { reasoningFor, samplingWithLocalKnobs } from '../provider/capabilities.js';
import { resolveMaxOutputTokens } from '../../../settings.js';

const MAX_TOKENS_OBJECT = 8000;
const PLAIN_JSON_INSTRUCTION =
  'Respond with a single JSON object only — no prose, no markdown fences.';

export async function djPlainObject({
  system,
  prompt,
  schema,
  temperature = 0.4,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_OBJECT),
  kind = 'sdk.djPlainObject',
  leg = undefined,
  signal = undefined,
}: any): Promise<any> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err) }),
    async (l) => {
      let lastErr;
      let lastVia;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          lastVia = attempt === 1 ? 'ai-sdk:plain-json' : 'ai-sdk:plain-json-recovery';
          const hint = schemaHint(schema);
          const result = await withTransientRetry(kind, () => generateText({
            model: l.noThinkModel ?? l.model,
            instructions: system,
            prompt: `${prompt}\n\n${PLAIN_JSON_INSTRUCTION}`
              + (hint ? ` It MUST validate against this JSON Schema — every required key must be present:\n${hint}` : ''),
            temperature,
            maxOutputTokens,
            reasoning: reasoningFor(l.cfg, { forceNoThink: true }),
            ...(signal ? { abortSignal: signal } : {}),
          }), signal);
          let value;
          try {
            value = schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
          } catch (parseErr: any) {
            parseErr.text = result.text || '';
            parseErr.finishReason = result.finishReason;
            parseErr.usage = result.usage;
            throw parseErr;
          }
          return {
            value,
            via: lastVia,
            sampling: samplingWithLocalKnobs(l.cfg, { temperature }),
            usage: usageOf(result),
            perf: perfOf(result),
            warnings: warningsOf(result),
            extra: { system, user: prompt, response: JSON.stringify(value) },
          };
        } catch (err) {
          lastErr = err;
        }
      }
      (lastErr as any).__via = lastVia;
      throw lastErr;
    },
    leg,
  );
}
