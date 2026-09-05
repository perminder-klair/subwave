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
//
// EACH branch states its own output rule, and no caller states one. A system
// prompt is written once and then runs down whichever branch the LEG resolves
// to (needsToolCallObject, per call), so an output-channel instruction written
// at the call site is right on one branch and wrong on another — issue #1536,
// where the tagger's "Return ONLY a JSON object" met the forced-tool branch and
// a 12B local model deadlocked choosing between them. Keep the rules here:
// EMIT_ANSWER_INSTRUCTION (tool), NATIVE_JSON_INSTRUCTION (native), and the
// recovery prompt's own line below.

import { generateText, Output } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, perfOf, warningsOf, failureDiagnostics, schemaHint } from '../core/pure.js';
import { needsToolCallObject, reasoningFor, samplingWithLocalKnobs } from '../provider/capabilities.js';
import { objectViaToolCall } from './object-via-tool.js';
import { resolveMaxOutputTokens } from '../../../settings.js';

// Operator-overridable via settings.llm.maxOutputTokens (issue #712); 0 keeps
// this default.
const MAX_TOKENS_OBJECT = 8000;

// The output rule for the NATIVE branch. Output.object forwards the schema as
// the provider's own structured-output mode, which is enforced by constrained
// decoding on the first-party providers — but `openrouter` and `gateway` hand
// response_format to whatever downstream model the id resolves to, and one that
// doesn't implement structured output simply ignores it and answers in prose.
// Until this PR the tagger's own "output ONLY a JSON object" was what carried
// those legs; removing it from the prompt without restating it here would have
// pushed every such call into the recovery attempt — a second billable call per
// batch, against settings.llm.dailyTokenCap, on a bulk job that runs per track.
//
// Deliberately a FORMAT rule, not a channel rule: it says what the result must
// look like and never where to put it. @ai-sdk/anthropic implements
// responseFormat:'json' by forcing a synthesized `json` tool, so a line here
// reading "reply with JSON, do not call a tool" would recreate #1536 on
// Anthropic — the exact conflict this change exists to remove. One line, no
// double quotes, same as EMIT_ANSWER_INSTRUCTION.
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
              // Appended to the PROMPT, not to `system` — same placement as the
              // recovery branch below, and it leaves the caller's system prompt
              // byte-identical (the tagger hashes its own into prompt_hash).
              prompt: `${prompt}\n\n${NATIVE_JSON_INSTRUCTION}`,
              temperature,
              maxOutputTokens,
              output: Output.object({ schema }),
              reasoning: reasoningFor(l.cfg),
              ...(signal ? { abortSignal: signal } : {}),
            }), signal);
            object = result.output;
            usage = usageOf(result);
            perf = perfOf(result);
            warnings = warningsOf(result);
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
