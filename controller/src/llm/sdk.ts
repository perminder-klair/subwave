// AI SDK wrapper — the single chokepoint for every LLM call in the controller.
//
// Two primitives:
//   djText   — free-text generation (DJ intros, links, idents, skill segments)
//   djObject — schema-validated structured output (request matching, picker)
//
// Both resolve their model through llm/provider.js, so switching providers in
// Settings reroutes every call with no change here or at the call sites.

import { generateText, Output, stepCountIs, hasToolCall, ToolLoopAgent, tool } from 'ai';
import { languageModel, activeModelLabel, providerName } from './provider.js';
import { record } from './log.js';
import * as settings from '../settings.js';

// Hard output-token caps. A reasoning model with no cap can generate until it
// fills the whole context window — one runaway <think> ramble then ties up the
// inference slot for minutes. These are generous backstops for normal output
// (idents are ~150 tokens, structured picks ~250); raise them if you turn
// `llm.reasoning` on and need room for the chain-of-thought.
//
// The agent / object caps are higher than they look like they need because
// some cloud "reasoning by default" models (Gemini 3.x, Claude with extended
// thinking, GPT o-series) burn output budget on internal thinking before
// they ever emit the answer. providerOpts() below tries to suppress thinking
// when `llm.reasoning` is off, but provider coverage isn't complete — so the
// caps stay generous enough to survive a thinking model even when we can't
// turn its thinking off.
const MAX_TOKENS_TEXT   = 4000;
const MAX_TOKENS_OBJECT = 8000;
const MAX_TOKENS_AGENT  = 8000;

// djAgent done-tool path: prepareStep pins activeTools so EVERY step is a
// cornered single-purpose request — step 0 = discovery only, step >=
// COMMIT_AFTER_STEPS = `done` only. Both forms restrict activeTools at the
// request level, the only lever cloud Ollama models actually honour (they
// ignore a plain `toolChoice:'required'` when several tools are visible and
// just emit prose — which ends the loop with no `done` call: the "agent did
// not call the done tool" failure).
//
// COMMIT_AFTER_STEPS = 1 leaves NO free middle step, so that failure window is
// closed: the model gets exactly one discovery call, then must emit `done`.
// One targeted, session-aware discovery call (e.g. similarSongs on the current
// track) still yields ~8 candidates — plenty for a pick, and smarter than the
// stateless pool fallback. Raising this re-opens the middle-step failure
// window on cloud Ollama; don't, unless the provider honours `toolChoice`.
//
// This is independent of djAgent's `maxSteps`: every tool-using agent now takes
// the done-tool path (see djAgent below), so the loop ends when `done` is
// called (step 1), well before `maxSteps` — which is now just the backstop.
// The one-discovery-call cap applies to non-Ollama providers too even though
// they honour `toolChoice` and could safely explore more; keeping it uniform
// matched the validated behaviour. If a provider would benefit from deeper
// discovery, make the gate provider-conditional rather than raising it for all.
const COMMIT_AFTER_STEPS = 1;

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

// Per-provider option blocks for the AI SDK's `providerOptions` field. The
// SDK only reads the block matching the active provider, so it's safe to
// emit unused blocks — non-matching providers ignore them.
//
// This is the single chokepoint that translates the user-facing
// `llm.reasoning` toggle (Settings UI → "Chain-of-thought") into each
// provider's native thinking knob. Every provider has a different name and
// shape for it; keeping the translation in one place is what lets the toggle
// be honestly described as universal.
//
// - Ollama: `think: false` skips the <think> priming on Qwen3 / DeepSeek R1
//   / reasoning-tuned local models. `repeat_penalty` rides here too.
// - openai-compatible (Qwen3 via llama.cpp/vLLM/LM Studio): handled at the
//   transport layer by noThinkFetch() in provider.js, not here — it injects
//   chat_template_kwargs.enable_thinking into every request body.
// - Google (Gemini): gemini-3.x → thinkingLevel:'minimal'; gemini-2.5 →
//   thinkingBudget:0. Gemini thinks by default and silently chews the
//   maxOutputTokens budget — observed empirically on 3.5-flash returning
//   empty text on ~20% of picker calls before this was wired.
// - Anthropic (Claude): extended thinking is OFF by default. When reasoning
//   is on we opt in via `thinking: { type: 'adaptive' }`, which lets Claude
//   auto-tune effort (newer claude-sonnet-4-6+ / opus-4-6+). When off we
//   emit nothing — Claude's default is already what we want.
// - OpenAI (o-series + gpt-5): these always reason; only effort is tunable.
//   Map reasoning:false → 'minimal', reasoning:true → 'medium' (the SDK's
//   documented default). Gated on the model id since reasoningEffort is a
//   no-op or error on gpt-4 / gpt-3.5.
// - DeepSeek / OpenRouter / Gateway: no first-class knob. DeepSeek picks
//   reasoning by model variant (deepseek-reasoner vs -chat); OpenRouter and
//   Gateway pass through to the underlying provider's defaults.
function providerOpts({ repeatPenalty = null }: { repeatPenalty?: number | null } = {}) {
  const llm = settings.get().llm || {};
  const reasoning = llm.reasoning === true;
  const model = llm.model || '';
  const opts: any = {};

  const ollama: any = { think: reasoning };
  const ollamaOptions: any = {};
  if (repeatPenalty != null) ollamaOptions.repeat_penalty = repeatPenalty;
  // num_ctx for LOCAL Ollama only. Ollama's default window is 4096, but the DJ
  // agent feeds ~8k+ per turn (40-turn session window + tool schemas + discovery
  // results); the default truncates the front of the prompt — dropping the
  // system instructions and tool defs — so the model never calls `done` (issue
  // #291). `:cloud` models run on Ollama's servers and manage their own context,
  // so skip them. 0 → don't send it (use Ollama's default).
  const numCtx = Number(llm.numCtx);
  if (providerName() === 'ollama' && !/:cloud$/i.test(model) && Number.isFinite(numCtx) && numCtx > 0) {
    ollamaOptions.num_ctx = numCtx;
  }
  if (Object.keys(ollamaOptions).length > 0) ollama.options = ollamaOptions;
  opts.ollama = ollama;

  if (!reasoning) {
    if (/^gemini-3/i.test(model)) {
      opts.google = { thinkingConfig: { thinkingLevel: 'minimal' } };
    } else if (/^gemini-2\.5/i.test(model)) {
      opts.google = { thinkingConfig: { thinkingBudget: 0 } };
    }
  }

  if (reasoning && /^claude-/i.test(model)) {
    opts.anthropic = { thinking: { type: 'adaptive' } };
  }

  if (/^(o\d|gpt-5)/i.test(model)) {
    opts.openai = { reasoningEffort: reasoning ? 'medium' : 'minimal' };
  }

  return opts;
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
// this check and pipe the value through providerOpts's equivalent there.
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
function failureDiagnostics(err: any) {
  const out: any = {};
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
    out.toolCalls = steps.flatMap((s: any) => {
      const results = s.toolResults || [];
      return (s.toolCalls || []).map((c: any, i: number) => ({
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
function logFailurePreview(kind: string, err: any) {
  if (typeof err?.text !== 'string' || !err.text.trim()) return;
  const preview = err.text.replace(/\s+/g, ' ').trim().slice(0, 240);
  console.log(`[${kind}] raw model output (truncated): ${preview}`);
}

// Retry transient upstream failures (gateway timeouts, dropped sockets). Local
// Ollama — and anything proxying it — produces occasional 502/503/504 and TCP
// resets, especially on slow models with fat prompts. Without retry, one blip
// kills a station ID or hourly check (see issue #140). Two retries with
// jittered backoff is enough — beyond that the upstream is genuinely down and
// the failure should surface.
//
// Schema/parse failures and the agent's "did not call done" condition are NOT
// transient and bubble straight out — they need different recovery paths.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

function isTransient(err: any): boolean {
  if (!err) return false;
  const status = err.statusCode ?? err.status ?? err.cause?.statusCode ?? err.cause?.status;
  if (typeof status === 'number' && TRANSIENT_STATUS.has(status)) return true;
  const code = err.code ?? err.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODE.has(code)) return true;
  const name = err.name ?? err.cause?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String(err.message || err.cause?.message || '');
  if (/\b(408|425|429|500|502|503|504)\b/.test(msg)) return true;
  if (/socket hang up|fetch failed|network.*(error|timeout)/i.test(msg)) return true;
  return false;
}

async function withTransientRetry<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  const delays = [500, 1500]; // ms — two retries, ~2s total budget
  let lastErr: any;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === delays.length) throw err;
      const jitter = Math.floor(Math.random() * 200);
      const wait = delays[attempt] + jitter;
      const status = (err as any).statusCode ?? (err as any).status ?? (err as any).cause?.statusCode;
      console.log(`[${kind}] transient upstream error (${status || (err as any).code || 'unknown'}) — retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// Structured output via a forced tool call. The result schema is presented as
// an `emit` tool the model MUST call (toolChoice:'required'); we capture and
// Zod-validate its input. This is the reliable structured-output path for
// models that ignore JSON mode but handle tool calls fine. Single step — the
// model's only legal move is to call `emit` once. Returns the validated object
// plus a token-usage block so callers can log it alongside the other branches.
async function objectViaToolCall({ system, prompt, messages, schema, temperature, maxOutputTokens }: any) {
  let captured: any;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input: any) => { captured = input; return 'received'; },
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
    providerOptions: providerOpts(),
  } as any);
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
}: any) {
  const started = Date.now();
  try {
    const result = await withTransientRetry(kind, () => generateText({
      model: languageModel(),
      system,
      prompt,
      temperature,
      topP,
      ...(seed != null ? { seed } : {}),
      maxOutputTokens,
      providerOptions: providerOpts({ repeatPenalty }),
    }));
    const out = stripThinking(result.text);
    // Only record sampling knobs that actually reached the model — see
    // repeatPenaltyApplies() and providerOptions handling above.
    const sampling: any = { temperature, top_p: topP, seed };
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
}: any) {
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
        ({ object, usage } = await withTransientRetry(kind,
          () => objectViaToolCall({ system, prompt, schema, temperature, maxOutputTokens })));
      } else if (attempt === 1) {
        lastVia = 'ai-sdk';
        const result = await withTransientRetry(kind, () => generateText({
          model: languageModel(),
          system,
          prompt,
          temperature,
          maxOutputTokens,
          output: Output.object({ schema }),
          providerOptions: providerOpts(),
        }));
        object = result.output;
        usage = usageOf(result);
      } else {
        lastVia = 'ai-sdk:recovery';
        const result = await withTransientRetry(kind, () => generateText({
          model: languageModel(),
          system,
          prompt: `${prompt}\n\nRespond with a single JSON object only — no prose, no markdown fences.`,
          temperature,
          maxOutputTokens,
          providerOptions: providerOpts(),
        }));
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
// When a `schema` is provided, structured output comes from the AI SDK's
// documented "done tool" pattern (the canonical forced tool-calling pattern at
// /app/node_modules/ai/docs/03-agents/04-loop-control.mdx "Forced Tool
// Calling"): a synthetic `done` tool whose inputSchema IS the schema is added
// alongside the discovery tools, `toolChoice: 'required'` forces a tool call
// every step, and prepareStep below corners the model into discovery-then-done.
// This is used whenever the agent has tools — on EVERY provider.
//
// It used to be gated to Ollama only (needsToolCallObject()), with non-Ollama
// agents taking the native Output.object path on the assumption that those
// providers' constrained decoders interleave Output.object with tool calls
// correctly. They don't: across OpenAI direct (gpt-4o, gpt-4o-mini), OpenRouter
// (gemini-2.5-flash, claude-haiku-4.5), and others, ToolLoopAgent + tools +
// Output.object consistently ends the loop without ever emitting the object —
// the SDK throws "No output generated." and the picker falls back to the pool
// (issue #300). The AI SDK never documents Output.object as a tool-loop output
// strategy; the done tool is its recommended one. So tool-using agents now use
// it everywhere, and only the schema-only (no-tools) case keeps Output.object.
//
// Two reasons the done-tool path is needed differ by provider but converge on
// the same fix:
//   - Ollama: its structured-output mode (the `format` field, surfaced as
//     Output.object) forces schema-valid JSON *now* — incompatible with a tool
//     loop that must call discovery first. Dropping the done tool when the
//     ai-sdk-ollama swap landed collapsed glm-5.1:cloud from 20/20 → 0/20
//     (returns {"id":"","reason":""} without ever calling discovery).
//   - non-Ollama: Output.object after tool calls simply never emits (#300).
//
// Empirical reliability across the picker-test.mjs harness (20 short runs each
// unless noted). The Ollama rows were captured at the ai-sdk-ollama swap; the
// non-Ollama rows below the line are the #300 reproduction — every one failed
// to emit on the OLD Output.object path:
//   ollama:glm-5.1:cloud         done-tool 20/20  median  8.5s  p95 23.9s
//   ollama:kimi-k2.6:cloud       done-tool 20/20  median 31.8s  p95 55.3s
//   ollama:nemotron-3-super:cloud (10 runs) 10/10 median 16.5s  p95 208s
//   openai:gpt-4o                Output.object 0/n  "No output generated" (#300)
//   openai:gpt-4o-mini           Output.object 0/n  "No output generated" (#300)
//   openrouter:gemini-2.5-flash  Output.object 0/n  "No output generated" (#300)
//   openrouter:claude-haiku-4.5  Output.object 0/n  "No output generated" (#300)
// (An earlier table here recorded these models passing 5/5 on Output.object;
// that no longer reproduces on ai@6 — an SDK-version drift, per #300.)
// The Ollama latency p95s exceed the picker's 22s `timeoutMs` ceiling, but
// agent.generate({ timeout }) is not honoured by the ai-sdk-ollama transport
// — runs that exceed the cap simply run long. Callers (dj-agent.js) still
// fall back to the stateless pool picker on throw; a slow run blocks only the
// next pick decision, never the broadcast (Liquidsoap keeps playing the
// auto.m3u fallback). If a hard ceiling becomes load-bearing again, wrap the
// agent call in an explicit Promise.race here rather than relying on the
// option.
export async function djAgent({
  system,
  messages,
  tools,
  schema,
  maxSteps = 8,
  temperature = 0.6,
  maxOutputTokens = MAX_TOKENS_AGENT,
  kind = 'sdk.djAgent',
  timeoutMs,
}: any) {
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
      const { object, usage } = await withTransientRetry(kind,
        () => objectViaToolCall({ system, prompt: undefined, messages, schema, temperature, maxOutputTokens }));
      recordSuccess({
        kind, started, via: lastVia,
        sampling: { temperature },
        usage,
        extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
      });
      return { object, steps: 0, toolCalls: [] };
    }
    // Structured output from a tool-using agent goes through the done-tool
    // path on EVERY provider; the schema-only (no-tools) case keeps native
    // Output.object off Ollama. See the header comment above for why.
    const useDoneTool = schema != null && (needsToolCallObject() || toolCount > 0);
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
      ? async ({ stepNumber }: { stepNumber: number }) => {
          // Step 0: force a discovery tool — never `done`. Stops the model
          // committing a hallucinated id before seeing any library results.
          if (stepNumber === 0) {
            return { activeTools: discoveryToolNames, toolChoice: 'required' };
          }
          // Step >= COMMIT_AFTER_STEPS: force `done`. Cloud Ollama models
          // honour activeTools at the request level — with only `done` active
          // they cannot keep exploring and must emit their final answer. This
          // is what guarantees a `done` call before the step cap is hit.
          if (stepNumber >= COMMIT_AFTER_STEPS) {
            return { activeTools: ['done'], toolChoice: 'required' };
          }
          // Middle steps: all tools active — explore more, or commit early.
          return {};
        }
      : undefined;

    const agent = new ToolLoopAgent({
      model: languageModel(),
      instructions: system,
      tools: allTools,
      // The no-execute `done` tool already terminates the loop when called;
      // hasToolCall('done') is belt-and-suspenders, and inert on the
      // non-Ollama path where no `done` tool exists.
      stopWhen: [stepCountIs(maxSteps), hasToolCall('done')],
      temperature,
      maxOutputTokens,
      providerOptions: providerOpts(),
      ...(useDoneTool ? { toolChoice: 'required' } : {}),
      ...(prepareStep ? { prepareStep } : {}),
      // Non-Ollama path: native structured-output via Output.object. Ollama
      // path: schema lives on the `done` tool, so no agent-level output.
      ...(schema && !useDoneTool ? { output: Output.object({ schema }) } : {}),
    } as any);
    // timeoutMs (when set by a caller) is a hard ceiling — a slow/looping run
    // throws, flows through the catch below, and the caller falls back to its
    // stateless path rather than blocking on a pathological model call.
    let result = await withTransientRetry(kind, () => agent.generate({
      messages,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    }));
    let steps = result.steps?.length ?? 0;

    // Recovery for the "agent did not call the done tool" failure mode (issue
    // #140). Local/cloud Ollama models occasionally ignore toolChoice:'required'
    // at step 0 — they emit prose instead of any tool call, the loop ends with
    // zero tool calls, and we'd otherwise throw. Re-run once with prepareStep
    // pinned to `done`-only at step 0 so `done` is the model's only legal move.
    // The recovery agent has no discovery tools active, so the answer comes
    // from prior knowledge / the message history — a worse pick than a
    // discovery-then-done run, but better than throwing and silencing the
    // station ID / hourly check / segment entirely.
    if (useDoneTool && !(result.staticToolCalls || []).some((c: any) => c.toolName === 'done')) {
      console.log(`[${kind}] agent stopped without calling done — retrying with done-only`);
      lastVia = 'ai-sdk:agent:recovery';
      // Carry the first run's conversation forward — crucially its tool-call +
      // tool-result messages (the discovery trail). The first run DID surface
      // candidates into the caller's `seen` map (gated discovery forces a tool
      // call at step 0); it just never emitted `done`. Replaying only the bare
      // `messages` here strips those candidates, so a picker/request agent
      // cornered into done-only has no ids in context and can only fabricate
      // one — which is why 100% of recovery picks returned an "unknown id".
      // Feeding the discovery trail back lets the model commit to a REAL
      // surfaced id. Harmless for free-text recovery (no tool messages to add).
      const priorMessages = (result as any).response?.messages || [];
      const recoveryMessages = priorMessages.length ? [...messages, ...priorMessages] : messages;
      const recoveryAgent = new ToolLoopAgent({
        model: languageModel(),
        instructions: system,
        tools: allTools,
        stopWhen: [stepCountIs(2), hasToolCall('done')],
        temperature,
        maxOutputTokens,
        providerOptions: providerOpts(),
        toolChoice: 'required',
        prepareStep: async () => ({ activeTools: ['done'], toolChoice: 'required' }),
      } as any);
      result = await withTransientRetry(kind, () => recoveryAgent.generate({
        messages: recoveryMessages,
        ...(timeoutMs ? { timeout: timeoutMs } : {}),
      }));
      steps = result.steps?.length ?? 0;
    }

    let object;
    if (useDoneTool) {
      // staticToolCalls carries tool calls from the FINAL step — the SDK
      // surfaces calls that weren't executed (like our no-execute `done`) here.
      const doneCall = (result.staticToolCalls || []).find((c: any) => c.toolName === 'done');
      if (!doneCall) throw new Error('agent did not call the done tool before stopping');
      object = (doneCall as any).input;
    } else if (schema) {
      object = result.output;
    } else {
      object = stripThinking(result.text);
    }

    // Flatten the discovery-tool trail for /debug. Exclude `done` — it's the
    // schema-emit signal, not a real library discovery action.
    const toolCalls = ((result.steps as any) || []).flatMap((s: any) => {
      const results = s.toolResults || [];
      return (s.toolCalls || [])
        .filter((c: any) => c.toolName !== 'done')
        .map((c: any, i: number) => ({
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
