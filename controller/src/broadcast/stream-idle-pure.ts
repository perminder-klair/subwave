// Pure transition logic for the stream idle monitor (stream-idle.ts) —
// separate file so scripts/stream-idle.test.ts can pin it without dragging
// in the monitor's heavy imports (queue.ts → llm/tts/subsonic), same split
// as programme-pure.ts.

export type IdleAction = 'pause' | 'resume' | 'reassert' | null;

export interface IdleState {
  idle: boolean;
  /** Epoch ms when the count first read 0 while live; null once occupied. */
  zeroSince: number | null;
}

// Pure transition: current state + (toggle, freshest count, clock) → next
// state and the telnet action to fire. `count` is null when Icecast couldn't
// be read. The caller only commits the returned state once the action's
// telnet call succeeds, so a dropped command self-heals on the next tick.
//
// Regression-critical branches:
//   • fail-open — an unknown count can never hold the station silent;
//   • reassert — a mixer restart mid-pause always boots live, so the monitor
//     re-sends idle_on (idempotent) while the room stays empty;
//   • the empty clock resets the moment anyone (or "unknown") shows up, so a
//     brief zero blip between listeners never accumulates toward a pause.
export function nextIdleState(
  prev: IdleState,
  input: { enabled: boolean; count: number | null; now: number; idleAfterMs: number },
): { state: IdleState; action: IdleAction } {
  const { enabled, count, now, idleAfterMs } = input;
  if (!enabled) {
    // Toggle off: make sure the gate is down if we raised it, then stand by.
    return { state: { idle: false, zeroSince: null }, action: prev.idle ? 'resume' : null };
  }
  if (prev.idle) {
    // Fail-open: an unknown count can't confirm the room is still empty —
    // resume rather than hold a stream we can't observe.
    if (count === null || count > 0) {
      return { state: { idle: false, zeroSince: null }, action: 'resume' };
    }
    return { state: prev, action: 'reassert' };
  }
  if (count === 0) {
    const zeroSince = prev.zeroSince ?? now;
    if (now - zeroSince >= idleAfterMs) {
      return { state: { idle: true, zeroSince: null }, action: 'pause' };
    }
    return { state: { idle: false, zeroSince }, action: null };
  }
  // Occupied (or unknown) — reset the empty clock.
  return { state: { idle: false, zeroSince: null }, action: null };
}
