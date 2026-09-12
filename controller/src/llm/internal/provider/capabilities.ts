// Per-provider capability descriptors: the single place per-provider quirks
// live, so strategy code has no `provider ===` branches. Translates the
// user-facing `llm.reasoning` toggle into each provider's thinking control and
// declares the structural traits the strategy layer keys off.
//
// Pure — every function is a function of the passed `cfg` only, so the mappings
// are unit-pinned (controller/scripts/llm-pure.test.ts).
//
// Thinking control rides AI SDK 7's top-level `reasoning` call option. Never mix
// it with providerOptions: the SDK does not merge the two and reasoning-related
// providerOptions silently win. Providers with no per-call channel (OpenRouter,
// and the body-injection openai-compatible/locca path) return undefined here and
// keep their construction-time wiring in registry.ts.

interface ThinkingArgs {
  modelId: string;
  reasoning: boolean;
  forceNoThink: boolean;
  // The operator's answer to "is the model behind this leg a reasoning model?"
  // (`llm.reasoningModel`). Deliberately generic rather than azure-shaped: it
  // is a fact about the MODEL, and any provider whose `model` field is an
  // operator-chosen alias rather than a model id needs the same answer. Only
  // the azure descriptor reads it today. Absent = false = pre-existing
  // behaviour, so an upgraded station is byte-identical.
  reasoningModelDeclared?: boolean;
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

// Does this model id name a family that takes reasoning_effort at all?
// gpt-4-class models 400 on receiving ANY effort, so both OpenAI providers gate
// on this before emitting a level. Shared because it is the one part the two
// agree on — see each descriptor for why the LEVELS then differ.
const REASONING_FAMILY_RE = /^(o\d|gpt-5)/i;

// ---------------------------------------------------------------------------
// Azure's request dialect, learned from its own 400s.
//
// A deployment name cannot select the dialect: it is an alias the operator
// chose, so `radio-dj` and `gpt-5.1-chat` are equally uninformative about what
// the endpoint accepts. The operator can DECLARE it (`llm.reasoningModel`, which
// seeds the transport so the first request is already correct), and these
// sniffers are the safety net for when they have not.
//
// Each sniffer reads ONE documented rejection and nothing else — a generic 400
// must keep its normal error path, and no sniffer may infer anything beyond the
// parameter it names.
// ---------------------------------------------------------------------------

function azureErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || !('error' in payload)) return '';
  const error = payload.error;
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  return typeof error.message === 'string' ? error.message : '';
}

export function azureRequiresCompletionTokens(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  return /Unsupported parameter:\s*['"]max_tokens['"]/i.test(message)
    && /Use\s*['"]max_completion_tokens['"]\s*instead/i.test(message);
}

// TWO wordings, because Azure changed the failure mode mid-generation and both
// are documented. The original gpt-5 (2025-08-07) rejected a non-default VALUE
// ("Unsupported value: 'temperature' does not support 0 with this model. Only
// the default (1) value is supported."); the GPT-5.x generation rejects the
// PARAMETER's presence regardless of value ("Unsupported parameter:
// 'temperature' is not supported with this model."). Matching only the first
// left every newer deployment uncorrected — and the fix for both is the same
// one: OMIT the key. Never "fix" the value form by pinning temperature to 1;
// that is exactly the code the parameter form then breaks.
export function azureRequiresDefaultTemperature(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  if (/Unsupported parameter:\s*['"]temperature['"]/i.test(message)) return true;
  return /Unsupported value:\s*['"]temperature['"]/i.test(message)
    && /Only the default\s*\(\s*1\s*\)\s*value is supported/i.test(message);
}

export function azureRejectsTopP(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  if (/Unsupported parameter:\s*['"]top_p['"]/i.test(message)) return true;
  return /Unsupported value:\s*['"]top_p['"]/i.test(message)
    && /Only the default\s*\([^)]*\)\s*value is supported/i.test(message);
}

// A deployment that takes no reasoning_effort at all. Two documented families
// reach this and NEITHER is separable by name: `gpt-5-chat` is not a reasoning
// model and matches every "gpt-5" test, and `o1-mini` supports no effort while
// matching every "o-series" test. Azure answers both with the unknown-argument
// shape rather than an unsupported-parameter one.
export function azureRejectsReasoningEffort(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  return /Unrecognized request argument supplied:\s*reasoning_effort/i.test(message)
    || /Unsupported parameter:\s*['"]reasoning_effort['"]/i.test(message);
}

// A deployment that does not take parallel_tool_calls at all. Every o-series
// model is documented that way, and we send `false` on schema-bearing tool
// requests — so the clamp that protects structured output must be droppable on
// the models that refuse the parameter outright.
export function azureRejectsParallelToolCalls(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  return /Unrecognized request argument supplied:\s*parallel_tool_calls/i.test(message)
    || /Unsupported parameter:\s*['"]parallel_tool_calls['"]/i.test(message);
}

// The opposite correction, and the only one that ADDS a parameter: gpt-5.6 and
// later refuse a tool-bearing Chat Completions request unless reasoning is
// explicitly switched off, and the error names its own fix. It fires even when
// no reasoning_effort was sent, because those deployments default to 'medium'
// — so sending `tools` is enough to trigger it, and an upgrade of an existing
// deployment can start failing a picker loop that worked the day before.
export function azureRequiresNoReasoningEffort(payload: unknown): boolean {
  const message = azureErrorMessage(payload);
  return /Function tools[\s\S]*reasoning_effort[\s\S]*not supported/i.test(message)
    && /set\s+reasoning_effort\s+to\s+['"]?none['"]?/i.test(message);
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
    // permitted while reasoning. The id gate works HERE because the id is a real
    // OpenAI model id; on Azure it is a deployment name and tells you nothing —
    // see the azure descriptor.
    reasoningLevel: ({ modelId, reasoning }) =>
      REASONING_FAMILY_RE.test(modelId)
        ? (reasoning ? 'medium' : /^gpt-5\.\d/i.test(modelId) ? 'none' : 'minimal')
        : undefined,
    discoverySteps: NATIVE_DISCOVERY_STEPS,
  },
  // Azure serves the same model families as `openai` from the operator's own
  // resource over the same wire dialect (@ai-sdk/azure builds an
  // OpenAIChatLanguageModel), so the structural traits are openai's.
  //
  // The reasoning LEVELS are not, and this is the one place azure must not copy
  // openai: the id here is a DEPLOYMENT alias, so it is no evidence about the
  // endpoint's contract. A name test fails in both directions — `gpt-5-chat` is
  // not a reasoning model yet matches every "gpt-5" test (its sibling
  // `gpt-5.1-chat` IS one), `o1-mini` takes no reasoning_effort yet matches
  // every "o-series" test, and a deployment called `dj-brain` in front of gpt-5
  // matches nothing. So the answer comes from the OPERATOR
  // (`llm.reasoningModel`), with `azureRejectsReasoningEffort` in the transport
  // as the net for a wrong one.
  //
  // The level is only ever 'medium', and only to opt IN: suppression OMITS the
  // param and lets the deployment keep its own default, because no floor token
  // holds across deployments — openai's 'none' on a `gpt-5.1-chat` deployment
  // answers "Supported values are: 'medium'", a hard 400 that took the DJ off
  // air mid-segment. Omitting is never rejected, and these families permit
  // forced tools while reasoning, so a deployment that reasons when asked not
  // to costs tokens while one that 400s costs the broadcast. The one case that
  // does need 'none' on the wire (gpt-5.6+ refusing a tool-bearing request)
  // arrives as its own error naming its own fix, so it is learned in the
  // transport rather than guessed here.
  azure: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ reasoning, reasoningModelDeclared }) =>
      (reasoning && reasoningModelDeclared === true ? 'medium' : undefined),
    discoverySteps: NATIVE_DISCOVERY_STEPS,
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
  },
  locca: {
    objectStrategy: 'tool',
    repeatPenaltyApplies: false,
    samplingViaBody: true,
    reasoningLevel: NONE,
  },
  anthropic: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    // Extended thinking is off by default; 'medium' opts in. 'none' is required
    // on forced-tool legs because Claude rejects toolChoice while thinking.
    reasoningLevel: ({ reasoning, forceNoThink }) =>
      (reasoning && !forceNoThink ? 'medium' : 'none'),
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
  },
  // The gateway serializes the top-level level to whatever vendor the
  // `provider/model` id resolves to. Gemma downstreams are the exception, same
  // 400 as the google entry (#1044), so omit the param for them.
  gateway: {
    objectStrategy: 'native',
    repeatPenaltyApplies: false,
    reasoningLevel: ({ modelId, reasoning, forceNoThink }) =>
      ((reasoning && !forceNoThink) || /(^|\/)gemma-/i.test(modelId) ? undefined : 'none'),
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

// True when the active provider needs the tool-call structured-output path.
export function needsToolCallObject(cfg: any): boolean {
  return capabilitiesFor(cfg?.provider).objectStrategy === 'tool';
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
  const declared = capabilitiesFor(cfg?.provider).discoverySteps;
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
export function forcedToolChoice(cfg: any): 'required' | 'auto' {
  return cfg?.toolChoice === 'auto' ? 'auto' : 'required';
}

// Gates the sampling log so /debug doesn't claim a repeat_penalty was applied
// when the provider dropped it. Currently false everywhere; kept as the
// chokepoint for when the Ollama per-call channel is restored.
export function repeatPenaltyApplies(cfg: any): boolean {
  return capabilitiesFor(cfg?.provider).repeatPenaltyApplies;
}

// The repeat_penalty a body-injection provider will send this leg, or null.
// llama.cpp defaults to 1.0 = OFF, so without this the configured floor is
// dropped and the tool-loop agent can run away repeating a token block until the
// output cap, never emitting `done`. 1.0 or below is a no-op and is skipped.
export function appliedRepeatPenalty(cfg: any): number | null {
  if (!capabilitiesFor(cfg?.provider).samplingViaBody) return null;
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
  return capabilitiesFor(cfg?.provider).reasoningLevel({
    modelId: cfg?.model || '',
    reasoning: cfg?.reasoning === true,
    forceNoThink,
    // Read off the LEG's cfg, like discoverySteps/toolChoice — never from
    // settings — so this module stays a pure function of its argument.
    reasoningModelDeclared: cfg?.reasoningModel === true,
  });
}
