// Explicit caller interruptions are scheduling outcomes, not provider failures.
// Only the research worker creates these reasons; ordinary aborts stay failures.
export type ResearchDeferralReason = 'research-budget' | 'broadcast-priority' | 'station-token-cap';

export class ResearchDeferredError extends Error {
  constructor(readonly reason: ResearchDeferralReason) {
    super(reason === 'station-token-cap' ? 'Research paused by station token budget'
      : reason === 'research-budget' ? 'Research time budget reached' : 'Research yielded to broadcast work');
    this.name = 'ResearchDeferredError';
  }
}

export function researchDeferral(error: unknown, signal?: AbortSignal): ResearchDeferralReason | undefined {
  if (!signal?.aborted || !(signal.reason instanceof ResearchDeferredError)) return undefined;
  // A genuine provider error that races a research interruption remains a failure.
  if ((error as { code?: string } | null)?.code !== 'GENERATION_CANCELLED') return undefined;
  return signal.reason.reason;
}

export function isDeferredLlmCall(call: { outcome?: string }): boolean {
  return call.outcome === 'deferred';
}

export function recentHealthCalls<T extends { outcome?: string }>(calls: T[], limit = 20): T[] {
  return calls.filter(call => !isDeferredLlmCall(call)).slice(0, limit);
}
