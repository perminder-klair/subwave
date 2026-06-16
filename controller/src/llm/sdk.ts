// AI SDK wrapper — the single chokepoint for every LLM call in the controller.
//
// Two primitives:
//   djText   — free-text generation (DJ intros, links, idents, skill segments)
//   djObject — schema-validated structured output (request matching, picker)
//
// Both resolve their model through llm/provider.js, so switching providers in
// Settings reroutes every call with no change here or at the call sites.
//
// Every primitive runs inside withFailover(): the primary leg is tried first,
// and only when its host is unreachable (connection refused / DNS / timeout —
// see isUnreachable) is the call retried once against the optional fallback leg
// (discussion #320). The structured-output strategy and sampling are resolved
// per leg from that leg's provider, so a primary→fallback switch across
// different providers picks the right path on each.

import { generateText, Output, stepCountIs, hasToolCall, ToolLoopAgent, tool } from 'ai';
import { primaryLeg, fallbackLeg } from './provider.js';
import { record } from './log.js';

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
// - DeepSeek: the V4 hybrid models think by default. Map the toggle onto
//   providerOptions.deepseek.thinking ({ type: 'enabled' | 'disabled' }).
//   reasoning:false must DISABLE it — thinking mode rejects tool_choice, so
//   the forced-tool paths (objectViaToolCall + picker done-tool) only work
//   with thinking off. (deepseek-reasoner always thinks regardless.)
// - OpenRouter / Gateway: no first-class knob; pass through to the
//   underlying provider's defaults.
// The num_ctx that will actually be sent for this leg, or null when none is.
// num_ctx is for LOCAL Ollama only: Ollama's default window is 4096, but the DJ
// agent feeds ~8k+ per turn (40-turn session window + tool schemas + discovery
// results); the default truncates the front of the prompt — dropping the system
// instructions and tool defs — so the model never calls `done` (issue #291).
// `:cloud` models run on Ollama's servers and manage their own context, so skip
// them. 0 → don't send it (use Ollama's default). One source of truth so the
// value sent (providerOpts) and the value recorded (samplingWithNumCtx) can't
// drift — a per-leg report, so a primary→fallback switch is attributed honestly
// (discussion #320).
function appliedNumCtx(cfg: any): number | null {
  const llm = cfg || {};
  const model = llm.model || '';
  const numCtx = Number(llm.numCtx);
  if (llm.provider === 'ollama' && !/:cloud$/i.test(model) && Number.isFinite(numCtx) && numCtx > 0) {
    return numCtx;
  }
  return null;
}

// Add the leg's effective num_ctx to a sampling record when one was sent, so
// /admin/debug shows the context window each call actually ran with. Mirrors how
// repeat_penalty is conditionally recorded.
function samplingWithNumCtx(cfg: any, sampling: any): any {
  const n = appliedNumCtx(cfg);
  if (n != null) sampling.num_ctx = n;
  return sampling;
}

// forceNoThink: this leg forces a tool call (toolChoice:'required' — every
// objectViaToolCall + the picker's done-tool loop). Anthropic and DeepSeek
// both REJECT forced tool use while thinking is active (Anthropic allows only
// auto/none with extended thinking; DeepSeek returns "Thinking mode does not
// support this tool_choice"). The picker can't use thinking on these providers
// regardless of the global toggle, so we suppress it on these legs only — the
// free-text DJ calls keep whatever the operator chose. OpenAI o-series/gpt-5
// and Gemini permit forced tools while reasoning, so they're untouched.
function providerOpts(
  cfg: any,
  { repeatPenalty = null, forceNoThink = false }: { repeatPenalty?: number | null; forceNoThink?: boolean } = {},
) {
  const llm = cfg || {};
  const reasoning = llm.reasoning === true;
  // Effective thinking for Anthropic/DeepSeek only — suppressed on forced-tool
  // legs because those providers reject tool_choice while thinking. Ollama,
  // OpenAI and Gemini permit forced tools mid-reasoning, so they read the raw
  // toggle and forceNoThink leaves them unchanged.
  const thinkForcedSafe = reasoning && !forceNoThink;
  const model = llm.model || '';
  const opts: any = {};

  const ollama: any = { think: reasoning };
  const ollamaOptions: any = {};
  if (repeatPenalty != null) ollamaOptions.repeat_penalty = repeatPenalty;
  const numCtx = appliedNumCtx(llm);
  if (numCtx != null) ollamaOptions.num_ctx = numCtx;
  if (Object.keys(ollamaOptions).length > 0) ollama.options = ollamaOptions;
  opts.ollama = ollama;

  if (!reasoning) {
    if (/^gemini-3/i.test(model)) {
      opts.google = { thinkingConfig: { thinkingLevel: 'minimal' } };
    } else if (/^gemini-2\.5/i.test(model)) {
      opts.google = { thinkingConfig: { thinkingBudget: 0 } };
    }
  }

  if (thinkForcedSafe && /^claude-/i.test(model)) {
    opts.anthropic = { thinking: { type: 'adaptive' } };
  }

  if (/^(o\d|gpt-5)/i.test(model)) {
    opts.openai = { reasoningEffort: reasoning ? 'medium' : 'minimal' };
  }

  // DeepSeek's V4 hybrid models (deepseek-v4-flash, deepseek-chat) THINK by
  // default. While thinking is active the API rejects tool_choice — "Thinking
  // mode does not support this tool_choice" — which breaks every forced-tool
  // path here (objectViaToolCall + the picker's done-tool loop, both
  // toolChoice:'required'). Map the reasoning toggle onto the provider's
  // documented `thinking` knob so reasoning:false explicitly disables it and
  // the tool paths work. With reasoning:on the picker still can't force tools,
  // so leave thinking on only for the free-text calls that don't force tools.
  if (llm.provider === 'deepseek') {
    opts.deepseek = { thinking: { type: thinkForcedSafe ? 'enabled' : 'disabled' } };
  }

  return opts;
}

// True when the active provider needs the tool-call structured-output path.
// Ollama-served models — local and especially the `:cloud` ones — ignore
// JSON-schema constrained decoding (Ollama's `format` field) and just emit
// prose, so Output.object throws NoObjectGeneratedError. Their tool-calling,
// however, works: see objectViaToolCall.
function needsToolCallObject(cfg: any) {
  return cfg?.provider === 'ollama';
}

// True when repeat_penalty actually reaches the model. It's bundled inside
// providerOptions.ollama, so only the Ollama provider reads it — every other
// provider (openai-compatible, openai, anthropic, …) silently drops it. The
// sampling log uses this to avoid claiming the value was applied when it
// wasn't. If a future provider gains a real repetition-penalty channel, widen
// this check and pipe the value through providerOpts's equivalent there.
function repeatPenaltyApplies(cfg: any) {
  return cfg?.provider === 'ollama';
}

// Centralised success/failure record writers. Every LLM call goes through one
// of each. The required-shape args (kind/started/via/sampling/usage for
// success, kind/started/via/error for failure) are explicit so a new primitive
// can't silently lack a field — the `usage: undefined` drift in the Ollama
// tool-call branch was the kind of bug this prevents. Per-primitive payload
// (system, messages, toolCalls, response, user, …) goes in `extra`.
function recordSuccess({ kind, started, via, model, sampling, usage, extra = {} }) {
  record({
    kind,
    ok: true,
    ms: Date.now() - started,
    model,
    via,
    sampling,
    usage,
    t: new Date().toISOString(),
    ...extra,
  });
}

function recordFailure({ kind, started, via, model, error, extra = {} }) {
  record({
    kind,
    ok: false,
    ms: Date.now() - started,
    model,
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

// Hard wall-clock ceiling on a single agent generation (including its
// transient retries). The `timeout` option on agent.generate() is NOT
// honoured by every transport — ai-sdk-ollama ignores it, so a
// reasoning-locked cloud model that never reaches the tool call just runs
// until its output budget is spent (observed at 60s+ per pick on
// minimax-m2.7:cloud while the caller believed it was capped at 22s). The
// race here is the guarantee; the AbortSignal is passed through as well so
// transports that DO support cancellation stop the request server-side
// instead of leaving it burning an inference slot.
//
// The deadline error deliberately does NOT look host-unreachable (its name
// matches neither isUnreachable's name checks nor its message regex): a model
// that overthinks past the deadline is not a host that's down, so the call
// must fall back to the caller's stateless path, not fail over to the backup
// leg on a different model.
function withDeadline<T>(ms: number | undefined, label: string, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!ms) return fn();
  const controller = new AbortController();
  let timer: any;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const err: any = new Error(`${label} exceeded ${ms}ms deadline`);
      err.name = 'AgentDeadlineError';
      reject(err);
    }, ms);
  });
  // Promise.race attaches a reaction to every contender, so a late rejection
  // from `fn` after the deadline fires is observed (and ignored), never an
  // unhandledRejection.
  return Promise.race([fn(controller.signal), deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Host-unreachable: the primary box is DOWN, not merely busy. A strict subset
// of isTransient — connection refused / DNS failure / connect timeout / socket
// hang-up. Deliberately EXCLUDES 408/425/429 and 5xx: a host that answers with
// a status is reachable, so those stay with withTransientRetry on the
// configured model rather than being masked by a silent failover to a different
// model. This is what gates failover to the backup leg (discussion #320).
const UNREACHABLE_CODE = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
]);
export function isUnreachable(err: any): boolean {
  if (!err) return false;
  const code = err.code ?? err.cause?.code;
  if (typeof code === 'string' && UNREACHABLE_CODE.has(code)) return true;
  const name = err.name ?? err.cause?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const msg = String(err.message || err.cause?.message || '');
  if (/fetch failed|socket hang up|getaddrinfo|connect ECONNREFUSED|connect ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return true;
  }
  return false;
}

// Run an LLM operation with primary→fallback failover. `attempt(leg)` performs
// one full generation against a single leg and returns a record-ready result
// ({ value, via, sampling, usage, extra }); it throws on error, optionally
// tagging the error with `__via` so the failure record attributes to the right
// sub-path (djObject/djAgent set this). The primary leg is tried first; only on
// a host-unreachable error — and only when a fallback is configured — is
// `attempt` retried once against the backup leg. record* lives here, so it's
// written exactly once per primitive with the leg that actually ran. On a
// failover the primary's failure is also recorded (via `…:failover→<backup>`)
// so /debug shows the switch happened.
// `pin` overrides leg selection: instead of trying the primary and failing over,
// the call runs exactly once against the named leg with NO cross-leg failover —
// any error propagates so the caller can manage its own leg (the library tagger
// pins one consumer per leg, discussion #320). Records carry a `…:pinned` via
// suffix so /stats' exact-match buckets stay untouched. Unpinned calls are the
// untouched primary→fallback path.
async function withFailover<T>(
  kind: string,
  failExtra: (err: any) => any,
  attempt: (leg: any) => Promise<{ value: T; via: string; sampling?: any; usage?: any; extra?: any }>,
  pin?: 'primary' | 'fallback',
): Promise<T> {
  if (pin) {
    const leg = pin === 'fallback' ? fallbackLeg() : primaryLeg();
    if (!leg) throw new Error(`withFailover: pinned leg "${pin}" is not configured`);
    const started = Date.now();
    try {
      const r = await attempt(leg);
      recordSuccess({ kind, started, via: `${r.via}:pinned`, model: leg.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
      return r.value;
    } catch (err: any) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started, via: `${err?.__via || 'ai-sdk'}:pinned`, model: leg.label, error: err?.message, extra: failExtra(err) });
      throw err;
    }
  }
  const primary = primaryLeg();
  const primaryStarted = Date.now();
  try {
    const r = await attempt(primary);
    recordSuccess({ kind, started: primaryStarted, via: r.via, model: primary.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
    return r.value;
  } catch (err: any) {
    const primaryVia = err?.__via || 'ai-sdk';
    const backup = isUnreachable(err) ? fallbackLeg() : null;
    if (!backup) {
      logFailurePreview(kind, err);
      recordFailure({ kind, started: primaryStarted, via: primaryVia, model: primary.label, error: err?.message, extra: failExtra(err) });
      throw err;
    }
    console.log(`[${kind}] primary LLM (${primary.label}) unreachable (${err?.code || err?.cause?.code || err?.name || 'unknown'}) — failing over to ${backup.label}`);
    recordFailure({ kind, started: primaryStarted, via: `${primaryVia}:failover→${backup.label}`, model: primary.label, error: err?.message, extra: failExtra(err) });
    const backupStarted = Date.now();
    try {
      const r = await attempt(backup);
      recordSuccess({ kind, started: backupStarted, via: r.via, model: backup.label, sampling: r.sampling, usage: r.usage, extra: r.extra });
      return r.value;
    } catch (err2: any) {
      logFailurePreview(kind, err2);
      recordFailure({ kind, started: backupStarted, via: err2?.__via || 'ai-sdk', model: backup.label, error: err2?.message, extra: failExtra(err2) });
      throw err2;
    }
  }
}

// Structured output via a forced tool call. The result schema is presented as
// an `emit` tool the model MUST call (toolChoice:'required'); we capture and
// Zod-validate its input. This is the reliable structured-output path for
// models that ignore JSON mode but handle tool calls fine. Single step — the
// model's only legal move is to call `emit` once. Returns the validated object
// plus a token-usage block so callers can log it alongside the other branches.
async function objectViaToolCall(leg: any, { system, prompt, messages, schema, temperature, maxOutputTokens }: any) {
  let captured: any;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input: any) => { captured = input; return 'received'; },
  });
  const result = await generateText({
    model: leg.model,
    system,
    ...(messages ? { messages } : { prompt }),
    temperature,
    maxOutputTokens,
    tools: { emit },
    toolChoice: 'required',
    stopWhen: stepCountIs(1),
    providerOptions: providerOpts(leg.cfg, { forceNoThink: true }),
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
        providerOptions: providerOpts(leg.cfg, { repeatPenalty }),
      }));
      const out = stripThinking(result.text);
      // Only record sampling knobs that actually reached the model — see
      // repeatPenaltyApplies() and providerOptions handling above.
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
  leg = undefined,
}: any) {
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
              () => objectViaToolCall(l, { system, prompt, schema, temperature, maxOutputTokens })));
          } else if (attempt === 1) {
            lastVia = 'ai-sdk';
            const result = await withTransientRetry(kind, () => generateText({
              model: l.model,
              system,
              prompt,
              temperature,
              maxOutputTokens,
              output: Output.object({ schema }),
              providerOptions: providerOpts(l.cfg),
            }));
            object = result.output;
            usage = usageOf(result);
          } else {
            lastVia = 'ai-sdk:recovery';
            const result = await withTransientRetry(kind, () => generateText({
              model: l.model,
              system,
              prompt: `${prompt}\n\nRespond with a single JSON object only — no prose, no markdown fences.`,
              temperature,
              maxOutputTokens,
              providerOptions: providerOpts(l.cfg),
            }));
            object = schema.parse(JSON.parse(extractJson(stripThinking(result.text))));
            usage = usageOf(result);
          }
          return {
            value: object,
            via: lastVia,
            sampling: samplingWithNumCtx(l.cfg, { temperature }),
            usage,
            // Full, untruncated — the /debug surface shows the whole system prompt.
            extra: { system, user: prompt, response: JSON.stringify(object).slice(0, 500) },
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
// The Ollama latency p95s can exceed the picker's `timeoutMs` ceiling
// (settings.llm.agentTimeoutMs, default 45s);
// agent.generate({ timeout }) is not honoured by the ai-sdk-ollama transport,
// so the ceiling is enforced here via withDeadline (Promise.race + abort
// signal) around each generation — main run and recovery run each get the
// full `timeoutMs`, so worst case is ~2× timeoutMs, not unbounded. On
// deadline the call throws and the caller (dj-agent.js) falls back to its
// stateless path; a slow run blocks only the next pick decision, never the
// broadcast (Liquidsoap keeps playing the auto.m3u fallback).
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
  return withFailover(
    kind,
    (err) => ({ system, messages, ...failureDiagnostics(err) }),
    async (leg) => {
    // Default to the agent path; the fast-path branch overrides before its await.
    // A failure record always attributes to the path actually attempted.
    let lastVia = 'ai-sdk:agent';
    try {
      // No discovery tools + an Ollama model that ignores JSON mode: there is no
      // loop to run, and ToolLoopAgent + Output.object would throw
      // NoObjectGeneratedError. Get the structured result from a forced tool call.
      const toolCount = tools ? Object.keys(tools).length : 0;
      if (schema && toolCount === 0 && needsToolCallObject(leg.cfg)) {
        lastVia = 'ai-sdk:tool';
        const { object, usage } = await withTransientRetry(kind,
          () => objectViaToolCall(leg, { system, prompt: undefined, messages, schema, temperature, maxOutputTokens }));
        return {
          value: { object, steps: 0, toolCalls: [] },
          via: lastVia,
          sampling: samplingWithNumCtx(leg.cfg, { temperature }),
          usage,
          extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
        };
      }
      // Structured output from a tool-using agent goes through the done-tool
      // path on EVERY provider; the schema-only (no-tools) case keeps native
      // Output.object off Ollama. See the header comment above for why.
      const useDoneTool = schema != null && (needsToolCallObject(leg.cfg) || toolCount > 0);
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
        model: leg.model,
        instructions: system,
        tools: allTools,
        // The no-execute `done` tool already terminates the loop when called;
        // hasToolCall('done') is belt-and-suspenders, and inert on the
        // non-Ollama path where no `done` tool exists.
        stopWhen: [stepCountIs(maxSteps), hasToolCall('done')],
        temperature,
        maxOutputTokens,
        // useDoneTool forces tool calls every step — suppress thinking on the
        // providers that reject forced tools mid-reasoning (Anthropic/DeepSeek).
        providerOptions: providerOpts(leg.cfg, { forceNoThink: useDoneTool }),
        ...(useDoneTool ? { toolChoice: 'required' } : {}),
        ...(prepareStep ? { prepareStep } : {}),
        // Non-Ollama path: native structured-output via Output.object. Ollama
        // path: schema lives on the `done` tool, so no agent-level output.
        ...(schema && !useDoneTool ? { output: Output.object({ schema }) } : {}),
      } as any);
      // timeoutMs (when set by a caller) is a hard ceiling — a slow/looping run
      // throws, flows through the catch below, and the caller falls back to its
      // stateless path rather than blocking on a pathological model call.
      // Enforced by withDeadline, not the generate option (see its comment).
      let result = await withDeadline(timeoutMs, `${kind} agent run`, (signal) =>
        withTransientRetry(kind, () => agent.generate({
          messages,
          ...(signal ? { abortSignal: signal } : {}),
        })));
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
          model: leg.model,
          instructions: system,
          tools: allTools,
          stopWhen: [stepCountIs(2), hasToolCall('done')],
          temperature,
          maxOutputTokens,
          // Recovery forces done-only (toolChoice:'required') every step, so it
          // has the same Anthropic/DeepSeek thinking conflict as the main run —
          // suppress thinking here too, or this path trips "Thinking mode does
          // not support this tool_choice" exactly when the main run already
          // dodged it.
          providerOptions: providerOpts(leg.cfg, { forceNoThink: true }),
          toolChoice: 'required',
          prepareStep: async () => ({ activeTools: ['done'], toolChoice: 'required' }),
        } as any);
        result = await withDeadline(timeoutMs, `${kind} agent recovery`, (signal) =>
          withTransientRetry(kind, () => recoveryAgent.generate({
            messages: recoveryMessages,
            ...(signal ? { abortSignal: signal } : {}),
          })));
        steps = result.steps?.length ?? 0;
      }

      let object;
      if (useDoneTool) {
        // staticToolCalls carries tool calls from the FINAL step — the SDK
        // surfaces calls that weren't executed (like our no-execute `done`) here.
        const doneCall = (result.staticToolCalls || []).find((c: any) => c.toolName === 'done');
        if (doneCall) {
          object = (doneCall as any).input;
        } else {
          // Salvage: some models (deepseek-v4-flash) end the forced loop emitting
          // the answer as text/JSON instead of a `done` tool call — even after the
          // done-only recovery. Parse it from the text and Zod-validate before
          // giving up, mirroring djObject's free-text recovery. Only throw (→
          // caller's pool fallback) when there's no usable JSON either.
          try {
            object = schema.parse(JSON.parse(extractJson(stripThinking(result.text || ''))));
            lastVia = `${lastVia}:text`;
          } catch {
            throw new Error('agent did not call the done tool before stopping');
          }
        }
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
      return {
        value: { object, steps, toolCalls },
        via: lastVia,
        sampling: samplingWithNumCtx(leg.cfg, { temperature }),
        usage: usageOf(result),
        // Full, untruncated — the agent's entire input and trail.
        extra: {
          system, messages, toolCalls, steps,
          response: schema ? JSON.stringify(object, null, 2) : String(object ?? ''),
        },
      };
    } catch (err) {
      // Attribute to the path actually attempted; withFailover writes the
      // record and decides whether a host-unreachable error tries the backup.
      (err as any).__via = lastVia;
      throw err;
    }
    },
  );
}
