// "Swap with primary" (llm-swap.ts) promotes the backup leg. The routes that
// run an agent tool loop — track selection, listener-request matching and
// segment delivery — are chosen in Music selection and DJ behaviour, not on the
// LLM page, so a swap can hand them to an engine that does not suit them. This
// module answers "what would the incoming primary trip over?" for the swap
// confirm dialog.
//
// It WARNS, never blocks: the same engine would already take those routes on a
// failover, so refusing the swap would protect nothing. And it judges with
// exactly the checks DJ Doc applies to the live primary — the context-window
// floor, the model-class heuristic, the agent deadline against measured
// latency — through the shared predicates in doctor/agent-fit.ts, so the
// incoming primary is held to the outgoing one's bar and the two cannot drift.
// Nothing here is a judgement DJ Doc does not also make. The output cap
// (maxOutputTokens) is station-wide and does not move with a swap, so it is DJ
// Doc's to report, not this dialog's.
//
// Pure apart from its inputs: the caller passes the stored llm block, the
// recent call telemetry and the two legs' telemetry labels (llm/provider.js
// legLabel()).
import { settingsAgentRoutes } from '../schemas/settings.js';
import {
  AGENT_DEADLINE_WARN_RATIO, AGENT_NUM_CTX_FLOOR,
  agentDeadlineRatio, contextWindowTooSmall, latencyP90, modelClassConcern,
} from '../doctor/agent-fit.js';

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

/** The `provider:modelId` each leg's telemetry rows carry (legLabel()). */
export interface SwapFitLabels {
  backup?: string;
  primary?: string;
}

type Leg = Record<string, unknown> | undefined;
type Call = { ok?: boolean; ms?: number; model?: string } | null | undefined;

const UNSET = ':(unset)';

/**
 * What the backup (about to become primary) may not suit, for every agentic
 * route. Empty `warnings` when nothing fails or no route is agentic.
 */
export function llmSwapFit(
  llm: { trackSelection?: unknown; requestMatching?: unknown; segmentRuntime?: unknown; agentTimeoutMs?: unknown; fallback?: Leg } | null | undefined,
  recentCalls: readonly Call[] = [],
  labels: SwapFitLabels = {},
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

  // The resolved label names a blank-model leg (an Ollama leg on
  // config.ollama.model) the way its calls do; DJ Doc classifies the live
  // primary by its label too.
  const backupLabel = labels.backup && !labels.backup.endsWith(UNSET) ? labels.backup : '';
  const shown = model || (backupLabel.startsWith(`${provider}:`) ? backupLabel.slice(provider.length + 1) : '');

  const nc = contextWindowTooSmall(provider, leg.numCtx);
  if (nc !== null) {
    out.warnings.push({
      check: 'context window',
      detail: `its context window is ${nc} tokens, under the ${AGENT_NUM_CTX_FLOOR} an agent tool loop needs, so prompts and tool definitions get truncated`,
    });
  }

  const concern = modelClassConcern(backupLabel || model, routes.picks);
  if (concern?.kind === 'code') {
    out.warnings.push({
      check: 'model class',
      detail: `${shown} looks code-specialised, which tends to fail structured picks and tool calls`,
    });
  } else if (concern?.kind === 'small') {
    out.warnings.push({
      check: 'model class',
      detail: `${shown} looks like a ~${concern.sizeB}B model; Agentic Tools track selection wants a ~12B-class or capable cloud model`,
    });
  }

  // Agent deadline against what this leg has measured while it served calls as
  // the backup. Rows carry only the leg LABEL, so they are matched to it
  // exactly (a substring would also count `gpt-5-mini` rows as `gpt-5`'s), and
  // when both legs share one label (the same model on two hosts) no row can be
  // told apart: the check stays silent rather than charge the primary's
  // latency to the backup.
  if (backupLabel && backupLabel !== labels.primary) {
    const p90 = latencyP90(recentCalls, c => c.model === backupLabel);
    const ratio = p90 === null ? null : agentDeadlineRatio(p90, llm?.agentTimeoutMs);
    if (p90 !== null && ratio !== null && ratio >= AGENT_DEADLINE_WARN_RATIO) {
      out.warnings.push({
        check: 'agent deadline',
        detail: `its recent calls ran ${(p90 / 1000).toFixed(1)}s at p90 against the ${Math.round(Number(llm?.agentTimeoutMs) / 1000)}s agent deadline, so agent runs would time out into their fallbacks`,
      });
    }
  }

  return out;
}
