export interface ResearchRunPolicyInput {
  playbackCriticalBusy: boolean;
  agentWorkActive: boolean;
  djCallsAllowed: boolean;
  pauseWhenEmpty: boolean;
  maintenanceWhenEmpty: boolean;
  listenerCount: number | null;
  researchBudgetAllowed?: boolean;
}

/**
 * Sleeve Notes research is normally subject to the DJ's listener-aware LLM
 * gate. An operator may explicitly permit this non-airing maintenance work
 * while Icecast has confirmed that the station is empty; unknown counts stay
 * on the normal fail-open DJ path and never activate the maintenance exception.
 */
export function researchRunBlockReason(
  input: ResearchRunPolicyInput,
): 'token-budget' | 'broadcast' | 'interactive' | 'listeners' | null {
  if (input.researchBudgetAllowed === false) return 'token-budget';
  if (input.playbackCriticalBusy) return 'broadcast';
  if (input.agentWorkActive) return 'interactive';
  if (
    input.djCallsAllowed ||
    (input.pauseWhenEmpty && input.maintenanceWhenEmpty && input.listenerCount === 0)
  )
    return null;
  return 'listeners';
}

export function researchRunAllowed(input: ResearchRunPolicyInput): boolean {
  return researchRunBlockReason(input) === null;
}
