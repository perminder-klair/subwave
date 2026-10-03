// Live prompt-context measurements from the controller's in-memory LLM call
// ring. Providers that do not report input usage are shown as unsampled rather
// than estimated: a made-up token figure is worse than an incomplete table.

const SHORTLIST_PICK_KINDS = new Set(['djShortlistPick', 'djShortlistRepick', 'djShortlistLeaningsReview']);
const AGENTIC_PICK_KINDS = new Set(['djAgentPick']);
export const CONTEXT_WINDOW_STEP = 1024;
export const CONTEXT_WINDOW_MIN = 8192;
export const CONTEXT_WINDOW_HEADROOM = 0.25;
export const CONTEXT_WINDOW_RESPONSE_RESERVE = 1024;

function wholePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

function sampledInput(call: any): number | null {
  if (call?.ok !== true) return null;
  // Agent tool loops log billable usage across their steps. Prefer the
  // separately-recorded largest single request when present, because that is
  // what a server's context window needs to hold. Old agent records without
  // this field are left unsampled rather than using their misleading total.
  const measuredPeak = wholePositive(call.contextPeakInput);
  if (measuredPeak != null) return measuredPeak;
  if (typeof call?.via === 'string' && call.via.startsWith('ai-sdk:agent')) return null;
  return wholePositive(call.usage?.input);
}

function contextWindowRecommendation(
  calls: any[],
  kinds: ReadonlySet<string>,
  waitingMessage: string,
  successMessage: string,
) {
  const samples = (Array.isArray(calls) ? calls : [])
    .filter(call => kinds.has(call?.kind))
    .map(sampledInput)
    .filter((tokens): tokens is number => tokens != null);

  if (!samples.length) {
    return {
      samples: 0,
      peakInputTokens: null,
      suggestedTokens: null,
      message: waitingMessage,
    };
  }

  const peakInputTokens = Math.max(...samples);
  const requiredTokens = peakInputTokens * (1 + CONTEXT_WINDOW_HEADROOM)
    + CONTEXT_WINDOW_RESPONSE_RESERVE;
  return {
    samples: samples.length,
    peakInputTokens,
    suggestedTokens: Math.max(
      CONTEXT_WINDOW_MIN,
      Math.ceil(requiredTokens / CONTEXT_WINDOW_STEP) * CONTEXT_WINDOW_STEP,
    ),
    headroomPct: CONTEXT_WINDOW_HEADROOM * 100,
    responseReserveTokens: CONTEXT_WINDOW_RESPONSE_RESERVE,
    message: successMessage,
  };
}

export function shortlistContextWindow(calls: any[]) {
  return contextWindowRecommendation(
    calls,
    SHORTLIST_PICK_KINDS,
    'Waiting for successful shortlist picker calls that report input-token usage.',
    'Based on the largest successful final-picker prompt since this controller started.',
  );
}

export function agenticPickerContextWindow(calls: any[]) {
  return contextWindowRecommendation(
    calls,
    AGENTIC_PICK_KINDS,
    'Waiting for successful Agentic Picker calls with per-step input-token usage.',
    'Based on the largest individual model step from a successful Agentic Picker run since this controller started.',
  );
}

export function contextWindowByKind(calls: any[]) {
  const groups = new Map<string, { kind: string; calls: number; samples: number; inputTokens: number[] }>();
  for (const call of Array.isArray(calls) ? calls : []) {
    const kind = typeof call?.kind === 'string' && call.kind ? call.kind : 'unknown';
    let group = groups.get(kind);
    if (!group) {
      group = { kind, calls: 0, samples: 0, inputTokens: [] };
      groups.set(kind, group);
    }
    group.calls++;
    const inputTokens = sampledInput(call);
    if (inputTokens != null) {
      group.samples++;
      group.inputTokens.push(inputTokens);
    }
  }
  return [...groups.values()]
    .map(group => ({
      kind: group.kind,
      calls: group.calls,
      samples: group.samples,
      averageInputTokens: group.samples
        ? Math.round(group.inputTokens.reduce((total, tokens) => total + tokens, 0) / group.samples)
        : null,
      peakInputTokens: group.samples ? Math.max(...group.inputTokens) : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.kind.localeCompare(b.kind));
}
