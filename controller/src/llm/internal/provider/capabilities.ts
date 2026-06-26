// Per-provider capability descriptors — the single place that translates the
// user-facing `llm.reasoning` toggle into each provider's native thinking knob,
// and declares the two structural traits the strategy layer keys off
// (does this provider need the forced-tool object path? does repeat_penalty
// reach it?).
//
// Pure: every function here is a function of the passed `cfg` only — no settings
// or SDK imports — so the mappings are unit-pinned (controller/scripts/llm-pure.test.ts).
//
// Why one block per active provider (not the historical "emit every block"):
// the AI SDK reads only the providerOptions block keyed to the active provider,
// and the model-id regexes below are anchored, so a gateway/openrouter id like
// "openai/gpt-5" never matches `/^gpt-5/`. Emitting only the active provider's
// block is therefore behaviourally identical to emitting all of them and letting
// non-matching providers ignore the rest — just far easier to read and test.

interface ThinkingArgs {
  modelId: string;
  reasoning: boolean;
  forceNoThink: boolean;
}

export interface ProviderCapabilities {
  // Ollama-served models ignore JSON-schema constrained decoding (Ollama's
  // `format` field) and emit prose, so Output.object throws — they need the
  // forced-tool path. Everyone else uses native Output.object.
  objectStrategy: 'native' | 'tool';
  // repeat_penalty rides inside providerOptions.ollama, so only Ollama reads it.
  repeatPenaltyApplies: boolean;
  // The providerOptions fragment for this provider given the resolved model id +
  // reasoning/forceNoThink flags.
  thinkingBlock(a: ThinkingArgs): Record<string, unknown>;
  // True when the provider reads `reasoning` ONLY from model-construction
  // settings, not per-call providerOptions (OpenRouter). For these, forceNoThink
  // can't be honoured via thinkingBlock — instead the registry builds a separate
  // reasoning-disabled model instance for forced-tool legs (see languageModel's
  // forceNoThink opt). Everyone else suppresses per-call and leaves this false.
  reasoningConstructionOnly?: boolean;
}

const NONE = (): Record<string, unknown> => ({});

const CAPS: Record<string, ProviderCapabilities> = {
  ollama: {
    objectStrategy: 'tool',
    repeatPenaltyApplies: true,
    // `think` reads the RAW reasoning toggle: Ollama permits forced tools while
    // thinking, so forceNoThink leaves it unchanged. repeat_penalty / num_ctx are
    // merged into `options` by providerOptions() below.
    thinkingBlock: ({ reasoning }) => ({ ollama: { think: reasoning } }),
  },
  openai: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // o-series / gpt-5 always reason; only effort is tunable. No-op on gpt-4/3.5.
    thinkingBlock: ({ modelId, reasoning }) =>
      /^(o\d|gpt-5)/i.test(modelId)
        ? { openai: { reasoningEffort: reasoning ? 'medium' : 'minimal' } }
        : {},
  },
  // openai-compatible targets self-hosted llama.cpp / vLLM / LM Studio — the
  // same local GGUF model class as ollama and locca, which emit a schema-valid
  // object WITHOUT exploring under native Output.object + auto tool_choice
  // (verified 8/8 explored=false on gemma-4-12b via this provider). So it takes
  // the forced done-tool path too, not the dead native leg.
  'openai-compatible': {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    // Thinking suppression is done at the transport layer (noThinkFetch in the
    // registry), not via providerOptions.
    thinkingBlock: NONE,
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
    thinkingBlock: NONE,
  },
  anthropic: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Extended thinking is OFF by default. Opt in only when reasoning is on AND
    // this leg isn't forcing a tool call — Claude rejects toolChoice while
    // thinking (forceNoThink covers the forced-tool paths).
    thinkingBlock: ({ modelId, reasoning, forceNoThink }) =>
      reasoning && !forceNoThink && /^claude-/i.test(modelId)
        ? { anthropic: { thinking: { type: 'adaptive' } } }
        : {},
  },
  google: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Gemini thinks by default and silently chews the maxOutputTokens budget;
    // suppress when reasoning is off. gemini-3.x → thinkingLevel:'minimal',
    // gemini-2.5 → thinkingBudget:0.
    thinkingBlock: ({ modelId, reasoning }) => {
      if (reasoning) return {};
      if (/^gemini-3/i.test(modelId)) return { google: { thinkingConfig: { thinkingLevel: 'minimal' } } };
      if (/^gemini-2\.5/i.test(modelId)) return { google: { thinkingConfig: { thinkingBudget: 0 } } };
      return {};
    },
  },
  deepseek: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // V4 hybrid models think by default; thinking mode rejects tool_choice, so
    // reasoning:false (or forceNoThink on a forced-tool leg) must explicitly
    // DISABLE it or the forced-tool paths break.
    thinkingBlock: ({ reasoning, forceNoThink }) =>
      ({ deepseek: { thinking: { type: reasoning && !forceNoThink ? 'enabled' : 'disabled' } } }),
  },
  // OpenRouter reads `reasoning` ONLY from model-construction settings, not
  // per-call providerOptions, so the thinking knob can't live here — it's wired
  // in registry.ts (languageModel) off cfg.reasoning, and forced-tool legs get a
  // separate reasoning-disabled instance (reasoningConstructionOnly). Reasoning
  // models routed through OpenRouter (e.g. xiaomi/mimo-v2.5) think by default,
  // and thinking mode rejects forced tool_choice, which breaks the picker.
  openrouter: { objectStrategy: 'native', repeatPenaltyApplies: false, thinkingBlock: NONE, reasoningConstructionOnly: true },
  // Requesty is an OpenAI-compatible gateway built via createOpenAI with
  // name:'requesty', so the AI SDK reads providerOptions under the `requesty`
  // namespace (providerOptionsName = provider.split('.')[0]) — validated against
  // the OpenAI options schema, which carries reasoningEffort. Mirror the openai
  // descriptor's suppression: minimal effort when reasoning is off or on a
  // forced-tool leg, so a reasoning model behind Requesty can still emit forced
  // tool calls. (Non-reasoning models ignore the field.)
  requesty: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    thinkingBlock: ({ reasoning, forceNoThink }) =>
      reasoning && !forceNoThink ? {} : { requesty: { reasoningEffort: 'minimal' } },
  },
  // Vercel AI Gateway routes to an underlying provider by `provider/model` id and
  // forwards provider-namespaced options through. We can't know the target's
  // namespace from here, so emit the knob for the providers that need suppressing
  // on forced-tool legs (anthropic + deepseek); the gateway passes through only
  // the block matching the resolved model and ignores the rest.
  gateway: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    thinkingBlock: ({ reasoning, forceNoThink }) =>
      reasoning && !forceNoThink
        ? {}
        : { anthropic: { thinking: { type: 'disabled' } }, deepseek: { thinking: { type: 'disabled' } } },
  },
};

// Unknown provider id → native objects, no repeat penalty, no thinking block.
// Matches the historical fall-through (needsToolCallObject was false, no block
// emitted). In practice the provider is always one of the eight above.
const DEFAULT_CAPS: ProviderCapabilities = {
  objectStrategy: 'native',
  repeatPenaltyApplies: false,
  thinkingBlock: NONE,
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

// True when repeat_penalty actually reaches the model — gates the sampling log
// so /debug doesn't claim the value was applied when the provider dropped it.
export function repeatPenaltyApplies(cfg: any): boolean {
  return capabilitiesFor(cfg?.provider).repeatPenaltyApplies;
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

// Add the leg's effective num_ctx to a sampling record when one was sent, so
// /admin/debug shows the context window each call actually ran with. Mirrors how
// repeat_penalty is conditionally recorded.
export function samplingWithNumCtx(cfg: any, sampling: any): any {
  const n = appliedNumCtx(cfg);
  if (n != null) sampling.num_ctx = n;
  return sampling;
}

// Per-provider option blocks for the AI SDK's `providerOptions` field — the
// single chokepoint translating `llm.reasoning` (Settings → "Chain-of-thought")
// into each provider's native thinking knob.
//
// forceNoThink: this leg forces a tool call (toolChoice:'required' — every
// objectViaToolCall + the picker's done-tool loop). Anthropic and DeepSeek both
// REJECT forced tool use while thinking is active, so we suppress it on those
// legs only (their descriptors factor forceNoThink in); the free-text DJ calls
// keep whatever the operator chose. OpenAI o-series/gpt-5 and Gemini permit
// forced tools while reasoning, so forceNoThink leaves them unchanged.
export function providerOptions(
  cfg: any,
  { repeatPenalty = null, forceNoThink = false }: { repeatPenalty?: number | null; forceNoThink?: boolean } = {},
): any {
  const provider = cfg?.provider;
  const block = capabilitiesFor(provider).thinkingBlock({
    modelId: cfg?.model || '',
    reasoning: cfg?.reasoning === true,
    forceNoThink,
  });
  if (provider === 'ollama') {
    const options: any = {};
    if (repeatPenalty != null) options.repeat_penalty = repeatPenalty;
    const n = appliedNumCtx(cfg);
    if (n != null) options.num_ctx = n;
    if (Object.keys(options).length > 0) {
      (block as any).ollama = { ...(block as any).ollama, options };
    }
  }
  return block;
}
