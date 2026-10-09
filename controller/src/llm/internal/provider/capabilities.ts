// Keep provider quirks here; strategy code uses capabilities rather than provider branches.
// AI SDK reasoning and reasoning-related providerOptions do not merge; the latter win.
// OpenRouter/compat/locca use construction-time controls in registry.ts instead.
// Pure cfg mappings are pinned by controller/scripts/llm-pure.test.ts.

interface ThinkingArgs {
  modelId: string;
  reasoning: boolean;
  forceNoThink: boolean;
}

// The subset of the SDK's reasoning levels SUB/WAVE emits: 'medium' is the
// balanced "on", 'minimal' the floor for models that can't turn it off, 'none'
// disables, undefined leaves the provider/model default alone.
export type ReasoningLevel = 'none' | 'minimal' | 'medium';

export interface ProviderCapabilities {
  // Ollama-served models ignore JSON-schema constrained decoding and emit prose,
  // so Output.object throws — they need the forced-tool path.
  objectStrategy: 'native' | 'tool';
  // True when a per-call repeat_penalty actually reaches the wire. Currently
  // false for everyone: ai-sdk-ollama v4 dropped the per-call channel, and the
  // body-injection providers go through appliedRepeatPenalty() instead.
  repeatPenaltyApplies: boolean;
  // llama.cpp / vLLM / LM Studio take sampling + thinking controls via a
  // request-body injection in the fetch wrapper (openAICompatibleFetch), because
  // the openai provider validates providerOptions and drops the rest.
  samplingViaBody?: boolean;
  // Top-level `reasoning` value for this provider. undefined = omit the param.
  reasoningLevel(a: ThinkingArgs): ReasoningLevel | undefined;
  // True when the provider reads `reasoning` ONLY from model-construction
  // settings (OpenRouter); the registry then builds a separate reasoning-disabled
  // instance for forced-tool legs instead of honouring forceNoThink here.
  reasoningConstructionOnly?: boolean;
  // FREE discovery steps the tool-loop agent gets before `done` is forced.
  // Absent → DISCOVERY_STEPS_MIN. Per-provider because the ceiling that keeps a
  // local GGUF model compliant is not the one a frontier model needs: forced-tool
  // providers emit schema-valid objects without exploring and ignore toolChoice
  // with several tools visible, so they keep a single cornered call.
  //
  // Widening this does NOT widen the number of `done` attempts — the step cap is
  // derived as discoverySteps + 1, so a run always makes exactly one forced-done
  // attempt before the recovery cascade. Extra done steps make compliance worse.
  discoverySteps?: number;
  // Where this provider's EMBEDDING leg sends requests, relative to its chat
  // leg — which decides whether the chat key may follow it there.
  //   'vendor'     — the vendor's own fixed endpoint serves both legs.
  //   'configured' — an operator-set server; the same service only when both
  //                  legs resolve to the same base URL.
  //   absent       — never the chat leg's service (anthropic embeds via OpenAI;
  //                  ollama takes no key; deepseek/gateway have no embeddings).
  embeddingEndpoint?: 'vendor' | 'configured';
  // Env var holding this provider's key, declared only where a builder must
  // read it itself: the createOpenAI transport on another vendor's endpoint
  // would otherwise look up OPENAI_API_KEY. A key read here is captured at
  // construction, so it has to key the client cache (registry.pinnedApiKey).
  apiKeyEnv?: string;
}

// Floor is the historical global value and what every forced-tool provider keeps.
// The ceiling exists because each step is a billable call against
// settings.llm.dailyTokenCap and all legs share one wall-clock deadline
// (settings.llm.agentTimeoutMs) — a tall budget would starve the recovery legs.
export const DISCOVERY_STEPS_MIN = 1;
export const DISCOVERY_STEPS_MAX = 5;

// Budget for providers that honour tool_choice and reason across tool results:
// seed, refine, then cross-check a second axis before committing.
const NATIVE_DISCOVERY_STEPS = 3;

const NONE = (): ReasoningLevel | undefined => undefined;

// Claude generations whose thinking cannot be switched off: Sonnet 5.5, Opus
// 5.5 and the Fable/Mythos 5 line 400 on `thinking:{type:"disabled"}`, and
// 5.5/5.1 additionally 400 on forced tool use (`tool_choice` any/tool —
// "tool_choice: type "tool" and "any" are not supported for this model"). Fable
// 5.0 still accepts tool_choice, but forced tools need thinking off, which it
// cannot do — so one predicate covers both consequences: never send 'none',
// never force a tool. Matched on the model id rather than the provider, because
// these ids reach us through the native provider, OpenRouter/gateway
// (`anthropic/claude-sonnet-5.5`) and OpenAI-compatible proxies alike.
// Separators may be `-` or `.` (gateways spell versions with dots).
const THINKING_MANDATORY_CLAUDE_RE = /claude-(?:(?:opus|sonnet)-5[-.]5|(?:fable|mythos)-5)\b/i;

export function thinkingMandatoryModel(modelId: string): boolean {
  return THINKING_MANDATORY_CLAUDE_RE.test(String(modelId || ''));
}

const CAPS: Record<string, ProviderCapabilities> = {
  ollama: {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    // v4 maps the per-call level onto Ollama's `think` param: 'none' →
    // think:false (a safe no-op on non-thinking models), undefined → the model
    // default. Reads the RAW reasoning toggle — Ollama permits forced tools while
    // thinking. Never emit a level string: 'medium' → think:'medium', which 400s
    // models that only accept a boolean.
    reasoningLevel: ({ reasoning }) => (reasoning ? undefined : 'none'),
  },
  openai: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Forwarded as reasoning_effort verbatim. gpt-5 and o-series floor at
    // 'minimal' ('none' is rejected); dotted GPT-5 generations (5.1+) replaced
    // 'minimal' with 'none'. Keep the model-id gate — gpt-4-class models 400 on
    // any reasoning effort. forceNoThink is not factored: forced tools are
    // permitted while reasoning.
    reasoningLevel: ({ modelId, reasoning }) =>
      /^(o\d|gpt-5)/i.test(modelId)
        ? (reasoning ? 'medium' : /^gpt-5\.\d/i.test(modelId) ? 'none' : 'minimal')
        : undefined,
    discoverySteps: NATIVE_DISCOVERY_STEPS,
    embeddingEndpoint: 'vendor',
  },
  // openai-compatible and locca serve the same local GGUF model class as ollama:
  // under native Output.object they emit a schema-valid object without exploring,
  // so the native leg is a wasted call. Forced done-tool path for both, with
  // no-think handled in transport.
  'openai-compatible': {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    // Self-hosted llama.cpp/vLLM read chat_template_kwargs, not reasoning_effort,
    // so the top-level param stays unset and the knobs ride the body.
    samplingViaBody: true,
    reasoningLevel: NONE,
    embeddingEndpoint: 'configured',
  },
  locca: {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    samplingViaBody: true,
    reasoningLevel: NONE,
    embeddingEndpoint: 'configured',
  },
  anthropic: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Extended thinking is off by default; 'medium' opts in. 'none' is required
    // on forced-tool legs because Claude rejects toolChoice while thinking.
    // Thinking-mandatory generations 400 on 'none' and never get a forced tool
    // (forcedToolChoice), so their floor is 'minimal' — adaptive thinking at
    // effort low, the cheapest setting they accept.
    reasoningLevel: ({ modelId, reasoning, forceNoThink }) => {
      if (thinkingMandatoryModel(modelId)) return reasoning ? 'medium' : 'minimal';
      return reasoning && !forceNoThink ? 'medium' : 'none';
    },
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  google: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Gemini thinks by default and chews maxOutputTokens; 'none' suppresses.
    // Gemma has no thinking mode, yet @ai-sdk/google routes every non-gemini-3 id
    // through the gemini-2.5 path, so 'none' becomes thinkingBudget:0 and the API
    // 400s (#1044) — omit the param for Gemma. The gemma- test mirrors
    // @ai-sdk/google's own guard. Forced tools are permitted while reasoning.
    reasoningLevel: ({ modelId, reasoning }) =>
      (reasoning || /(^|\/)gemma-/i.test(modelId) ? undefined : 'none'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
    embeddingEndpoint: 'vendor',
  },
  deepseek: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // V4 hybrids think by default and thinking mode rejects tool_choice, so a
    // forced-tool leg must explicitly disable it. Reasoning on → undefined: the
    // hybrid default already thinks, and DeepSeek coerces 'medium' up to 'high'.
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'none'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  // OpenRouter reads `reasoning` only from model-construction settings (verified
  // on @openrouter/ai-sdk-provider v3.0.0), so the knob is wired in registry.ts
  // and forced-tool legs get a separate reasoning-disabled instance.
  openrouter: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: NONE,
    reasoningConstructionOnly: true,
    discoverySteps: NATIVE_DISCOVERY_STEPS,
    embeddingEndpoint: 'vendor',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  // Requesty is built via createOpenAI, so the level resolves through the openai
  // code path as reasoning_effort. Suppressed when reasoning is off or on a
  // forced-tool leg. No model-id gate: requesty ids are `vendor/model` and the
  // gateway tolerates the field.
  requesty: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'minimal'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
    embeddingEndpoint: 'vendor',
    apiKeyEnv: 'REQUESTY_API_KEY',
  },
  // The gateway serializes the top-level level to whatever vendor the
  // `provider/model` id resolves to. Gemma downstreams are the exception, same
  // 400 as the google entry (#1044), so omit the param for them. A
  // thinking-mandatory Claude downstream gets 'minimal' instead of 'none'.
  gateway: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ modelId, reasoning, forceNoThink }) => {
      if ((reasoning && !forceNoThink) || /(^|\/)gemma-/i.test(modelId)) return undefined;
      return thinkingMandatoryModel(modelId) ? 'minimal' : 'none';
    },
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
};

// Unknown provider id → native objects, no repeat penalty, provider-default
// reasoning (the historical fall-through).
const DEFAULT_CAPS: ProviderCapabilities = {
  objectStrategy: 'native',
  repeatPenaltyApplies: false,
  reasoningLevel: NONE,
};

export function capabilitiesFor(provider: string | undefined): ProviderCapabilities {
  return (provider && CAPS[provider]) || DEFAULT_CAPS;
}

// Hosted OpenAI-compatible APIs can provide native structured output and do not
// understand llama.cpp's chat_template_kwargs / repeat_penalty extensions.
// The historical local mode remains the default for existing stations.
function capabilitiesForCfg(cfg: any): ProviderCapabilities {
  if (cfg?.provider === 'openai-compatible' && cfg?.compatibleMode === 'hosted') {
    return DEFAULT_CAPS;
  }
  return capabilitiesFor(cfg?.provider);
}

// True when the active provider needs the tool-call structured-output path.
export function needsToolCallObject(cfg: any): boolean {
  return capabilitiesForCfg(cfg).objectStrategy === 'tool';
}

// Free discovery steps this leg gets before `done` is forced.
//
// `settings.llm.discoverySteps` wins when set: the descriptor knows the PROVIDER
// but not which model it serves, and the two failure directions are opposite (a
// capable local model wants more than 1; a wandering cloud model wants fewer
// than 3). `0` (the default) means follow the descriptor.
//
// Read off the leg's cfg, never from settings, so this stays pure and primary
// and fallback resolve independently. Clamped to [MIN, MAX] on both paths —
// never zero, which would force `done` at step 0 with an empty `seen` map and
// leave the model able only to fabricate an id.
export function discoveryStepsFor(cfg: any): number {
  const override = cfg?.discoverySteps;
  if (Number.isFinite(override as number) && (override as number) > 0) {
    return clampDiscoverySteps(override as number);
  }
  const declared = cfg?.provider === 'openai-compatible' && cfg?.compatibleMode === 'hosted'
    ? NATIVE_DISCOVERY_STEPS : capabilitiesForCfg(cfg).discoverySteps;
  if (!Number.isFinite(declared as number)) return DISCOVERY_STEPS_MIN;
  return clampDiscoverySteps(declared as number);
}

function clampDiscoverySteps(n: number): number {
  return Math.min(DISCOVERY_STEPS_MAX, Math.max(DISCOVERY_STEPS_MIN, Math.floor(n)));
}

// Step cap for a gated discovery run: every discovery step plus the ONE forced-
// done step after them. Derived rather than taken from the caller, which keeps
// "exactly one forced-done attempt per run" true at any budget.
export function gatedMaxStepsFor(cfg: any): number {
  return discoveryStepsFor(cfg) + 1;
}

// The budget in force for ONE djAgent run. followProvider is the agent's own
// opt-in (providerDiscoveryBudget); every other caller keeps the historical
// single cornered step, because a caller's pinned cap can itself be load-bearing
// (the segment director's maxSteps: 2 in skills/_agent.ts).
export function runDiscoverySteps(cfg: any, followProvider: boolean): number {
  return followProvider ? discoveryStepsFor(cfg) : DISCOVERY_STEPS_MIN;
}

// tool_choice for the paths that force a tool call. Defaults to 'required';
// llm.toolChoice = 'auto' per leg downgrades it, because some vLLM images crash
// in the guided-decoding backend 'required' engages (#570). On 'auto' the
// done-tool harness keeps its activeTools pinning, and misses fall through to
// the stateless pool picker. Any value other than 'auto' means 'required'.
//
// A thinking-mandatory Claude model is 'auto' whatever the setting says: it
// 400s on a forced tool, and on an OpenAI-compatible proxy 'required' arrives
// as tool_choice:any. With one tool visible and EMIT_ANSWER_INSTRUCTION the
// model still answers through it.
export function forcedToolChoice(cfg: any): 'required' | 'auto' {
  if (cfg?.toolChoice === 'auto' || thinkingMandatoryModel(cfg?.model)) return 'auto';
  return 'required';
}

// Per-call safety thresholds for the native `google` provider, as ai-sdk
// providerOptions. Model-construction arguments are ignored by the SDK;
// `safetySettings` is resolved from the per-call providerOptions when the
// request body is built. Checked = block that category; unchecked/absent =
// allow (BLOCK_NONE). Every other provider gets {} (no-op spread), so call
// sites never name one.
export function googleSafetyOptions(cfg: any): Record<string, unknown> {
  if (!cfg || cfg.provider !== 'google') return {};
  const g = (cfg as any).geminiSafety || {};
  const setting = (v: unknown) => (v ? 'BLOCK_MEDIUM_AND_ABOVE' : 'BLOCK_NONE');
  return {
    providerOptions: {
      google: {
        safetySettings: [
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: setting(g.hateSpeech) },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: setting(g.dangerousContent) },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: setting(g.sexuallyExplicit) },
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: setting(g.harassment) },
        ],
      },
    },
  };
}

// Gates the sampling log so /debug doesn't claim a repeat_penalty was applied
// when the provider dropped it. Currently false everywhere; kept as the
// chokepoint for when the Ollama per-call channel is restored.
export function repeatPenaltyApplies(cfg: any): boolean {
  return capabilitiesForCfg(cfg).repeatPenaltyApplies;
}

// The repeat_penalty a body-injection provider will send this leg, or null.
// llama.cpp defaults to 1.0 = OFF, so without this the configured floor is
// dropped and the tool-loop agent can run away repeating a token block until the
// output cap, never emitting `done`. 1.0 or below is a no-op and is skipped.
export function appliedRepeatPenalty(cfg: any): number | null {
  if (!capabilitiesForCfg(cfg).samplingViaBody) return null;
  const rp = Number(cfg?.repeatPenalty);
  return Number.isFinite(rp) && rp > 1.0 ? rp : null;
}

// The num_ctx that will be sent for this leg, or null. Local Ollama only:
// Ollama's 4096 default truncates the front of a ~8k+ DJ prompt — dropping the
// system instructions and tool defs — so the model never calls `done` (#291).
// `:cloud` models manage their own context. 0 → don't send it.
export function appliedNumCtx(cfg: any): number | null {
  const llm = cfg || {};
  const model = llm.model || '';
  const numCtx = Number(llm.numCtx);
  if (llm.provider === 'ollama' && !/:cloud$/i.test(model) && Number.isFinite(numCtx) && numCtx > 0) {
    return numCtx;
  }
  return null;
}

// Stamp a sampling record with the local-only knobs the call actually ran with,
// so /admin/debug reflects them.
export function samplingWithLocalKnobs(cfg: any, sampling: any): any {
  const n = appliedNumCtx(cfg);
  if (n != null) sampling.num_ctx = n;
  const rp = appliedRepeatPenalty(cfg);
  if (rp != null) sampling.repeat_penalty = rp;
  return sampling;
}

// The single chokepoint translating `llm.reasoning` into a portable per-call
// level. undefined = omit the param.
//
// forceNoThink marks a leg that forces a tool call. Anthropic and DeepSeek reject
// forced tool use while thinking, so their descriptors factor it in; OpenAI
// o-series/gpt-5 and Gemini permit it and leave it unchanged.
//
// Never reintroduce reasoning-related providerOptions alongside this — the SDK
// does not merge them and the provider-specific block silently wins.
export function reasoningFor(
  cfg: any,
  { forceNoThink = false }: { forceNoThink?: boolean } = {},
): ReasoningLevel | undefined {
  return capabilitiesForCfg(cfg).reasoningLevel({
    modelId: cfg?.model || '',
    reasoning: cfg?.reasoning === true,
    forceNoThink,
  });
}

const trimBaseUrl = (u: unknown): string => String(u || '').trim().replace(/\/+$/, '');

// May the embedding leg reuse the chat leg's credentials (inline key, custom
// headers)? Only when it talks to the same service: the same provider, and for
// an operator-configured server the same resolved base URL. A credential that
// follows the provider id alone reaches whichever server the embedding leg
// points at — another vendor's API, or a separate self-hosted box. Callers pass
// RESOLVED base URLs (registry.chatBaseUrl / embedding.embeddingBaseUrl), so a
// blank field and its default compare as the same server.
export function embeddingSharesChatCredential(
  chat: { provider?: string; baseUrl?: string },
  embed: { provider?: string; baseUrl?: string },
): boolean {
  if (!embed.provider || embed.provider !== chat.provider) return false;
  switch (capabilitiesFor(embed.provider).embeddingEndpoint) {
    case 'vendor':
      return true;
    case 'configured': {
      const a = trimBaseUrl(chat.baseUrl);
      return !!a && a === trimBaseUrl(embed.baseUrl);
    }
    default:
      return false;
  }
}
