// Agent circuit breaker. A model that can't drive the done-tool harness fails
// EVERY agent run at the cost of a full agent deadline, so consecutive
// failures drop picks and request matching to their stateless fallbacks for a
// cooldown. Any agent success closes it. Module-level: one station, one model
// config at a time.

import * as settings from '../../settings.js';
import { logEvent } from '../../observability/events.js';

const BREAKER_FAILURES = 3;
const BREAKER_COOLDOWN_MS = 10 * 60_000;
let breakerFails = 0;
let breakerOpenUntil = 0;

// How long a rolled-but-unaired mic-pass stays worth airing. Mirrors queue.ts's
// PENDING_VOICE_MAX_AGE_MS: the script bakes in a moment, so a late one misreads.
export const HANDOFF_MAX_AGE_MS = 20 * 60_000;

export function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}

export function breakerSuccess() {
  breakerFails = 0;
}

export function breakerFailure(queue: any) {
  breakerFails++;
  if (breakerFails < BREAKER_FAILURES) return;
  breakerFails = 0;
  breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
  queue.log('picker', `agent picks failed ${BREAKER_FAILURES}× in a row — using the stateless fallbacks for ${Math.round(BREAKER_COOLDOWN_MS / 60_000)} min (the configured model may not handle tool calls; see /admin/debug and consider switching model)`);
  logEvent('pick.breaker', { failures: BREAKER_FAILURES, cooldownMs: BREAKER_COOLDOWN_MS });
}

// Hard timeout for an agent run, from settings.llm.agentTimeoutMs (default
// 45s). Enforced by runDeadlined in agent.ts as ONE shared budget across the
// native run, main run and both recovery attempts, so worst case per agent
// call is this value, not a multiple of it (#352).
export function agentDeadline(): number {
  return settings.get().llm?.agentTimeoutMs ?? 45000;
}


