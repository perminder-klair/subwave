// Per-provider capability descriptors — the single place that translates the
// user-facing `llm.reasoning` toggle into each provider's thinking control,
// and declares the two structural traits the strategy layer keys off
// (does this provider need the forced-tool object path? does repeat_penalty
// reach it?).
//
// Pure: every function here is a function of the passed `cfg` only — no settings
// or SDK imports — so the mappings are unit-pinned (controller/scripts/llm-pure.test.ts).
//
// Thinking control rides AI SDK 7's top-level `reasoning` call option, which
// each first-party provider — and ai-sdk-ollama v4 — translates to its native
// knob per call. Never mix it with providerOptions: the SDK does NOT merge the
// two, and reasoning-related providerOptions silently win. Providers with no
// per-call channel (OpenRouter, and the body-injection openai-compatible/locca
// path) return undefined here and keep their construction-time wiring in
// registry.ts.

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
  // How many FREE discovery steps the tool-loop agent gets before `done` is
  // forced (gatedDiscoveryPrepareStep in strategy/agent.ts). Absent →
  // DISCOVERY_STEPS_MIN.
  //
  // Per-provider for the same reason objectStrategy is: the ceiling that keeps a
  // local GGUF model compliant is not the one a frontier model needs. Forced-tool
  // providers emit schema-valid objects WITHOUT exploring and ignore
  // `toolChoice` with several tools visible, so they keep a single cornered
  // discovery call; native-strategy providers get room to seed, refine and
  // cross-check.
  //
  // Widening this does NOT widen the number of `done` attempts — the step cap is
  // derived as `discoverySteps + 1`, so the main run always makes exactly ONE
  // forced-done attempt before handing off to agent.ts's recovery cascade. Extra
  // done steps grow an "I already declined" trail and make compliance worse, so
  // the rescue is recovery, never more steps (see dj-agent/agents.ts).
  discoverySteps?: number;
}

// Floor and ceiling on the discovery budget. The floor is the historical global
// value (COMMIT_AFTER_STEPS = 1) and is what every forced-tool provider keeps.
// The ceiling exists because each step is a separate billable model call that
// counts against settings.llm.dailyTokenCap, and because all legs of a pick
// share ONE wall-clock deadline (settings.llm.agentTimeoutMs) — a budget tall
// enough to exhaust the deadline in discovery would starve the recovery legs
// that actually rescue a failed run.
export const DISCOVERY_STEPS_MIN = 1;
export const DISCOVERY_STEPS_MAX = 5;

// The discovery budget for providers that honour tool_choice and reason across
// tool results. Three leaves room for the shape the one-call ceiling forbids:
// seed from the on-air track, refine on what came back, then cross-check a
// second axis (sound vs text) before committing.
const NATIVE_DISCOVERY_STEPS = 3;

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
    // OpenAI forwards the level as reasoning_effort VERBATIM. Original gpt-5
    // and o-series use 'minimal' as their floor ('none' is rejected), while the
    // dotted GPT-5 generations (5.1+) replaced 'minimal' with 'none'. Keep the
    // model-id gate: gpt-4-class models 400 on receiving any reasoning effort.
    // forceNoThink is not factored — these models permit forced tools while
    // reasoning.
    reasoningLevel: ({ modelId, reasoning }) =>
      /^(o\d|gpt-5)/i.test(modelId)
        ? (reasoning ? 'medium' : /^gpt-5\.\d/i.test(modelId) ? 'none' : 'minimal')
        : undefined,
    discoverySteps: NATIVE_DISCOVERY_STEPS,
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
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  google: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Gemini thinks by default and silently chews the maxOutputTokens budget;
    // 'none' suppresses (the provider maps it per model family: gemini-3.x →
    // thinkingLevel:'minimal', gemini-2.5 → thinkingBudget:0 — the same blocks
    // the old thinkingBlock emitted, but the model regexes live upstream now).
    // Gemma is the exception: it has NO thinking mode, yet @ai-sdk/google's
    // resolveThinkingConfig routes every non-gemini-3 id (Gemma included) through
    // the gemini-2.5 path, so 'none' becomes thinkingBudget:0 and the API 400s
    // "Thinking budget is not supported for this model" (issue #1044). Omit the
    // param for Gemma so upstream sends no thinkingConfig at all — matching what
    // v0.39.0's model-gated thinkingBlock did (it fell through to {} for Gemma).
    // The gemma- test mirrors @ai-sdk/google's own guard (startsWith('gemma-')).
    // forceNoThink not factored — Gemini permits forced tools while reasoning.
    reasoningLevel: ({ modelId, reasoning }) =>
      (reasoning || /(^|\/)gemma-/i.test(modelId) ? undefined : 'none'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
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
    discoverySteps: NATIVE_DISCOVERY_STEPS,
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
  openrouter: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: NONE,
    reasoningConstructionOnly: true,
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
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
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  // OrcaRouter is an OpenAI-compatible gateway built via createOpenAI with
  // name:'orcarouter', so the top-level level resolves through the same openai
  // code path — the level lands as `reasoning_effort`. Unlike requesty, the
  // legal set is none/low/medium/high/xhigh only — 'minimal' is NOT in it and
  // would 400 ("Unknown parameter" on the nested `reasoning:{effort}` block
  // OpenRouter-style gateways send; OrcaRouter expects the flat field). So a
  // suppressed call sends 'none', the only level that both sits in the valid
  // set AND turns thinking off. Reasoning on → undefined (leave the model's
  // default); non-reasoning models ignore the field. (No model-id gate — ids
  // are `vendor/model` or `orcarouter/auto`, and the gateway tolerates the
  // flat field.)
  orcarouter: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? undefined : 'none'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  // Vercel AI Gateway serializes the full call options — including the top-level
  // reasoning level — to the downstream provider, so 'none' suppresses whatever
  // vendor the `provider/model` id resolves to. (The old shape emitted disable
  // blocks for anthropic + deepseek only; this covers google/openai/xai/zai
  // downstreams too.) Gemma downstreams (google/gemma-*) are the exception: they
  // have no thinking mode and 400 on any thinkingConfig ("Thinking budget is not
  // supported for this model", issue #1044), so omit the param for them — the
  // gateway model id carries the `google/gemma-…` prefix, matched here.
  gateway: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ modelId, reasoning, forceNoThink }) =>
      ((reasoning && !forceNoThink) || /(^|\/)gemma-/i.test(modelId) ? undefined : 'none'),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
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

// How many free discovery steps this leg gets before `done` is forced.
//
// The operator's `settings.llm.discoverySteps` wins when set, because the
// descriptor can only know what a PROVIDER generally does — it cannot know which
// model that provider is serving. The two cases the override exists for run in
// opposite directions: a small local model behind an openai-compatible endpoint
// that copes fine with several rounds, and a frontier-provider id that turns out
// to wander when given them. `0` (the default) means "follow the descriptor",
// so an untouched install behaves exactly as if the setting did not exist.
//
// Read off the leg's cfg, not from settings, so this stays a pure function of
// its argument (the whole module's contract) and so the primary and fallback
// legs resolve independently — the fallback may be a different provider running
// a different model, which is the same reason toolChoice and numCtx are per-leg.
//
// Clamped to [MIN, MAX] on both paths, so neither a bad descriptor edit nor a
// hand-edited settings.json can land outside the band — never zero after the
// auto sentinel is resolved (which would force `done` at step 0 and corner the
// model into fabricating an id with an empty `seen` map) and never unbounded.
export function discoveryStepsFor(cfg: any): number {
  const override = cfg?.discoverySteps;
  if (Number.isFinite(override as number) && (override as number) > 0) {
    return clampDiscoverySteps(override as number);
  }
  const declared = capabilitiesFor(cfg?.provider).discoverySteps;
  if (!Number.isFinite(declared as number)) return DISCOVERY_STEPS_MIN;
  return clampDiscoverySteps(declared as number);
}

function clampDiscoverySteps(n: number): number {
  return Math.min(DISCOVERY_STEPS_MAX, Math.max(DISCOVERY_STEPS_MIN, Math.floor(n)));
}

// The tool-loop step cap for a gated discovery run: every discovery step plus
// the ONE forced-done step that follows them. Deriving the cap rather than
// taking the caller's keeps the "exactly one forced-done attempt per run"
// invariant true at any budget — see the discoverySteps note above.
export function gatedMaxStepsFor(cfg: any): number {
  return discoveryStepsFor(cfg) + 1;
}

// The discovery budget actually in force for ONE djAgent run. followProvider
// is the agent's own opt-in (providerDiscoveryBudget on the definition): the
// pick/request agents pass true and follow the descriptor + operator override
// above; every other caller keeps the historical single cornered step. The
// opt-in exists because a caller's pinned step cap can itself be load-bearing
// — the segment director's `maxSteps: 2` (skills/_agent.ts) documents a run
// burning the FULL agentTimeoutMs when its loop silently grew — so the
// per-provider widening reaches only the agents it was designed and tested
// for, never every agent on the provider.
export function runDiscoverySteps(cfg: any, followProvider: boolean): number {
  return followProvider ? discoveryStepsFor(cfg) : DISCOVERY_STEPS_MIN;
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
