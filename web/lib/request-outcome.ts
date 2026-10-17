import type { RequestResult } from './types';

// Mirrored into app/src/lib/request-outcome.ts; both players describe the same
// controller outcomes, including older controllers without the outcome field.
export function requestResultLabel(result: Pick<RequestResult, 'pending' | 'outcome' | 'track'>): string {
  if (result.pending) return 'On the wire';
  if (result.outcome === 'cooldown') return 'Played recently';
  if (result.outcome === 'already-queued') return 'Already playing or queued';
  if (result.outcome === 'substituted') return 'Alternative queued';
  return result.track ? 'Queued' : 'Answered';
}

export const REQUEST_POLL_DEADLINE_MS = 9 * 60_000;
export const REQUEST_DELAY_MESSAGE = 'The booth is still looking — you can keep listening while it finishes.';
export const REQUEST_UNCONFIRMED_MESSAGE = 'The booth has not confirmed the result yet. Your request may still be processed.';
export const REQUEST_UNKNOWN_MESSAGE = 'The booth no longer has a result for this request. It may already have been processed.';

export function requestPollPhase(startedAt: number, now: number): 'waiting' | 'delayed' | 'unconfirmed' {
  const elapsed = now - startedAt;
  if (elapsed > REQUEST_POLL_DEADLINE_MS) return 'unconfirmed';
  return elapsed > 60_000 ? 'delayed' : 'waiting';
}
