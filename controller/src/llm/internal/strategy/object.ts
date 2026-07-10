// djObject — schema-validated structured output. `schema` is a Zod object
// schema; the returned value is parsed and validated.
//
// Two attempts, because small/cloud models occasionally botch structured output
// (the AI SDK throws NoObjectGeneratedError — "could not parse the response"):
//   1. native    — Output.object, which forwards the schema to the provider's
//                   structured-output mode (constrained decoding where it's
//                   supported). Ollama instead takes the forced-tool path
//                   (objectViaToolCall) — it ignores JSON mode.
//   2. recovery  — plain free-text, then strip <think> blocks / ``` fences and
//                   Zod-validate ourselves. Catches models that wrap the JSON
//                   in reasoning the native parser chokes on.
// Throws only if BOTH attempts fail.

import { generateText, Output } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, failureDiagnostics, schemaHint } from '../core/pure.js';
import { needsToolCallObject, reasoningFor, samplingWithLocalKnobs } from '../provider/capabilities.js';
import { objectViaToolCall } from './object-via-tool.js';
import { resolveMaxOutputTokens } from '../../../settings.js';

// Operator-overridable via settings.llm.maxOutputTokens (issue #712); 0 keeps
// this default.
const MAX_TOKENS_OBJECT = 8000;

export async function djObject({
  system,
  prompt,
  schema,
  temperature = 0.4,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_OBJECT),
  kind = 'sdk.djObject',
  leg = undefined,
  // Optional caller-supplied abort signal. No live caller wraps djObject in
  // withDeadline today, so this is inert unless one starts to — kept in the
  // shape as a precaution so a future deadline-wrapped call can cut the
  // Retry-After sleep short and prevent a ghost retry after the abort (mirrors
  // djAgent's threading, PR #751 review).
  signal = undefined,
}: any): Promise<any> {
  return withFailover(
    kind,
    (err) => ({ user: prompt, ...failureDiagnostics(err) }),
    async (l) => {
      let lastErr;
      // Track the strategy actually attempted so a failure record attributes to
      // the right sub-path — bucketing every failure as 'ai-sdk' hides which
      // structured-output branch is breaking in /stats.
      let lastVia;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          let object;
          let usage;
          if (attempt === 1 && needsToolCallObject(l.cfg)) {
            lastVia = 'ai-sdk:tool';
            ({ object, usage } = await withTransientRetry(kind,
              () => objectViaToolCall(l, { system, prompt, schema, temperature, maxOutputTokens, signal }), signal));
          } else if (attempt === 1) {
            lastVia = 'ai-sdk';
            const result = await withTransientRetry(kind, () => generateText({
              model: l.model,
              instructions: system,
              prompt,
              temperature,
              maxOutputTokens,
              output: Output.object({ schema }),
              reasoning: reasoningFor(l.cfg),
              ...(signal ? { abortSignal: signal } : {}),
            }), signal);
            object = result.output;
            usage = usageOf(result);
          } else {
            lastVia = 'ai-sdk:recovery';
            // Self-describing retry: the native/tool attempt above conveys the
            // schema to the model via a real provider channel (response_format
            // or a forced tool's inputSchema) — this plain generateText call has
            // neither, so without restating the shape here the model is guessing
            // required keys from whatever the caller's own prose happens to
            // mention (observed: GLM dropping `reason`/`say` entirely — see
            // schemaHint's comment). Also route through the no-think model +
            // forced suppression, same as every other structured-output leg
            // (objectViaToolCall, djAgent's done-tool path) — this was the one
            // branch still using the operator's raw reasoning-on model instance.
            const hint = schemaHint(schema);
            const result = await withTransientRetry(kind, () => generateText({
              model: l.noThinkModel ?? l.model,
              instructions: system,
              prompt: `${prompt}\n\nRespond with a single JSON object only — no prose, no markdown fences.`
                + (hint ? ` It MUST validate against this JSON Schema — every required key must be present:\n${hint}` : ''),
              temperature,
              maxOutputTokens,
              reasoning: reasoningFor(l.cfg, { forceNoThink: true }),
              ...(signal ? { abortSignal: signal } : {}),
            }), signal);
            try {
              object = schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
            } catch (parseErr: any) {
              // Surface the raw output on a shape/parse miss, mirroring the
              // done-tool agent's diagnostics — without this a recovery-path
              // failure carried no evidence of what the model actually
              // produced, only the Zod/JSON error.
              parseErr.text = result.text || '';
              parseErr.finishReason = result.finishReason;
              parseErr.usage = result.usage;
              throw parseErr;
            }
            usage = usageOf(result);
          }
          return {
            value: object,
            via: lastVia,
            sampling: samplingWithLocalKnobs(l.cfg, { temperature }),
            usage,
            // Full, untruncated — the /debug surface shows the whole call, and
            // the ring buffer holds only 120 entries so size isn't a concern.
            // (A .slice(0, 500) here used to cut pick reasons mid-sentence in
            // /admin/debug; the durable events.jsonl still caps via cap().)
            extra: { system, user: prompt, response: JSON.stringify(object) },
          };
        } catch (err) {
          lastErr = err;
        }
      }
      // Attribute the failure to the last sub-path tried, then let withFailover
      // decide whether the error is host-unreachable (→ try the backup leg) or
      // a model/parse failure (→ surface it).
      (lastErr as any).__via = lastVia;
      throw lastErr;
    },
    leg,
  );
}
