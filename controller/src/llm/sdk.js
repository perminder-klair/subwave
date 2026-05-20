// AI SDK wrapper — the single chokepoint for every LLM call in the controller.
//
// Two primitives:
//   djText   — free-text generation (DJ intros, links, idents, skill segments)
//   djObject — schema-validated structured output (request matching, picker)
//
// Both resolve their model through llm/provider.js, so switching providers in
// Settings reroutes every call with no change here or at the call sites.

import { generateText, Output, stepCountIs, ToolLoopAgent, tool } from 'ai';
import { languageModel, activeModelLabel, providerName } from './provider.js';
import { record } from './log.js';
import * as settings from '../settings.js';

// Hard output-token caps. A reasoning model with no cap can generate until it
// fills the whole context window — one runaway <think> ramble then ties up the
// inference slot for minutes. These are generous backstops for normal output
// (idents are ~150 tokens, structured picks ~250); raise them if you turn
// `llm.reasoning` on and need room for the chain-of-thought.
const MAX_TOKENS_TEXT   = 800;
const MAX_TOKENS_OBJECT = 1000;
const MAX_TOKENS_AGENT  = 1200;

// Some models (Qwen 3, DeepSeek R1, etc.) emit a <think>…</think> reasoning
// block before the answer. Reasoning is suppressed at the provider layer when
// `llm.reasoning` is off (llm/provider.js no-think fetch + the Ollama `think`
// flag below); we still strip any leftover tags defensively here.
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const DANGLING_THINK_RE = /^[\s\S]*?<\/think>\s*/i;

function stripThinking(s) {
  if (!s) return s;
  return s.replace(THINK_TAG_RE, '').replace(DANGLING_THINK_RE, '').trim();
}

// Pull a JSON object out of a free-text reply: drop ```json fences and any
// prose around it, then take the outermost { … }. Used by djObject's recovery
// path when native structured output fails to parse.
function extractJson(s) {
  if (!s) throw new Error('empty model response');
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in model response');
  return t.slice(start, end + 1);
}

// Normalise the AI SDK usage block into { input, output, total }. Providers
// vary in which fields they populate (and a local Ollama box often omits them
// entirely — token stats then read as 0 for that call). `totalUsage` is the
// agent-loop sum across steps; prefer it when present.
function usageOf(result) {
  const u = result?.totalUsage || result?.usage || {};
  const input = u.inputTokens ?? u.promptTokens ?? 0;
  const output = u.outputTokens ?? u.completionTokens ?? 0;
  const total = u.totalTokens ?? (input + output);
  return { input, output, total };
}

// `repeat_penalty` is Ollama-specific and lives under providerOptions.ollama;
// non-Ollama providers ignore the block entirely, so it's safe to always pass.
function ollamaOptions(repeatPenalty) {
  // `think` follows the llm.reasoning setting — false suppresses the
  // <think> block on reasoning models served through Ollama.
  const opts = { think: settings.get().llm?.reasoning === true };
  if (repeatPenalty != null) opts.options = { repeat_penalty: repeatPenalty };
  return { ollama: opts };
}

// True when the active provider needs the tool-call structured-output path.
// Ollama-served models — local and especially the `:cloud` ones — ignore
// JSON-schema constrained decoding (Ollama's `format` field) and just emit
// prose, so Output.object throws NoObjectGeneratedError. Their tool-calling,
// however, works: see objectViaToolCall.
function needsToolCallObject() {
  return providerName() === 'ollama';
}

// True when repeat_penalty actually reaches the model. It's bundled inside
// providerOptions.ollama, so only the Ollama provider reads it — every other
// provider (openai-compatible, openai, anthropic, …) silently drops it. The
// sampling log uses this to avoid claiming the value was applied when it
// wasn't. If a future provider gains a real repetition-penalty channel, widen
// this check and pipe the value through ollamaOptions's equivalent there.
function repeatPenaltyApplies() {
  return providerName() === 'ollama';
}

// Centralised success/failure record writers. Every LLM call goes through one
// of each. The required-shape args (kind/started/via/sampling/usage for
// success, kind/started/via/error for failure) are explicit so a new primitive
// can't silently lack a field — the `usage: undefined` drift in the Ollama
// tool-call branch was the kind of bug this prevents. Per-primitive payload
// (system, messages, toolCalls, response, user, …) goes in `extra`.
function recordSuccess({ kind, started, via, sampling, usage, extra = {} }) {
  record({
    kind,
    ok: true,
    ms: Date.now() - started,
    model: activeModelLabel(),
    via,
    sampling,
    usage,
    t: new Date().toISOString(),
    ...extra,
  });
}

function recordFailure({ kind, started, via, error, extra = {} }) {
  record({
    kind,
    ok: false,
    ms: Date.now() - started,
    model: activeModelLabel(),
    via,
    error,
    t: new Date().toISOString(),
    ...extra,
  });
}

// Pull diagnostic info off an AI SDK structured-output error. When the model
// emits something but the SDK can't parse it into the schema, the raw text
// lives on err.text (and the original cause on err.cause). Without this, the
// failure record only carries err.message — useless for "WHY didn't it parse?"
// triage. Best-effort: every field is optional, missing ones are skipped.
function failureDiagnostics(err) {
  const out = {};
  if (typeof err?.text === 'string') out.responseText = err.text;
  if (err?.finishReason) out.finishReason = err.finishReason;
  if (err?.usage) out.usage = usageOf({ usage: err.usage });
  if (err?.cause?.message && err.cause.message !== err.message) {
    out.causeMessage = err.cause.message;
  }
  // The agent loop's partial steps before the final-output failure — same
  // shape as the success-path toolCalls flatten.
  const steps = err?.response?.steps || err?.steps;
  if (Array.isArray(steps) && steps.length) {
    out.toolCalls = steps.flatMap((s) => {
      const results = s.toolResults || [];
      return (s.toolCalls || []).map((c, i) => ({
        name: c.toolName,
        args: c.input ?? c.args ?? null,
        result: results[i]?.output ?? results[i]?.result ?? null,
      }));
    });
    out.steps = steps.length;
  }
  return out;
}

// Tee a one-line preview of the failed model output to the console so failures
// are visible in `docker logs` without grepping /debug JSON. Truncated to avoid
// dumping multi-kilobyte reasoning blocks into the terminal.
function logFailurePreview(kind, err) {
  if (typeof err?.text !== 'string' || !err.text.trim()) return;
  const preview = err.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  console.log(`[${kind}] raw model output (truncated): ${preview}`);
}

// Structured output via a forced tool call. The result schema is presented as
// an `emit` tool the model MUST call (toolChoice:'required'); we capture and
// Zod-validate its input. This is the reliable structured-output path for
// models that ignore JSON mode but handle tool calls fine. Single step — the
// model's only legal move is to call `emit` once. Returns the validated object
// plus a token-usage block so callers can log it alongside the other branches.
async function objectViaToolCall({ system, prompt, messages, schema, temperature, maxOutputTokens }) {
  let captured;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input) => { captured = input; return 'received'; },
  });
  const result = await generateText({
    model: languageModel(),
    system,
    ...(messages ? { messages } : { prompt }),
    temperature,
    maxOutputTokens,
    tools: { emit },
    toolChoice: 'required',
    stopWhen: stepCountIs(1),
    providerOptions: ollamaOptions(null),
  });
  if (captured === undefined) throw new Error('model never called the emit tool');
  return { object: schema.parse(captured), usage: usageOf(result) };
}

// Free-text DJ generation.
export async function djText({
  system,
  prompt,
  temperature = 0.9,
  topP = 0.95,
  repeatPenalty = 1.15,
  seed = null,
  maxOutputTokens = MAX_TOKENS_TEXT,
  kind = 'sdk.djText',
}) {
  const started = Date.now();
  try {
    const result = await generateText({
      model: languageModel(),
      system,
      prompt,
      temperature,
      topP,
      ...(seed != null ? { seed } : {}),
      maxOutputTokens,
      providerOptions: ollamaOptions(repeatPenalty),
    });
    const out = stripThinking(result.text);
    // Only record sampling knobs that actually reached the model — see
    // repeatPenaltyApplies() and providerOptions handling above.
    const sampling = { temperature, top_p: topP, seed };
    if (repeatPenaltyApplies()) sampling.repeat_penalty = repeatPenalty;
    recordSuccess({
      kind, started, via: 'ai-sdk',
      sampling,
      usage: usageOf(result),
      // Full, untruncated — the /debug surface shows the whole system prompt.
      extra: { system, user: prompt, response: out },
    });
    return out;
  } catch (err) {
    logFailurePreview(kind, err);
    recordFailure({
      kind, started, via: 'ai-sdk',
      error: err.message,
      extra: { user: prompt, ...failureDiagnostics(err) },
    });
    throw err;
  }
}

// Schema-validated structured output. `schema` is a Zod object schema; the
// returned value is parsed and validated.
//
// Two attempts, because small/cloud models occasionally botch structured
// output (the AI SDK throws NoObjectGeneratedError — "could not parse the
// response"):
//   1. native    — Output.object, which forwards the schema to the provider's
//                   structured-output mode (constrained decoding where it's
//                   supported).
//   2. recovery  — plain free-text, then strip <think> blocks / ``` fences and
//                   Zod-validate ourselves. Catches models that wrap the JSON
//                   in reasoning the native parser chokes on.
// Throws only if BOTH attempts fail.
export async function djObject({
  system,
  prompt,
  schema,
  temperature = 0.4,
  maxOutputTokens = MAX_TOKENS_OBJECT,
  kind = 'sdk.djObject',
}) {
  const started = Date.now();
  let lastErr;
  // Track the strategy actually attempted so a failure record attributes to
  // the right sub-path — bucketing every failure as 'ai-sdk' hides which
  // structured-output branch is breaking in /stats.
  let lastVia;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      let object;
      let usage;
      if (attempt === 1 && needsToolCallObject()) {
        lastVia = 'ai-sdk:tool';
        ({ object, usage } = await objectViaToolCall({ system, prompt, schema, temperature, maxOutputTokens }));
      } else if (attempt === 1) {
        lastVia = 'ai-sdk';
        const result = await generateText({
          model: languageModel(),
          system,
          prompt,
          temperature,
          maxOutputTokens,
          output: Output.object({ schema }),
          providerOptions: ollamaOptions(null),
        });
        object = result.output;
        usage = usageOf(result);
      } else {
        lastVia = 'ai-sdk:recovery';
        const result = await generateText({
          model: languageModel(),
          system,
          prompt: `${prompt}\n\nRespond with a single JSON object only — no prose, no markdown fences.`,
          temperature,
          maxOutputTokens,
          providerOptions: ollamaOptions(null),
        });
        object = schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
        usage = usageOf(result);
      }
      recordSuccess({
        kind, started, via: lastVia,
        sampling: { temperature },
        usage,
        // Full, untruncated — the /debug surface shows the whole system prompt.
        extra: { system, user: prompt, response: JSON.stringify(object).slice(0, 500) },
      });
      return object;
    } catch (err) {
      lastErr = err;
    }
  }
  logFailurePreview(kind, lastErr);
  recordFailure({
    kind, started, via: lastVia,
    error: lastErr.message,
    extra: { user: prompt, ...failureDiagnostics(lastErr) },
  });
  throw lastErr;
}

// Conversational tool-loop with structured output — the primitive behind the
// session DJ agent (broadcast/dj-agent.js). A ToolLoopAgent is given the
// music-discovery tools and a step cap, fed a `messages` array (the session
// chat window) instead of a single prompt, and returns a schema-validated
// final object. Throws on failure so the caller can fall back to a stateless
// path.
//
// When a `schema` is provided we use the AI SDK's canonical "done tool" pattern
// instead of Output.object: a synthetic `done` tool whose inputSchema IS the
// schema is added alongside the discovery tools, and `toolChoice: 'required'`
// forces the model to call tools at every step. The agent calls discovery
// tools to explore, then calls `done(<final answer>)` to terminate — the SDK
// validates the call's args against the schema and stops the loop (because
// `done` has no `execute`). This works reliably on Ollama-served models that
// ignore Output.object's constrained-decoding (their failure mode was emitting
// bare prose / a bare string / top-level null instead of the wrapping object;
// see /app/node_modules/ai/docs/03-agents/04-loop-control.mdx "Forced Tool
// Calling"). It's also compatible with OpenAI / Anthropic / etc.
export async function djAgent({
  system,
  messages,
  tools,
  schema,
  maxSteps = 8,
  temperature = 0.6,
  maxOutputTokens = MAX_TOKENS_AGENT,
  kind = 'sdk.djAgent',
}) {
  const started = Date.now();
  // Default to the agent path; the fast-path branch overrides before its await.
  // A failure record always attributes to the path actually attempted.
  let lastVia = 'ai-sdk:agent';
  try {
    // No discovery tools + an Ollama model that ignores JSON mode: there is no
    // loop to run, and ToolLoopAgent + Output.object would throw
    // NoObjectGeneratedError. Get the structured result from a forced tool call.
    const toolCount = tools ? Object.keys(tools).length : 0;
    if (schema && toolCount === 0 && needsToolCallObject()) {
      lastVia = 'ai-sdk:tool';
      const { object, usage } = await objectViaToolCall({ system, messages, schema, temperature, maxOutputTokens });
      recordSuccess({
        kind, started, via: lastVia,
        sampling: { temperature },
        usage,
        extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
      });
      return { object, steps: 0, toolCalls: [] };
    }
    // Build the tool set with the synthetic `done` tool when schema is set.
    // `done` carries the schema as its inputSchema, has no `execute`, and the
    // SDK validates+stops the loop when the model calls it.
    const useDoneTool = schema != null;
    const allTools = useDoneTool ? {
      ...tools,
      done: tool({
        description: 'Call this exactly once when you have your final answer. Pass the answer as input. Calling this tool IS how you respond — do not emit text after.',
        inputSchema: schema,
      }),
    } : tools;

    // When schema is set and we have discovery tools, force the first step to
    // be a discovery tool call — never `done`. This prevents the failure mode
    // where the model calls `done` with a hallucinated id without exploring
    // the library (observed on minimax-m2.7:cloud: model emitted a UUID-shaped
    // string that wasn't in any tool's results). Cloud Ollama models often
    // ignore plain `toolChoice: 'required'` too, but activeTools is enforced
    // at the request level — they can't see `done` until step 1, so they
    // can't call it.
    const discoveryToolNames = tools ? Object.keys(tools) : [];
    const useGatedDiscovery = useDoneTool && discoveryToolNames.length > 0;
    const prepareStep = useGatedDiscovery
      ? async ({ stepNumber }) => {
          if (stepNumber === 0) {
            return { activeTools: discoveryToolNames, toolChoice: 'required' };
          }
          return {};
        }
      : undefined;

    const agent = new ToolLoopAgent({
      model: languageModel(),
      instructions: system,
      tools: allTools,
      stopWhen: stepCountIs(maxSteps),
      temperature,
      maxOutputTokens,
      ...(useDoneTool ? { toolChoice: 'required' } : {}),
      ...(prepareStep ? { prepareStep } : {}),
    });
    const result = await agent.generate({ messages });
    const steps = result.steps?.length ?? 0;

    let object;
    if (useDoneTool) {
      // staticToolCalls carries tool calls from the FINAL step — the SDK
      // surfaces calls that weren't executed (like our no-execute `done`) here.
      const doneCall = (result.staticToolCalls || []).find(c => c.toolName === 'done');
      if (!doneCall) throw new Error('agent did not call the done tool before stopping');
      object = doneCall.input;
    } else {
      object = stripThinking(result.text);
    }

    // Flatten the discovery-tool trail for /debug. Exclude `done` — it's the
    // schema-emit signal, not a real library discovery action.
    const toolCalls = (result.steps || []).flatMap((s) => {
      const results = s.toolResults || [];
      return (s.toolCalls || [])
        .filter(c => c.toolName !== 'done')
        .map((c, i) => ({
          name: c.toolName,
          args: c.input ?? c.args ?? null,
          result: results[i]?.output ?? results[i]?.result ?? null,
        }));
    });
    recordSuccess({
      kind, started, via: lastVia,
      sampling: { temperature },
      usage: usageOf(result),
      // Full, untruncated — the agent's entire input and trail.
      extra: {
        system, messages, toolCalls, steps,
        response: schema ? JSON.stringify(object, null, 2) : String(object ?? ''),
      },
    });
    return { object, steps, toolCalls };
  } catch (err) {
    logFailurePreview(kind, err);
    recordFailure({
      kind, started, via: lastVia,
      error: err.message,
      extra: { system, messages, ...failureDiagnostics(err) },
    });
    throw err;
  }
}
