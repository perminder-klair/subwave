// Pure routing from capabilities, output schema and discovery tools. Keep settings
// and SDK imports out so unit tests can detect wrong provider routing without a model.

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
