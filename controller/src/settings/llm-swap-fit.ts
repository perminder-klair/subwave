// "Swap with primary" (llm-swap.ts) promotes the backup leg. The routes that
// run an agent tool loop — track selection, listener-request matching and
// segment delivery — are chosen in Music selection and DJ behaviour, not on the
// LLM page, so a swap can hand them to an engine that does not suit them. This
// module answers "what would the incoming primary trip over?" for the swap
// confirm dialog.
//
// It WARNS, never blocks: the same engine would already take those routes on a
// failover, so refusing the swap would protect nothing. And it judges with the
// checks DJ Doc already applies to the live primary, never new ones — the
// context-window floor, the model-class heuristic, the agent deadline against
// measured latency — plus the provider's tool-calling behaviour from
// capabilities.ts. The output cap (maxOutputTokens) is station-wide and does
// not move with a swap, so it is DJ Doc's to report, not this dialog's.
//
// Pure apart from its inputs: the caller passes the stored llm block and the
// recent call telemetry.
import { settingsAgentRoutes } from '../schemas/settings.js';
import { classifyModel } from '../doctor/util.js';
import { forcedToolChoice, thinkingMandatoryModel } from '../llm/internal/provider/capabilities.js';

/** Smallest Ollama context window an agent tool loop fits in: the system
 *  prompt, tool definitions and candidates are truncated below it. Shared with
 *  DJ Doc's `context window` finding (doctor/checks-station.ts). */
export const AGENT_NUM_CTX_FLOOR = 8192;

/** A model below this many billions of parameters is flagged for Agentic Tools
 *  (DJ Doc's `model class` finding uses the same figure). */
export const AGENT_PICKS_MIN_SIZE_B = 11;

export interface SwapFitWarning {
  /** Short name of the check, e.g. "context window". */
  check: string;
  /** What fails, about the incoming primary, in one sentence. */
  detail: string;
}

export interface SwapFit {
  /** The agentic routes, by their admin names, in display order. */
  agenticRoutes: string[];
  /** The incoming primary, for the dialog's wording. */
  target: { provider: string; model: string };
  warnings: SwapFitWarning[];
}

type Leg = Record<string, unknown> | undefined;
type Call = { ok?: boolean; ms?: number; model?: string } | null | undefined;

/** True when a telemetry row was served by `model` (rows carry either the bare
 *  model id or a leg label that contains it). */
function servedBy(call: Call, model: string): boolean {
  const m = typeof call?.model === 'string' ? call.model : '';
  return !!model && (m === model || m.includes(model));
}

/**
 * What the backup (about to become primary) may not suit, for every agentic
 * route. Empty `warnings` when nothing fails or no route is agentic.
 */
export function llmSwapFit(
  llm: { trackSelection?: unknown; requestMatching?: unknown; segmentRuntime?: unknown; agentTimeoutMs?: unknown; fallback?: Leg } | null | undefined,
  recentCalls: readonly Call[] = [],
): SwapFit {
  const routes = settingsAgentRoutes(llm);
  const agenticRoutes = [
    routes.picks && 'Track selection (Music selection)',
    routes.requests && 'Request matching (Music selection)',
    routes.segments && 'Segment runtime (DJ behaviour)',
  ].filter((r): r is string => !!r);
  const leg = (llm?.fallback ?? {}) as Record<string, unknown>;
  const provider = typeof leg.provider === 'string' ? leg.provider : '';
  const model = typeof leg.model === 'string' ? leg.model : '';
  const out: SwapFit = { agenticRoutes, target: { provider, model }, warnings: [] };
  if (!routes.any) return out;

  // Context window (Ollama only; 0/absent means the provider default).
  const nc = Number(leg.numCtx);
  if (provider === 'ollama' && Number.isFinite(nc) && nc > 0 && nc < AGENT_NUM_CTX_FLOOR) {
    out.warnings.push({
      check: 'context window',
      detail: `its context window is ${nc} tokens, under the ${AGENT_NUM_CTX_FLOOR} an agent tool loop needs, so prompts and tool definitions get truncated`,
    });
  }

  // Model class, by name (a heuristic, as in DJ Doc).
  const cls = classifyModel(model);
  if (cls.code) {
    out.warnings.push({
      check: 'model class',
      detail: `${model} looks code-specialised, which tends to fail structured picks and tool calls`,
    });
  } else if (cls.sizeB !== null && cls.sizeB < AGENT_PICKS_MIN_SIZE_B && routes.picks) {
    out.warnings.push({
      check: 'model class',
      detail: `${model} looks like a ~${cls.sizeB}B model; Agentic Tools track selection wants a ~12B-class or capable cloud model`,
    });
  }

  // Tool calling: the agent loop corners the model with a forced tool. A
  // thinking-mandatory model, or a leg set to toolChoice 'auto', is only asked.
  if (thinkingMandatoryModel(model)) {
    out.warnings.push({
      check: 'tool calling',
      detail: `${model} rejects forced tool calls, so the agent loop can only ask it to call its tools and more runs fall back`,
    });
  } else if (forcedToolChoice(leg) === 'auto') {
    out.warnings.push({
      check: 'tool calling',
      detail: 'this leg sends tool choice "auto", so the agent loop cannot force a tool call and more runs fall back',
    });
  }

  // Agent deadline against what this model has measured (it served calls as
  // the backup). Same p90 and 80 % threshold as DJ Doc.
  const deadlineMs = Number(llm?.agentTimeoutMs);
  const lat = recentCalls
    .filter((c) => c && c.ok !== false && Number.isFinite(c.ms) && (c.ms as number) > 0 && servedBy(c, model))
    .map((c) => c!.ms as number)
    .sort((a, b) => a - b);
  if (lat.length >= 5 && Number.isFinite(deadlineMs) && deadlineMs > 0) {
    const p90 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))];
    if (p90 >= 0.8 * deadlineMs) {
      out.warnings.push({
        check: 'agent deadline',
        detail: `its recent calls ran ${(p90 / 1000).toFixed(1)}s at p90 against the ${Math.round(deadlineMs / 1000)}s agent deadline, so agent runs would time out into their fallbacks`,
      });
    }
  }

  return out;
}
