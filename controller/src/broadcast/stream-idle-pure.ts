// Pure transition logic for the stream idle monitor, split out so
// scripts/stream-idle.test.ts can pin it without the monitor's heavy imports.

type IdleAction = 'pause' | 'resume' | 'reassert' | null;

export interface IdleState {
  idle: boolean;
  /** Epoch ms when the count first read 0 while live; null once occupied. */
  zeroSince: number | null;
}

// Current state + (toggle, freshest count, clock) → next state and the telnet
// action to fire. `count` null means SUSTAINED unreadability, not one failed
// poll (#1256). The caller commits the returned state only once the telnet call
// succeeds, so a dropped command self-heals next tick.
//
// Regression-critical: fail-OPEN (an unknown count never holds the station
// silent); re-assert idle_on after a mixer restart boots live; the empty clock
// resets the moment anyone (or "unknown") shows up.
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
    // Fail-open: an unknown count can't confirm the room is still empty.
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
