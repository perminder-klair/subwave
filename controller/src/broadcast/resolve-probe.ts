// sent means next.txt was written, not that Liquidsoap resolved the URI. Queue membership is
// unreliable during resolution and boundary prefetch; consume explicit per-handoff outcomes.
// Missing outcomes time out open, leaving reconciliation as the backstop. #1405.
export const PUSH_PROBE_INTERVAL_MS = 1_000;
export const PUSH_PROBE_MAX_READS = 60;

// Consecutive resolution failures that may each trigger an immediate re-pick.
// Past it the station coasts on auto.m3u: with a whole origin down every
// re-pick fails the same way and burns LLM budget.
export const MAX_CONSECUTIVE_RESOLVE_FAILURES = 3;

// 'resolved' — proto_subhttp returned a checked audio file.
// 'pending'  — the protocol has not completed yet; probe again.
// 'failed'   — proto_subhttp explicitly rejected or failed the fetch.
// 'abandon'  — nothing left to verify, or the outcome channel is unavailable.
export type ProbeVerdict = 'resolved' | 'pending' | 'failed' | 'abandon';
export type ResolveProbeOutcome = 'ready' | 'failed' | 'pending' | 'unknown';

export function parseResolveProbeOutcome(raw: string | null | undefined): ResolveProbeOutcome {
  const word = (raw ?? '').trim();
  if (word === 'ready' || word === 'failed' || word === 'pending') return word;
  return 'unknown';
}

export function probeVerdict(p: {
  // Still in `upcoming` and still flagged sent: not aired, not cancelled, not
  // already cleared by a reconcile.
  stillQueuedLocally: boolean;
  // Explicit outcome reported by proto_subhttp for this handoff attempt.
  outcome: ResolveProbeOutcome;
}): ProbeVerdict {
  if (!p.stillQueuedLocally) return 'abandon';
  if (p.outcome === 'ready') return 'resolved';
  if (p.outcome === 'failed') return 'failed';
  if (p.outcome === 'unknown') return 'abandon';
  return 'pending';
}

// Whether a confirmed resolution failure may trigger an immediate re-pick.
// `streak` counts failures INCLUDING this one.
export function repickAfterFailure(streak: number): boolean {
  return streak <= MAX_CONSECUTIVE_RESOLVE_FAILURES;
}
