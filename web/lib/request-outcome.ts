// SOURCE OF TRUTH: web/lib/request-outcome.ts — mirrored byte for byte into
// app/src/lib/request-outcome.ts (app/scripts/request-outcome.test.ts keeps
// the copies identical). Both players describe the same controller outcomes,
// including older controllers without the outcome field.
import type { RequestResult } from './types';

// The controller refused to queue the track it names: it played recently, or
// it is already playing or queued.
export function isRefusedOutcome(outcome: string | null | undefined): boolean {
  return outcome === 'cooldown' || outcome === 'already-queued';
}

export function requestResultLabel(result: Pick<RequestResult, 'pending' | 'outcome' | 'track'>): string {
  if (result.pending) return 'On the wire';
  if (result.outcome === 'cooldown') return 'Played recently';
  if (result.outcome === 'already-queued') return 'Already playing or queued';
  if (result.outcome === 'substituted') return 'Alternative queued';
  return result.track ? 'Queued' : 'Answered';
}
