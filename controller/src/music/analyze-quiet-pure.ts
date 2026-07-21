// Pure decision logic for the analysis quiet-times gate (#1099) — separate
// file so scripts/analyze-quiet.test.ts can pin it without dragging in the
// analysis pass's heavy imports (library-db → sqlite, analyzer), the same
// split as broadcast/stream-idle-pure.ts.
//
// The gate is the INVERSE of the stream idle monitor: zero listeners for the
// configured window means the analysis pass may run; any listener pauses it
// immediately (freeing the CPU is the whole point — no hysteresis on the way
// down). The window only gates the occupied → quiet transition, so a listener
// blip between polls doesn't let a half-quiet station churn.

export interface QuietState {
  /** Epoch ms when the count first read 0 (or unknown); null while occupied. */
  quietSince: number | null;
}

// Pure transition: previous state + (toggle, freshest count, clock, window) →
// next state and whether the pass may analyse the next track. `count` is null
// when Icecast couldn't be read.
//
// Regression-critical branches:
//   • fail-open — an unknown count must never stall the pass forever (the
//     OPPOSITE direction from djCallsAllowed(): if the stats endpoint is
//     down, odds are nobody is streaming and the CPU is free; worst case is
//     pre-gate behaviour, analysing while someone listens);
//   • an outage still accrues quiet time (quietSince holds), so a recovery
//     at 0 listeners doesn't pause an already-running pass in an empty room;
//   • any listener resets the quiet clock to null — the full window must
//     elapse again after they leave.
export function quietGateDecision(
  prev: QuietState,
  input: { enabled: boolean; count: number | null; now: number; quietAfterMs: number },
): { state: QuietState; proceed: boolean } {
  const { enabled, count, now, quietAfterMs } = input;
  if (!enabled) return { state: { quietSince: null }, proceed: true };
  if (count === null) {
    return { state: { quietSince: prev.quietSince ?? now }, proceed: true };
  }
  if (count > 0) return { state: { quietSince: null }, proceed: false };
  const quietSince = prev.quietSince ?? now;
  return { state: { quietSince }, proceed: now - quietSince >= quietAfterMs };
}
