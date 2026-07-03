// Named-agent factory — bundles an agent's persona, schema, tools, and loop
// limits in one declarable block, then exposes a `.run({ messages, ... })`
// method that resolves the dynamic bits at call time and delegates to djAgent.
//
// Why bother: every djAgent call site used to repeat the same shape —
// build system, build tools, hand both to djAgent with the same schema /
// maxSteps / timeoutMs — and the agent's "spec" was scattered between the
// call site and sdk.js. Pulling it into a single `defineAgent({...})` block
// makes the agent's identity readable in one place, lets tests import the same
// spec constants the live station uses (no drift), and means adding a new agent
// is a declarative block instead of a fresh ad-hoc call.
//
// Persona/tools stay dynamic because both change per call:
//   - buildSystem() resolves the on-air persona at call time (operator may
//     have swapped persona since the module loaded).
//   - buildTools() takes per-call state (recently-played ids, segment cooldown
//     memory, current context) and returns the AI SDK tool set plus an
//     optional `extras` blob the caller needs back (the picker's `seen` map,
//     used to resolve the agent's chosen id to a full song object).

import { djAgent } from './strategy/agent.js';

export interface AgentDefinition {
  kind: string;
  // A function form is resolved at each run, so the schema can follow live
  // state (the picker swaps its transition-field coaching off when the on-air
  // persona isn't in DJ mode) instead of being frozen at module load.
  schema?: any | (() => any);
  buildSystem: (args: any) => string;
  buildTools?: (args: any) => { tools: any; extras?: any };
  maxSteps?: number;
  // A function form is resolved at each run, so the deadline can follow a
  // live setting (settings.llm.agentTimeoutMs) instead of being frozen at
  // module load.
  timeoutMs?: number | (() => number);
  temperature?: number;
  maxOutputTokens?: number;
  // Acceptance check on the native path's object, given this run's buildTools
  // extras (the picker checks its chosen id against the `seen` map). A miss
  // falls the run through to the done-tool harness — see djAgent's validate.
  validateObject?: (object: any, extras: any) => boolean;
}

export interface AgentRunResult {
  object: any;
  steps: number;
  toolCalls: any[];
  extras: any;
}

export interface DjAgentInstance {
  readonly kind: string;
  readonly schema: any;
  readonly maxSteps: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly temperature: number | undefined;
  readonly maxOutputTokens: number | undefined;
  run(args: { messages: any[] } & Record<string, any>): Promise<AgentRunResult>;
}

function resolveTimeout(t: number | (() => number) | undefined): number | undefined {
  return typeof t === 'function' ? t() : t;
}

// Zod schemas are plain objects, so a function here can only be a dynamic
// schema factory — same convention as timeoutMs.
function resolveSchema(s: any | (() => any) | undefined): any {
  return typeof s === 'function' ? s() : s;
}

export function defineAgent(def: AgentDefinition): DjAgentInstance {
  return {
    kind: def.kind,
    // Resolved on read so consumers always see what the next run would use.
    get schema() {
      return resolveSchema(def.schema);
    },
    maxSteps: def.maxSteps,
    // Resolved on read so consumers (picker-test.mjs) always see a number
    // matching what the next run would use.
    get timeoutMs() {
      return resolveTimeout(def.timeoutMs);
    },
    temperature: def.temperature,
    maxOutputTokens: def.maxOutputTokens,
    async run({ messages, ...toolArgs }) {
      const system = def.buildSystem(toolArgs);
      const built = def.buildTools ? def.buildTools(toolArgs) : { tools: undefined, extras: undefined };
      const result = await djAgent({
        system,
        messages,
        tools: built.tools,
        schema: resolveSchema(def.schema),
        maxSteps: def.maxSteps,
        timeoutMs: resolveTimeout(def.timeoutMs),
        temperature: def.temperature,
        maxOutputTokens: def.maxOutputTokens,
        kind: def.kind,
        ...(def.validateObject
          ? { validate: (object: any) => def.validateObject!(object, built.extras) }
          : {}),
      });
      return {
        object: result.object,
        steps: result.steps,
        toolCalls: result.toolCalls,
        extras: built.extras,
      };
    },
  };
}
