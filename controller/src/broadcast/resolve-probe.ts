// Push-resolution probe policy (#1405): a pick handed to Liquidsoap that never
// became a playable request. `sent` only means the URI reached next.txt, and a
// silently unresolved push leaves the station on the unfiltered auto playlist
// until the reconcile sweep notices (~3 auto tracks).
//
// Queue membership cannot answer this — dj_queue holds idle/resolving requests
// and omits a healthy one during boundary prefetch — so proto_subhttp records
// an explicit per-handoff outcome consumed over telnet. Pure and I/O-free.

// Poll long enough for a slow whole-file fetch. With no explicit outcome (old
// broadcast image, local URI, mixer restart) the loop expires fail-OPEN and the
// reconcile sweep stays the backstop.
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
