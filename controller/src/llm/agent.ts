// Public surface for the named-agent factory. Implementation in
// internal/agent-factory.ts. Barrel so call sites keep importing from
// `llm/agent.js` unchanged.

export { defineAgent } from './internal/agent-factory.js';
export type { AgentDefinition, AgentRunResult, DjAgentInstance } from './internal/agent-factory.js';
export { agentWorkActive, interactiveAgentWorkActive } from './agent-activity.js';
export type { AgentActivityPriority } from './agent-activity.js';
