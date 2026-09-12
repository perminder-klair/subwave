// A context-window recommendation from the real final-picker prompts observed
// since this controller started. It deliberately has no persistence: a changed
// shortlist configuration, model, or station setup needs fresh evidence.

const PICK_KINDS = new Set(['djShortlistPick', 'djShortlistRepick']);
export const CONTEXT_WINDOW_STEP = 1024;
export const CONTEXT_WINDOW_MIN = 8192;
export const CONTEXT_WINDOW_HEADROOM = 0.25;
export const CONTEXT_WINDOW_RESPONSE_RESERVE = 1024;

function wholePositive(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

export function shortlistContextWindow(calls: any[]) {
  const samples = (Array.isArray(calls) ? calls : [])
    .filter(call => call?.ok === true && PICK_KINDS.has(call.kind))
    .map(call => wholePositive(call.usage?.input))
    .filter((tokens): tokens is number => tokens != null);

  if (!samples.length) {
    return {
      samples: 0,
      peakInputTokens: null,
      suggestedTokens: null,
      message: 'Waiting for successful shortlist picker calls that report input-token usage.',
    };
  }

  const peakInputTokens = Math.max(...samples);
  const requiredTokens = peakInputTokens * (1 + CONTEXT_WINDOW_HEADROOM)
    + CONTEXT_WINDOW_RESPONSE_RESERVE;
  const suggestedTokens = Math.max(
    CONTEXT_WINDOW_MIN,
    Math.ceil(requiredTokens / CONTEXT_WINDOW_STEP) * CONTEXT_WINDOW_STEP,
  );

  return {
    samples: samples.length,
    peakInputTokens,
    suggestedTokens,
    headroomPct: CONTEXT_WINDOW_HEADROOM * 100,
    responseReserveTokens: CONTEXT_WINDOW_RESPONSE_RESERVE,
    message: 'Based on the largest successful final-picker prompt since this controller started.',
  };
}
