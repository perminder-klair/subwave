// Pure agent-strategy resolver — which structured-output path a leg takes,
// given its provider capabilities, whether a schema is requested, and how many
// discovery tools are available. Kept side-effect-free (only imports the pure
// capabilities lookup) so the unit test can pin the routing table without
// dragging in settings/config/ai — a wiring slip (e.g. Ollama routed to native
// = 0/3 empty) fails an assert before it ever reaches a model.

import { needsToolCallObject } from '../provider/capabilities.js';

export type AgentPlan =
  | 'object-via-tool'   // Ollama, schema, no discovery tools
  | 'native-then-done'  // non-Ollama, schema + tools: native first, fall through
  | 'done-tool'         // Ollama, schema + tools
  | 'native-no-tools'   // non-Ollama, schema, no tools: native Output.object
  | 'free-text';        // no schema

export function agentPlan(cfg: any, schema: any, toolCount: number): AgentPlan {
  if (schema == null) return 'free-text';
  const ollamaish = needsToolCallObject(cfg);
  if (toolCount === 0) return ollamaish ? 'object-via-tool' : 'native-no-tools';
  return ollamaish ? 'done-tool' : 'native-then-done';
}
