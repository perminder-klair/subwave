// Pure decision logic for the analysis quiet-times gate (#1099). Zero listeners
// for the configured window means the pass may run; any listener pauses it at
// once. The window only gates the occupied -> quiet transition.

export interface QuietState {
  /** Epoch ms when the count first read 0 (or unknown); null while occupied. */
  quietSince: number | null;
}

// `count` is null only on SUSTAINED unreadability (the gated count from
// probeListenerCount(), #1256), never one failed poll. Three branches that must
// not change: fail OPEN on an unknown count (opposite direction from
// djCallsAllowed); an outage still accrues quiet time; any listener resets
// quietSince to null, so the full window must elapse again.
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
