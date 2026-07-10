// Per-provider capability descriptors — the single place that translates the
// user-facing `llm.reasoning` toggle into each provider's thinking control,
// and declares the two structural traits the strategy layer keys off
// (does this provider need the forced-tool object path? does repeat_penalty
// reach it?).
//
// Pure: every function here is a function of the passed `cfg` only — no settings
// or SDK imports — so the mappings are unit-pinned (controller/scripts/llm-pure.test.ts).
//
// Thinking control rides AI SDK 7's top-level `reasoning` call option
// ('none'|'minimal'|'medium'|…), which each first-party provider — and
// ai-sdk-ollama v4 — translates to its native knob per call. That replaced the
// old per-provider providerOptions fragments (thinkingBlock): the SDK NEVER
// merges the two, and reasoning-related providerOptions silently win over the
// top-level param, so the fragments had to go entirely when this migrated.
// Providers with no per-call channel (OpenRouter, and the body-injection
// openai-compatible/locca path) return undefined here and keep their
// construction-time wiring in registry.ts.

interface ThinkingArgs {
  modelId: string;
  reasoning: boolean;
  forceNoThink: boolean;
}

// The subset of the SDK's reasoning levels SUB/WAVE emits. The boolean
// `llm.reasoning` toggle never needs the high tiers: 'medium' is the balanced
// "on" for providers whose reasoning must be explicitly requested, 'minimal' is
// the floor for models that can't turn it off (OpenAI o-series/gpt-5), 'none'
// disables, and undefined leaves the provider/model default untouched.
export type ReasoningLevel = 'none' | 'minimal' | 'medium';

export interface ProviderCapabilities {
  // Ollama-served models ignore JSON-schema constrained decoding (Ollama's
  // `format` field) and emit prose, so Output.object throws — they need the
  // forced-tool path. Everyone else uses native Output.object.
  objectStrategy: 'native' | 'tool';
  // True when a per-call repeat_penalty actually reaches this provider's wire.
  // Currently false for EVERYONE: ai-sdk-ollama v4 dropped the per-call
  // providerOptions.ollama channel (its schema accepts only
  // headers/structuredOutputs), and the body-injection providers are recorded
  // via appliedRepeatPenalty() instead. Restoring the Ollama knob needs
  // per-value model instances or an upstream option — tracked follow-up.
  repeatPenaltyApplies: boolean;
  // llama.cpp / vLLM / LM Studio (openai-compatible, locca) take sampling +
  // thinking controls the AI SDK's openai provider has no first-class field for
  // (repeat_penalty, reasoning_format, enable_thinking) via a request-body
  // injection in the fetch wrapper, not providerOptions — the openai provider
  // validates providerOptions against its own schema and drops the rest. Flags
  // the providers openAICompatibleFetch() rewrites the body for.
  samplingViaBody?: boolean;
  // The top-level `reasoning` value for this provider given the resolved model
  // id + reasoning/forceNoThink flags. undefined = omit the param (keep the
  // provider/model default).
  reasoningLevel(a: ThinkingArgs): ReasoningLevel | undefined;
  // True when the provider reads `reasoning` ONLY from model-construction
  // settings, not per-call options (OpenRouter). For these, forceNoThink can't
  // be honoured via reasoningLevel — instead the registry builds a separate
  // reasoning-disabled model instance for forced-tool legs (see languageModel's
  // forceNoThink opt). Everyone else suppresses per-call and leaves this false.
  reasoningConstructionOnly?: boolean;
}

const NONE = (): ReasoningLevel | undefined => undefined;

const CAPS: Record<string, ProviderCapabilities> = {
  ollama: {
    objectStrategy: 'tool',
    // v4 of ai-sdk-ollama has NO per-call repeat_penalty channel (see the
    // interface comment) — flag it false so djText's sampling record stops
    // claiming the knob was applied when it never reached the wire.
    repeatPenaltyApplies: false,
    // ai-sdk-ollama v4 maps the per-call level onto Ollama's `think` param:
    // 'none' → think:false (safe no-op on non-thinking models, verified Ollama
    // 0.30), undefined → the model's own default. Reads the RAW reasoning
    // toggle: Ollama permits forced tools while thinking, so forceNoThink
    // leaves it unchanged. NEVER emit a level string here — the package maps
    // 'medium' → think:'medium', which 400s models that only accept boolean
    // think (qwen3-class).
    reasoningLevel: ({ reasoning }) => (reasoning ? undefined : 'none'),
  },
  openai: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // o-series / gpt-5 always reason; only effort is tunable — 'minimal' is the
    // floor ('none' is rejected). The model-id gate must stay: the provider
    // forwards the level as reasoning_effort VERBATIM, and gpt-4-class models
    // 400 on receiving it. forceNoThink not factored — these models permit
    // forced tools while reasoning.
    reasoningLevel: ({ modelId, reasoning }) =>
      /^(o\d|gpt-5)/i.test(modelId) ? (reasoning ? 'medium' : 'minimal') : undefined,
  },
  // openai-compatible targets self-hosted llama.cpp / vLLM / LM Studio — the
  // same local GGUF model class as ollama and locca, which emit a schema-valid
  // object WITHOUT exploring under native Output.object + auto tool_choice
  // (verified 8/8 explored=false on gemma-4-12b via this provider). So it takes
  // the forced done-tool path too, not the dead native leg.
  'openai-compatible': {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    // repeat_penalty / reasoning_format / enable_thinking are injected into the
    // request body at the transport layer (openAICompatibleFetch in the
    // registry) — self-hosted llama.cpp/vLLM read chat_template_kwargs, not
    // reasoning_effort, so the top-level param must stay unset here.
    samplingViaBody: true,
    reasoningLevel: NONE,
  },
  // locca serves local llama.cpp GGUF models — the SAME model class as Ollama,
  // not a cloud endpoint. Under native Output.object + auto tool_choice they emit
  // a schema-valid object WITHOUT calling any discovery tool (verified 32/32
  // explored=false on gemma-4-12b / qwen3.5-9b), so the native-then-done path
  // wastes a model call before falling back. Use the forced done-tool path like
  // ollama. No repeat_penalty, no-think handled in transport.
  locca: {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    samplingViaBody: true,
    reasoningLevel: NONE,
  },
  anthropic: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Extended thinking is OFF by default; 'medium' opts in (the provider maps
    // it to adaptive thinking with effort:'medium' on adaptive models, a token
    // budget on older claude ids). 'none' disables — needed on forced-tool legs
    // because Claude rejects toolChoice while thinking. No model-id gate: the
    // provider owns its own id space.
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? 'medium' : 'none'),
  },
  google: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Gemini thinks by default and silently chews the maxOutputTokens budget;
    // 'none' suppresses (the provider maps it per model family: gemini-3.x →
    // thinkingLevel:'minimal', gemini-2.5 → thinkingBudget:0 — the same blocks
    // the old thinkingBlock emitted, but the model regexes live upstream now).
    // forceNoThink not factored — Gemini permits forced tools while reasoning.
    reasoningLevel: ({ reasoning }) => (reasoning ? undefined : 'none'),
  },
  deepseek: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // V4 hybrid models think by default; thinking mode rejects tool_choice, so
    // reasoning:false (or forceNoThink on a forced-tool leg) must explicitly
    // DISABLE it or the forced-tool paths break. Reasoning on → undefined (the
    // hybrid default already thinks; never send a level — DeepSeek coerces
    // 'medium' up to 'high' server-side).
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'none'),
  },
  // OpenRouter reads `reasoning` ONLY from model-construction settings, not
  // per-call options, so the thinking knob can't live here — it's wired in
  // registry.ts (languageModel) off cfg.reasoning via extraBody, and forced-tool
  // legs get a separate reasoning-disabled instance (reasoningConstructionOnly).
  // Reasoning models routed through OpenRouter (e.g. xiaomi/mimo-v2.5) think by
  // default, and thinking mode rejects forced tool_choice, which breaks the
  // picker. Verified on @openrouter/ai-sdk-provider v3.0.0: it declares spec v4
  // but never reads callOptions.reasoning — construction stays the only channel
  // until upstream implements the translation.
  openrouter: { objectStrategy: 'native', repeatPenaltyApplies: false, reasoningLevel: NONE, reasoningConstructionOnly: true },
  // Requesty is an OpenAI-compatible gateway built via createOpenAI with
  // name:'requesty', so the top-level level resolves through the same openai
  // code path — 'minimal' lands as reasoning_effort:'minimal', the exact bytes
  // the old providerOptions.requesty block produced. Suppress when reasoning is
  // off or on a forced-tool leg, so a reasoning model behind Requesty can still
  // emit forced tool calls; non-reasoning models ignore the field. (No model-id
  // gate — requesty ids are `vendor/model`, never matched by openai's regex, and
  // the gateway tolerates the field.)
  requesty: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'minimal'),
  },
  // Vercel AI Gateway serializes the full call options — including the top-level
  // reasoning level — to the downstream provider, so 'none' suppresses whatever
  // vendor the `provider/model` id resolves to. (The old shape emitted disable
  // blocks for anthropic + deepseek only; this covers google/openai/xai/zai
  // downstreams too.)
  gateway: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'none'),
  },
};

// Unknown provider id → native objects, no repeat penalty, provider-default
// reasoning. Matches the historical fall-through (needsToolCallObject was
// false, no thinking knob emitted). In practice the provider is always one of
// the entries above.
const DEFAULT_CAPS: ProviderCapabilities = {
  objectStrategy: 'native',
  repeatPenaltyApplies: false,
  reasoningLevel: NONE,
};

export function capabilitiesFor(provider: string | undefined): ProviderCapabilities {
  return (provider && CAPS[provider]) || DEFAULT_CAPS;
}

// True when the active provider needs the tool-call structured-output path.
export function needsToolCallObject(cfg: any): boolean {
  return capabilitiesFor(cfg?.provider).objectStrategy === 'tool';
}

// The tool_choice value to send when SUB/WAVE wants to FORCE a tool call (the
// structured-output emit/done paths). Defaults to 'required' — every local-model
// structured-output path depends on it, and forced tool calling is the AI SDK's
// documented pattern for it. An operator can set llm.toolChoice = 'auto' per leg
// to downgrade it: recent vLLM implements tool_choice:"required" via a
// guided-decoding backend that some images (newer Intel/XPU builds) crash on,
// while "auto" never engages it (issue #570). On 'auto' the done-tool harness
// keeps its prepareStep activeTools pinning + explicit instructions, so a capable
// model usually still calls the single visible tool; misses fall through to the
// stateless pool picker. Reads cfg.toolChoice (primary or fallback leg); any
// value other than the literal 'auto' is treated as 'required'.
export function forcedToolChoice(cfg: any): 'required' | 'auto' {
  return cfg?.toolChoice === 'auto' ? 'auto' : 'required';
}

// True when a per-call repeat_penalty actually reaches the model — gates the
// sampling log so /debug doesn't claim the value was applied when the provider
// dropped it. Currently false for every provider (ai-sdk-ollama v4 lost the
// per-call channel; the body-injection providers are covered by
// appliedRepeatPenalty() instead), so the djText gate never fires — kept as the
// chokepoint for when the Ollama channel is restored.
export function repeatPenaltyApplies(cfg: any): boolean {
  return capabilitiesFor(cfg?.provider).repeatPenaltyApplies;
}

// The repeat_penalty a body-injection provider (openai-compatible, locca) will
// actually send this leg, or null when none is. llama.cpp's own default is
// 1.0 = OFF, so without this the operator's configured floor is silently
// dropped and the tool-loop agent can run away repeating a token block until
// it hits the output cap, never emitting `done` (gist quirk #2). A value of
// 1.0 (or below) is a no-op, so we skip it to keep the body clean. Reads
// cfg.repeatPenalty (primary or fallback leg).
export function appliedRepeatPenalty(cfg: any): number | null {
  if (!capabilitiesFor(cfg?.provider).samplingViaBody) return null;
  const rp = Number(cfg?.repeatPenalty);
  return Number.isFinite(rp) && rp > 1.0 ? rp : null;
}

// The num_ctx that will actually be sent for this leg, or null when none is.
// num_ctx is for LOCAL Ollama only: Ollama's default window is 4096, but the DJ
// agent feeds ~8k+ per turn (40-turn session window + tool schemas + discovery
// results); the default truncates the front of the prompt — dropping the system
// instructions and tool defs — so the model never calls `done` (issue #291).
// `:cloud` models run on Ollama's servers and manage their own context, so skip
// them. 0 → don't send it (use Ollama's default).
export function appliedNumCtx(cfg: any): number | null {
  const llm = cfg || {};
  const model = llm.model || '';
  const numCtx = Number(llm.numCtx);
  if (llm.provider === 'ollama' && !/:cloud$/i.test(model) && Number.isFinite(numCtx) && numCtx > 0) {
    return numCtx;
  }
  return null;
}

// Stamp a sampling record with the local-only knobs each call actually ran with,
// so /admin/debug reflects them: Ollama's effective num_ctx, and the
// repeat_penalty injected into the body for openai-compatible / locca — the only
// providers where the knob currently reaches the wire at all (ai-sdk-ollama v4
// has no per-call channel; see repeatPenaltyApplies).
export function samplingWithLocalKnobs(cfg: any, sampling: any): any {
  const n = appliedNumCtx(cfg);
  if (n != null) sampling.num_ctx = n;
  const rp = appliedRepeatPenalty(cfg);
  if (rp != null) sampling.repeat_penalty = rp;
  return sampling;
}

// The AI SDK top-level `reasoning` value for a call — the single chokepoint
// translating `llm.reasoning` (Settings → "Chain-of-thought") into a portable
// per-call level the provider maps to its native thinking knob. undefined =
// omit the param (keep the provider/model default).
//
// forceNoThink: this leg forces a tool call (toolChoice:'required' — every
// objectViaToolCall + the picker's done-tool loop). Anthropic and DeepSeek both
// REJECT forced tool use while thinking is active, so we suppress it on those
// legs only (their descriptors factor forceNoThink in); the free-text DJ calls
// keep whatever the operator chose. OpenAI o-series/gpt-5 and Gemini permit
// forced tools while reasoning, so forceNoThink leaves them unchanged.
//
// IMPORTANT: never reintroduce reasoning-related providerOptions alongside this
// — the SDK doesn't merge them, and provider-specific blocks silently WIN over
// the top-level param.
export function reasoningFor(
  cfg: any,
  { forceNoThink = false }: { forceNoThink?: boolean } = {},
): ReasoningLevel | undefined {
  return capabilitiesFor(cfg?.provider).reasoningLevel({
    modelId: cfg?.model || '',
    reasoning: cfg?.reasoning === true,
    forceNoThink,
  });
}
