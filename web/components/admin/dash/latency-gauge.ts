import type { HealthStats } from './types';

// The Dash DJ Latency gauge's two readings from /stats.
//
// The gauge reads p95 over SUCCESSFUL calls only. A failed call's duration is
// how long it took to give up (an agent timeout, a provider's retry budget),
// not how long the DJ takes to answer, and one of them used to hold the gauge
// near the redline for as long as it stayed in the 120-call ring.
//
// Null means "no reading": the strip shows a dash rather than a misleading 0.

export function djLatencyMs(stats: HealthStats | null | undefined): number | null {
  if (stats?.trackSelection === 'shortlist') {
    // Shortlist picks already count only primary (non-failed) picks.
    return stats.shortlist?.count ? (stats.shortlist.latency?.p95 ?? null) : null;
  }
  const llm = stats?.llm;
  if (!llm?.count) return null;
  // An older controller has no okLatency: keep its all-calls reading.
  if (!llm.okLatency) return llm.latency?.p95 ?? null;
  return llm.ok ? (llm.okLatency.p95 ?? null) : null;
}

/** "failed / calls in the log ring", only while the ring holds a failed call. */
export function failedCallsNote(stats: HealthStats | null | undefined): { failed: number; total: number } | null {
  const failed = stats?.llm?.failed ?? 0;
  const total = stats?.llm?.count ?? 0;
  return failed > 0 && total > 0 ? { failed, total } : null;
}
