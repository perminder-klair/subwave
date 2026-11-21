import { researchRunBlockReason } from './research-policy.js';
// The worker gate and the operator explanation read the same live inputs.
import * as settings from '../settings.js';
import { queue } from '../broadcast/queue.js';
import { researchAllowed } from '../broadcast/dj-budget.js';
import { djCallsAllowed, gatedListenerCount } from '../broadcast/listeners.js';
import { interactiveAgentWorkActive } from '../llm/agent.js';

export function researchBlockReason(): string | null {
  const s = settings.get();
  if (!s.djBehaviour.extendedSleeveNotes) return 'disabled';
  if (s.djBehaviour.sleeveNotesCollectionPaused) return 'operator-paused';
  return researchRunBlockReason({
    researchBudgetAllowed: researchAllowed(),
    playbackCriticalBusy: queue.playbackCriticalBusy(),
    agentWorkActive: interactiveAgentWorkActive(),
    djCallsAllowed: djCallsAllowed(),
    pauseWhenEmpty: s.llm.pauseWhenEmpty === true,
    maintenanceWhenEmpty: s.djBehaviour.sleeveNotesMaintenanceWhenEmpty === true,
    listenerCount: gatedListenerCount(),
  });
}
