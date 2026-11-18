// The reasoning level an LLM leg can ask for while `llm.reasoning` is on
// (#2296), and the one predicate that says which legs can express a level.
// Both sides read this: the controller's capability descriptors
// (llm/internal/provider/capabilities.ts) and the admin form's picker, through
// the web/lib/schemas.generated.ts mirror, so the picker is shown exactly where
// the controller would send the level. Mirrored by `npm run gen:schemas`, so it
// imports nothing.
//
// 'default' is today's "On": what the call sends is decided by the descriptor
// alone, as before the field existed, on every provider but one. The
// announced exception (#2357) is a native-Anthropic, manual-thinking Claude
// model, whose Default is a fixed MANUAL_THINKING_DEFAULT_BUDGET rather than
// the SDK's medium. A level is only ever read while reasoning is on, and only
// on a leg reasoningEffortOffered() accepts; anywhere else it is kept in
// settings but sends nothing, so a saved level survives a provider switch and
// back.

export const REASONING_EFFORTS = ['default', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v);
}

/** Stored value → a level. Absent or unknown is 'default' (today's "On"). */
export function normalizeReasoningEffort(v: unknown): ReasoningEffort {
  return isReasoningEffort(v) ? v : 'default';
}

// Fixed thinking budgets for a manual-thinking Claude model (below), per level.
// The SDK's own levels are a share of the model's max output (medium is 19,200
// tokens on a 64k model, 9,600 on Opus 4/4.1) — far beyond a ~150-token DJ
// line — so a level the operator picks is a small fixed budget instead
// (LiteLLM uses the same scale).
export const MANUAL_THINKING_BUDGETS = { low: 1024, medium: 2048, high: 4096 } as const;

// What 'default' sends on a manual-thinking Claude model: Low's budget, the
// API minimum. Until #2357 Default kept the SDK's medium (above); lowering it
// is an announced exception to "an upgrade is byte-identical" (root
// CLAUDE.md), applying to a stored "On" from before the field too.
export const MANUAL_THINKING_DEFAULT_BUDGET = MANUAL_THINKING_BUDGETS.low;

// A Claude model id, served only by Anthropic or a proxy/gateway in front of it.
const CLAUDE_MODEL_RE = /(?:^|\/)claude-/i;
export function claudeModelId(modelId: unknown): boolean {
  return CLAUDE_MODEL_RE.test(String(modelId || ''));
}

// Gemma has no thinking mode; any reasoning field 400s it (#1044).
const GEMMA_MODEL_RE = /(^|\/)gemma-/i;
export function gemmaModelId(modelId: unknown): boolean {
  return GEMMA_MODEL_RE.test(String(modelId || ''));
}

// OpenAI ids that take reasoning_effort; gpt-4-class models 400 on any effort.
const OPENAI_REASONING_MODEL_RE = /^(o\d|gpt-5)/i;
export function openaiReasoningModelId(modelId: unknown): boolean {
  return OPENAI_REASONING_MODEL_RE.test(String(modelId || ''));
}

/**
 * The SDK's max output for a Claude id that thinks on a manual budget
 * (`supportsAdaptiveThinking: false` in @ai-sdk/anthropic's
 * getModelCapabilities), or null for an adaptive id. Mirrors the SDK's checks
 * in its order, so an id it treats as adaptive is never sent a budget (4.7+
 * answer one with a 400), and any unknown `claude-*` id counts as adaptive, as
 * the SDK does. A non-Claude id is null.
 */
export function manualThinkingClaudeMaxOutput(modelId: unknown): number | null {
  const id = String(modelId || '');
  if (!id.includes('claude-')) return null;
  if (/claude-(?:sonnet-5|opus-5|fable-5|opus-4-8|opus-4-7|sonnet-4-6|opus-4-6)/.test(id)) return null;
  if (/claude-(?:sonnet-4-5|opus-4-5|haiku-4-5)/.test(id)) return 64000;
  if (id.includes('claude-opus-4-1')) return 32000;
  if (/claude-sonnet-4(?:-|@)/.test(id)) return 64000;
  if (/claude-opus-4(?:-|@)/.test(id)) return 32000;
  if (id.includes('claude-3-haiku')) return 4096;
  if (/claude-(?:instant(?:-|$)|v?2(?=$|[-.:])|3(?=$|[-.]))/.test(id)) return 4096;
  return null;
}

export function manualThinkingClaudeModel(modelId: unknown): boolean {
  return manualThinkingClaudeMaxOutput(modelId) != null;
}

/**
 * The thinking budget 'default' sends on a manual-thinking Claude model
 * (MANUAL_THINKING_DEFAULT_BUDGET), for the picker's hint. null for any other
 * id, where Default sends no budget of SUB/WAVE's own.
 */
export function manualThinkingDefaultBudget(modelId: unknown): number | null {
  return manualThinkingClaudeModel(modelId) ? MANUAL_THINKING_DEFAULT_BUDGET : null;
}

export interface ReasoningEffortLeg {
  provider?: unknown;
  model?: unknown;
  compatibleMode?: unknown;
}

/**
 * True when this leg can send a reasoning level, so the picker is shown and
 * the descriptor reads it. `gatewayRule` is the catalogue's reasoning rule for
 * a fixed-endpoint OpenAI-compatible gateway (Requesty and the like), looked up
 * by the caller, since this module imports nothing.
 *
 * Not offered, where there is no portable level: Ollama (a level string 400s
 * boolean-only models), local OpenAI-compatible and locca (llama.cpp/vLLM read
 * chat_template_kwargs), a hosted OpenAI-compatible server that isn't a Claude
 * proxy (its own thinking fields go in Request parameters, #2355), Gemma, and
 * gpt-4-class OpenAI ids.
 */
export function reasoningEffortOffered(leg: ReasoningEffortLeg | null | undefined, gatewayRule?: string): boolean {
  const provider = String(leg?.provider || '');
  const model = leg?.model;
  switch (provider) {
    case 'anthropic':
    case 'deepseek':
    case 'openrouter':
      return true;
    case 'openai':
      return openaiReasoningModelId(model);
    case 'google':
    case 'gateway':
      return !gemmaModelId(model);
    case 'openai-compatible':
      return leg?.compatibleMode === 'hosted' && claudeModelId(model);
    case 'ollama':
    case 'locca':
      return false;
    default:
      if (gatewayRule === 'openaiModels') return openaiReasoningModelId(model);
      if (gatewayRule === 'minimalWhenOff') return true;
      if (gatewayRule === 'vendorRouted') return !gemmaModelId(model);
      return false;
  }
}
