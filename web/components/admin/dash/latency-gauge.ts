import type { HealthStats } from './types';

// The Dash DJ Latency gauge's readings from /stats.
//
// The needle reads p95 over SUCCESSFUL calls only. A failed call's duration is
// how long it took to give up (an agent timeout, a provider's retry budget),
// not how long the DJ takes to answer. On a ring of 20 calls or fewer (just
// after a restart) a single one of them was the all-calls p95 and parked the
// needle on the redline; on a full 120-call ring it took 5% of calls.
//
// The redline sits at the agent deadline so that red means "hitting fallbacks"
// (#392). A successful agent run finishes under the deadline by construction,
// so the needle alone can no longer say that: red is also driven by the calls
// that ran the deadline out (`llm.deadlineHits`).
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

// The share of the ring at the deadline that turns the gauge red: 1 call in 20,
// the share that used to carry the all-calls p95 to the deadline (6 of a full
// 120-call ring, 1 of 20), so red fires where it always did.
const FALLBACK_SHARE_DENOMINATOR = 20;

/** True while enough calls in the ring ran out the agent deadline to call it
 *  "hitting fallbacks". Track Shortlist's redline is its own adaptive warning,
 *  not the deadline, and an older controller sends no count: both stay false. */
export function deadlineFallbacks(stats: HealthStats | null | undefined): boolean {
  if (stats?.trackSelection === 'shortlist') return false;
  const hits = stats?.llm?.deadlineHits ?? 0;
  const total = stats?.llm?.count ?? 0;
  return hits > 0 && hits * FALLBACK_SHARE_DENOMINATOR >= total;
}

export type LatencyZone = 'no data' | 'fallbacks' | 'redline' | 'rising' | 'nominal';

/** The zone label and the warn colour, from the animated needle and the
 *  fallback signal. `fallbacks` wins: it is the failure the redline is for,
 *  and it holds even when no successful call is left to give a reading. */
export function latencyZone({
  latencyMs,
  needleMs,
  redlineMs,
  fallbacks,
}: {
  latencyMs: number | null;
  needleMs: number;
  redlineMs: number;
  fallbacks: boolean;
}): { zone: LatencyZone; warn: boolean } {
  const redlined = needleMs >= redlineMs;
  const warn = redlined || fallbacks;
  if (fallbacks) return { zone: 'fallbacks', warn };
  if (latencyMs == null) return { zone: 'no data', warn };
  if (redlined) return { zone: 'redline', warn };
  return { zone: needleMs > redlineMs * 0.8 ? 'rising' : 'nominal', warn };
}

/** "failed / calls in the log ring", only while the ring holds a failed call.
 *  Gated on okLatency: an older controller's needle still reads every call, so
 *  the note's "successful calls only" would be false there. */
export function failedCallsNote(
  stats: HealthStats | null | undefined,
): { failed: number; total: number; title: string } | null {
  const llm = stats?.llm;
  if (!llm?.okLatency) return null;
  const failed = llm.failed ?? 0;
  const total = llm.count ?? 0;
  if (failed <= 0 || total <= 0) return null;
  const title =
    stats?.trackSelection === 'shortlist'
      ? 'Failed LLM calls / all LLM calls in the log ring: links, segments and requests as well as picks. The needle reads Track Shortlist primary picks only.'
      : `Failed LLM calls / calls in the log ring${llm.deadlineHits ? `, ${llm.deadlineHits} at the agent deadline` : ''}. The needle reads successful calls only; the gauge goes red when 1 call in ${FALLBACK_SHARE_DENOMINATOR} ran out the agent deadline.`;
  return { failed, total, title };
}
