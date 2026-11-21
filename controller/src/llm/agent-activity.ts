// Process-wide activity marker for named agent runs. Background LLM work uses
// this to yield to interactive station decisions without importing picker code.

export type AgentActivityPriority = 'interactive' | 'background';

let activeRuns = 0;
let activeInteractiveRuns = 0;

export function agentWorkActive(): boolean {
  return activeRuns > 0;
}

export function interactiveAgentWorkActive(): boolean {
  return activeInteractiveRuns > 0;
}

export async function withAgentActivity<T>(
  work: () => Promise<T>,
  priority: AgentActivityPriority = 'interactive',
): Promise<T> {
  activeRuns++;
  if (priority === 'interactive') activeInteractiveRuns++;
  try {
    return await work();
  } finally {
    activeRuns--;
    if (priority === 'interactive') activeInteractiveRuns--;
  }
}
