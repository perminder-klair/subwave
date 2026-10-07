// Use native structured output or a forced tool, then recover via text parsing.
// Permanent model failures go directly to failover. Each branch owns its output
// instruction; callers must not impose a conflicting JSON/tool channel (#1536).

import { generateText, Output } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, perfOf, warningsOf, failureDiagnostics, schemaHint, isModelUnavailable, isGenerationControlError } from '../core/pure.js';
import { needsToolCallObject, reasoningFor, samplingWithLocalKnobs, googleSafetyOptions } from '../provider/capabilities.js';
import { objectViaToolCall } from './object-via-tool.js';
import { resolveMaxOutputTokens } from '../../../settings.js';

// Operator-overridable via settings.llm.maxOutputTokens (issue #712); 0 keeps
// this default.
const MAX_TOKENS_OBJECT = 8000;

// Native providers may ignore response_format. State the required format here
// without forbidding tool calls: Anthropic implements JSON with a synthesized tool (#1536).
export const NATIVE_JSON_INSTRUCTION =
  'The result must be a single JSON object matching the required shape — no prose, no markdown fences.';

export async function djObject({
  system,
  prompt,
  schema,
  temperature = 0.4,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_OBJECT),
  kind = 'sdk.djObject',
  leg = undefined,
  // Mutable controller-owned resolution objects may be supplied here. The
  // ring keeps their references, allowing a caller to settle a diagnostic
  // after downstream guards/enqueue without trusting the model's response.
  telemetry = {},
  // Includes the tighter simple-segment caller budget; never reset for failover.
  signal = undefined,
}: any): Promise<any> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err), ...telemetry }),
    async (l) => {
      let lastErr;
      // Log the actual branch on failure so /stats identifies the broken output path.
      let lastVia;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          let object;
          let usage;
          let perf;
          let warnings;
          if (attempt === 1 && needsToolCallObject(l.cfg)) {
            lastVia = 'ai-sdk:tool';
            ({ object, usage, perf, warnings } = await withTransientRetry(kind,
              () => objectViaToolCall(l, { system, prompt, schema, temperature, maxOutputTokens, signal }), signal));
          } else if (attempt === 1) {
            lastVia = 'ai-sdk';
            const result = await withTransientRetry(kind, () => generateText({
              model: l.model,
              instructions: system,
              // Append to prompt to preserve the caller's system prompt hash.
              prompt: `${prompt}\n\n${NATIVE_JSON_INSTRUCTION}`,
              temperature,
              maxOutputTokens,
              output: Output.object({ schema }),
              reasoning: reasoningFor(l.cfg),
              ...googleSafetyOptions(l.cfg),
              ...(signal ? { abortSignal: signal } : {}),
            }), signal);
            object = result.output;
            usage = usageOf(result);
            perf = perfOf(result);
            warnings = warningsOf(result);
          } else {
            lastVia = 'ai-sdk:recovery';
            // Text recovery has no schema channel; include schemaHint and suppress reasoning.
            const hint = schemaHint(schema);
            const result = await withTransientRetry(kind, () => generateText({
              model: l.noThinkModel ?? l.model,
              instructions: system,
              prompt: `${prompt}\n\nRespond with a single JSON object only — no prose, no markdown fences.`
                + (hint ? ` It MUST validate against this JSON Schema — every required key must be present:\n${hint}` : ''),
              temperature,
              maxOutputTokens,
              reasoning: reasoningFor(l.cfg, { forceNoThink: true }),
              ...googleSafetyOptions(l.cfg),
              ...(signal ? { abortSignal: signal } : {}),
            }), signal);
            try {
              object = schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
            } catch (parseErr: any) {
              // Include raw output on parse failures for diagnosis.
              parseErr.text = result.text || '';
              parseErr.finishReason = result.finishReason;
              parseErr.usage = result.usage;
              throw parseErr;
            }
            usage = usageOf(result);
            perf = perfOf(result);
            warnings = warningsOf(result);
          }
          return {
            value: object,
            via: lastVia,
            sampling: samplingWithLocalKnobs(l.cfg, { temperature }),
            usage,
            perf,
            warnings,
            // Keep /debug output complete; durable events still apply cap().
            extra: { system, user: prompt, response: JSON.stringify(object), ...telemetry },
          };
        } catch (err) {
          if (isGenerationControlError(err)) {
            (err as any).__via = lastVia;
            throw err;
          }
          lastErr = err;
          // Changing the output format cannot recover a retired/missing model.
          // Keep the common failure attribution before handing it to failover.
          if (isModelUnavailable(err)) break;
        }
      }
      // Record the last branch, then let withFailover decide whether the backup can help.
      (lastErr as any).__via = lastVia;
      throw lastErr;
    },
    leg,
    signal,
  );
}
