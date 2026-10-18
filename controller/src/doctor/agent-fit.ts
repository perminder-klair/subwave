// Whether a model leg suits the agent tool loop (Agentic Tools picks,
// agent-assisted requests, agentic segments): the three judgements DJ Doc makes
// about the live primary, as pure predicates.
//
// Two callers reach the same decision about different legs: DJ Doc's `context
// window`, `model class` and `agent deadline vs latency` findings judge the
// running primary (checks-station.ts, checks-services.ts), and the swap dialog
// (settings/llm-swap-fit.ts) judges the backup about to replace it. Each
// threshold and formula lives here once, so the incoming primary is held to
// exactly the bar the outgoing one is.
//
// Part of the doctor/ split - see ../doctor.ts for the section runner.

import { classifyModel } from './util.js';

/** Smallest Ollama context window an agent tool loop fits in: the system
 *  prompt, tool definitions and candidates are truncated below it. */
export const AGENT_NUM_CTX_FLOOR = 8192;

/** A model below this many billions of parameters is flagged for Agentic Tools
 *  track selection (it wants a ~12B-class or capable cloud model). */
export const AGENT_PICKS_MIN_SIZE_B = 11;

/** Measured p90 latency at or above this share of the agent deadline warns; at
 *  or above the whole deadline, DJ Doc fails it. */
export const AGENT_DEADLINE_WARN_RATIO = 0.8;

/** Fewest successful timed calls a p90 is taken over. */
export const AGENT_LATENCY_MIN_SAMPLES = 5;

/** The leg's context window when it is too small for an agent tool loop, else
 *  null. Ollama only: the cloud providers size their own, and 0/absent means
 *  the provider default. */
export function contextWindowTooSmall(provider: unknown, numCtx: unknown): number | null {
  if (provider !== 'ollama') return null;
  const nc = Number(numCtx);
  return Number.isFinite(nc) && nc > 0 && nc < AGENT_NUM_CTX_FLOOR ? nc : null;
}

export type ModelClassConcern = { kind: 'code' } | { kind: 'small'; sizeB: number };

/** What the model's NAME suggests about the agent routes (a heuristic, so a
 *  warning at most): a code-specialised model always concerns; a small one only
 *  when track selection runs Agentic Tools. `label` may be a bare model id or a
 *  `provider:model` leg label. */
export function modelClassConcern(label: string, picksAgentic: boolean): ModelClassConcern | null {
  const cls = classifyModel(label);
  if (cls.code) return { kind: 'code' };
  if (cls.sizeB !== null && cls.sizeB < AGENT_PICKS_MIN_SIZE_B && picksAgentic) {
    return { kind: 'small', sizeB: cls.sizeB };
  }
  return null;
}

type TimedCall = { ok?: unknown; ms?: unknown } | null | undefined;

/** p90 latency over the successful timed calls `include` accepts, or null when
 *  there are fewer than AGENT_LATENCY_MIN_SAMPLES of them. */
export function latencyP90<C extends TimedCall>(
  calls: readonly C[],
  include: (c: NonNullable<C>) => boolean = () => true,
): number | null {
  const lat = calls
    .filter((c): c is NonNullable<C> => !!c && c.ok !== false && Number.isFinite(c.ms) && (c.ms as number) > 0 && include(c as NonNullable<C>))
    .map(c => c.ms as number)
    .sort((a, b) => a - b);
  if (lat.length < AGENT_LATENCY_MIN_SAMPLES) return null;
  return lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.9))];
}

/** p90 as a share of the agent deadline, or null when the deadline is unset. */
export function agentDeadlineRatio(p90Ms: number, deadlineMs: unknown): number | null {
  const d = Number(deadlineMs);
  return Number.isFinite(d) && d > 0 ? p90Ms / d : null;
}
