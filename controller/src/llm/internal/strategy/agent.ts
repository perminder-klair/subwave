// djAgent — conversational tool-loop with structured output. Throws on failure
// so the caller can fall back to a stateless path.
//
// Strategy, resolved per leg by agentPlan():
//   1. Native-first (non-Ollama tool-using agents): Output.object with AUTO
//      tool_choice, so no forced tool conflicts with thinking mode. Any miss
//      falls through to (2).
//   2. Done-tool (Ollama always; everyone else on a native miss): a synthetic
//      `done` tool whose inputSchema IS the schema sits beside the discovery
//      tools, toolChoice:'required' forces a call every step, and prepareStep
//      corners the model into discovery-then-done. Ollama is excluded from
//      native because its tool-loop Output.object returns schema-valid but
//      EMPTY JSON without ever calling discovery.
//
// When the model declines `done` anyway: main run → done-only recovery
// (carrying the trail) → single-turn terminal collapse (#1157) → text salvage →
// throw. Every leg draws on ONE shared deadline, so the leg count is a budget
// decision as much as a correctness one.

import { Output, isStepCount, hasToolCall, ToolLoopAgent, tool } from 'ai';
import type { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';
import { withFailover } from '../core/failover.js';
import { withTransientRetry, withDeadline } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, perfOf, warningsOf, flattenToolCalls, failureDiagnostics, renderTerminalPrompt } from '../core/pure.js';
import type { StepLike, ToolCallLike, ToolCallSummary, TokenUsage } from '../core/pure.js';
import { needsToolCallObject, reasoningFor, samplingWithLocalKnobs, forcedToolChoice, runDiscoverySteps } from '../provider/capabilities.js';
import type { Leg } from '../provider/legs.js';
import { objectViaToolCall } from './object-via-tool.js';
import { agentPlan } from './plan.js';
import { resolveMaxOutputTokens } from '../../../settings.js';
import { recordAgentRetry } from '../telemetry/log.js';

// Loose views of an AI SDK ToolLoopAgent generate result — only the fields the
// cascade reads. `AgentLike` is the minimal surface runDeadlined needs.
interface AgentGenerateResult {
  output?: unknown;
  text: string;
  finishReason?: unknown;
  usage?: TokenUsage;
  totalUsage?: TokenUsage;
  steps?: StepLike[];
  staticToolCalls?: ToolCallLike[];
  response?: { messages?: ModelMessage[] };
}
interface AgentLike {
  generate(options: { messages: ModelMessage[]; abortSignal?: AbortSignal }): Promise<AgentGenerateResult>;
}

interface AgentFailureError extends Error {
  text?: string;
  finishReason?: unknown;
  usage?: unknown;
  steps?: unknown;
}
interface DjAgentOptions {
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  schema?: z.ZodTypeAny;
  maxSteps?: number;
  temperature?: number;
  maxOutputTokens?: number;
  kind?: string;
  timeoutMs?: number;
  validate?: (object: unknown) => boolean;
  // Follow the leg's per-provider discovery budget instead of the pinned single
  // historical step. Opt-in per agent, OFF by default: a caller's step cap can
  // be load-bearing, so only pick/request ask for it.
  providerDiscoveryBudget?: boolean;
}

// Operator-overridable via settings.llm.maxOutputTokens (#712); 0 keeps this
// default. Threaded down to objectViaToolCall and the ToolLoopAgent so the cap
// is uniform across sub-paths.
const MAX_TOKENS_AGENT = 8000;

// Per-tool execution timeout on the tool-running agents, so a hung discovery
// call can't burn the whole shared deadline. The SDK aborts the tool and feeds
// the model a tool-error result, so the loop keeps moving and no throw reaches
// the transient/failover classifiers. Segment tools keep their own 8s internal
// timeout; this is the backstop above it.
const TOOL_TIMEOUT_MS = 10_000;

// prepareStep pins activeTools so every step is a cornered single-purpose
// request: below the commit point discovery only, at or past it `done` only.
// Restricting activeTools at the request level is the only lever cloud Ollama
// models honour — they ignore a plain toolChoice:'required' with several tools
// visible and emit prose instead.
//
// The commit point is runDiscoverySteps(leg.cfg, providerDiscoveryBudget). On
// every forced-tool provider it still resolves to 1, leaving no free middle
// step. Do NOT re-widen forced-tool providers here — provider/capabilities.ts
// is the one place that decision lives. The step cap is DERIVED (budget + 1),
// so the run always makes exactly ONE forced `done` attempt before recovery;
// extra `done` steps on a polluted trail make compliance worse, not better.

function buildDoneTool(schema: z.ZodTypeAny) {
  return tool({
    description: 'Call this exactly once when you have your final answer. Pass the answer as input. Calling this tool IS how you respond — do not emit text after.',
    inputSchema: schema,
  });
}

// Steps below `commitAfter` force a discovery tool — never `done` — so the model
// can't commit a hallucinated id before seeing library results; at or past it
// only `done` is active, guaranteeing a call before the step cap. `toolChoice`
// is the leg's forced value ('required', or 'auto' when the operator downgrades
// it for a crash-prone server, #570); the activeTools pinning holds either way.
function gatedDiscoveryPrepareStep(discoveryToolNames: string[], toolChoice: 'required' | 'auto', commitAfter: number) {
  return async ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber >= commitAfter) {
      return { activeTools: ['done'], toolChoice };
    }
    return { activeTools: discoveryToolNames, toolChoice };
  };
}

// The done-only recovery agent: one re-run of the loop with `done` as the only
// legal move, fed the failed run's discovery trail. The attempt after this one
// leaves the loop behind entirely (renderTerminalPrompt + objectViaToolCall).
function buildRecoveryAgent(leg: Leg, system: string, allTools: ToolSet | undefined, temperature: number, maxOutputTokens: number, forcedChoice: 'required' | 'auto') {
  return new ToolLoopAgent({
    // Recovery forces done-only every step → no-think model (see above).
    model: leg.noThinkModel ?? leg.model,
    // An explicit terminal instruction for gemma-class models that emit prose
    // instead of obeying toolChoice:'required' (#555). It goes in
    // `instructions`, not a trailing user turn, so it can't create two
    // consecutive user messages and trip providers requiring strict role
    // alternation.
    instructions: `${system}\n\nYou now have everything you need. Respond ONLY by calling the \`done\` tool with your final answer — do not write a normal text message.`,
    tools: allTools,
    stopWhen: [isStepCount(2), hasToolCall('done')],
    temperature,
    maxOutputTokens,
    // Recovery forces done-only every step, so it has the same
    // Anthropic/DeepSeek thinking conflict as the main run — suppress here too.
    reasoning: reasoningFor(leg.cfg, { forceNoThink: true }),
    toolChoice: forcedChoice,
    prepareStep: async () => ({ activeTools: ['done'], toolChoice: forcedChoice }),
  } as any);
}

// withDeadline + withTransientRetry around one agent.generate(). The `timeout`
// generate option is not honoured by the ai-sdk-ollama transport, so the
// wall-clock ceiling is enforced here; the abort signal is forwarded so
// transports that do support cancellation stop the request server-side.
//
// `deadlineAt` is a SHARED absolute timestamp, not a fresh duration per call:
// every attempt for one pick draws down the same budget, so a slow main run
// leaves less time for recovery instead of resetting the clock. undefined means
// no deadline.
function runDeadlinedCall<T>(deadlineAt: number | undefined, kind: string, label: string, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (deadlineAt == null) {
    return withTransientRetry(kind, () => fn());
  }
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    const err = new Error(`${kind} ${label} — no time left on the shared deadline`);
    err.name = 'AgentDeadlineError';
    return Promise.reject(err);
  }
  return withDeadline(remaining, `${kind} ${label}`, (signal) =>
    withTransientRetry(kind, () => fn(signal), signal));
}

function runDeadlined(deadlineAt: number | undefined, kind: string, label: string, agent: AgentLike, messages: ModelMessage[]): Promise<AgentGenerateResult> {
  return runDeadlinedCall(deadlineAt, kind, label, (signal) => agent.generate({
    messages,
    ...(signal ? { abortSignal: signal } : {}),
  }));
}

export async function djAgent({
  system,
  messages,
  tools,
  schema,
  maxSteps = 8,
  temperature = 0.6,
  maxOutputTokens = resolveMaxOutputTokens(MAX_TOKENS_AGENT),
  kind = 'sdk.djAgent',
  timeoutMs,
  providerDiscoveryBudget = false,
  // Caller acceptance check on the NATIVE path's object only — that branch
  // validates schema shape, not content, so a fabricated-but-well-formed answer
  // would otherwise sail through. A miss falls through to the done-tool path.
  // Not applied to done-tool/recovery results: the caller repairs those itself
  // with the full `seen` context.
  validate,
}: DjAgentOptions): Promise<{ object: unknown; steps: number; toolCalls: ToolCallSummary[] }> {
  return withFailover(
    kind,
    (err) => ({ system, messages, ...failureDiagnostics(err) }),
    async (leg: Leg) => {
      const toolCount = tools ? Object.keys(tools).length : 0;
      const plan = agentPlan(leg.cfg, schema, toolCount);
      // The opt-in is the caller's; the budget is read off the LEG, so a
      // failover to a backup on a different provider re-resolves it.
      const discoverySteps = runDiscoverySteps(leg.cfg, providerDiscoveryBudget);
      const gatedMaxSteps = discoverySteps + 1;
      // Branches override before their await, so a failure record always
      // attributes to the path actually attempted.
      let lastVia = 'ai-sdk:agent';
      // One shared wall-clock ceiling for every attempt below.
      const deadlineAt = timeoutMs ? Date.now() + timeoutMs : undefined;
      try {
        // No discovery tools + a model that ignores JSON mode: no loop to run,
        // and ToolLoopAgent + Output.object would throw NoObjectGeneratedError.
        if (plan === 'object-via-tool') {
          lastVia = 'ai-sdk:tool';
          const { object, usage, perf, warnings } = await withTransientRetry(kind,
            () => objectViaToolCall(leg, { system, prompt: undefined, messages, schema, temperature, maxOutputTokens }));
          return {
            value: { object, steps: 0, toolCalls: [] },
            via: lastVia,
            sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
            usage,
            perf,
            warnings,
            extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
          };
        }

        // Tokens spent across EVERY leg below. Each is a separate billable call
        // and `result` is reassigned between them, so a single usageOf(result)
        // at the end would count only the last one. This sum is what
        // telemetry/log.ts records and what the daily token cap counts against.
        let spentUsage = { input: 0, output: 0, total: 0 };
        const addUsage = (u: { input: number; output: number; total: number }) => {
          spentUsage = {
            input: spentUsage.input + u.input,
            output: spentUsage.output + u.output,
            total: spentUsage.total + u.total,
          };
        };

        // Native-first structured output. A miss falls through to the done-tool
        // path below; lastVia stays ':native' so the record attributes there.
        if (plan === 'native-then-done') {
          try {
            lastVia = 'ai-sdk:agent:native';
            const nativeAgent = new ToolLoopAgent({
              // forceNoThink below, so use the no-think model.
              model: leg.noThinkModel ?? leg.model,
              instructions: system,
              tools,
              // No `done` tool to force here, so the cap is every discovery step
              // plus one to emit. Max with the caller's value so a deliberately
              // taller loop isn't shrunk by a narrow descriptor.
              stopWhen: [isStepCount(Math.max(maxSteps, gatedMaxSteps))],
              temperature,
              maxOutputTokens,
              timeout: { toolMs: TOOL_TIMEOUT_MS },
              // Thinking off — the pick is structured extraction; djText's
              // free text still reasons.
              reasoning: reasoningFor(leg.cfg, { forceNoThink: true }),
              output: Output.object({ schema: schema! }),
            } as any);
            const nr = await runDeadlined(deadlineAt, kind, 'native run', nativeAgent, messages);
            const nObj = nr.output;
            const nSteps = nr.steps?.length ?? 0;
            // Require a real discovery call: the cross-provider failure
            // signature is emitting the object without calling any tool, and
            // only tool calls populate the `seen` map the caller resolves ids
            // against.
            const explored = (nr.steps || []).some((s) => (s.toolCalls || []).length > 0);
            // A throwing validator counts as a miss, never as an agent failure.
            let accepted = true;
            if (nObj && explored && typeof validate === 'function') {
              try { accepted = !!validate(nObj); } catch { accepted = false; }
            }
            if (nObj && explored && accepted) {
              const toolCalls = flattenToolCalls(nr);
              return {
                value: { object: nObj, steps: nSteps, toolCalls },
                via: lastVia,
                sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
                usage: usageOf(nr),
                perf: perfOf(nr),
                warnings: warningsOf(nr),
                extra: { system, messages, toolCalls, steps: nSteps, response: JSON.stringify(nObj, null, 2) },
              };
            }
            console.log(`[${kind}] native output produced no usable pick (explored=${explored}, accepted=${accepted}) — falling back to done-tool`);
            addUsage(usageOf(nr));
          } catch (e) {
            console.log(`[${kind}] native output failed (${e?.message}) — falling back to done-tool`);
          }
        }

        // Unified main agent: done-tool (Ollama-with-tools, or a native miss),
        // native-no-tools (agent-level Output.object), or free text (no schema).
        const useDoneTool = schema != null && (needsToolCallObject(leg.cfg) || toolCount > 0);
        const allTools = useDoneTool ? { ...tools, done: buildDoneTool(schema!) } : tools;
        // 'required' by default; 'auto' when the operator downgrades this leg for
        // a server whose forced-tool backend crashes (#570).
        const forcedChoice = forcedToolChoice(leg.cfg);

        const discoveryToolNames = tools ? Object.keys(tools) : [];
        const useGatedDiscovery = useDoneTool && discoveryToolNames.length > 0;
        const prepareStep = useGatedDiscovery ? gatedDiscoveryPrepareStep(discoveryToolNames, forcedChoice, discoverySteps) : undefined;
        // On a gated run the cap is DERIVED, not the caller's: exactly
        // discoverySteps + 1. Lower ends the loop before the forced `done` step
        // runs; higher hands the model extra `done` steps to decline in.
        // Ungated runs keep the caller's value.
        const effectiveMaxSteps = useGatedDiscovery ? gatedMaxSteps : maxSteps;

        const agent = new ToolLoopAgent({
          // useDoneTool legs force tool calls → no-think model; the schema-only
          // and free-text legs keep the operator's reasoning choice.
          model: useDoneTool ? (leg.noThinkModel ?? leg.model) : leg.model,
          instructions: system,
          tools: allTools,
          stopWhen: [isStepCount(effectiveMaxSteps), hasToolCall('done')],
          temperature,
          maxOutputTokens,
          timeout: { toolMs: TOOL_TIMEOUT_MS },
          // Suppress thinking on providers that reject forced tools mid-reasoning.
          reasoning: reasoningFor(leg.cfg, { forceNoThink: useDoneTool }),
          ...(useDoneTool ? { toolChoice: forcedChoice } : {}),
          ...(prepareStep ? { prepareStep } : {}),
          // On the done-tool path the schema lives on `done`, so no agent output.
          ...(schema && !useDoneTool ? { output: Output.object({ schema }) } : {}),
        } as any);
        let result = await runDeadlined(deadlineAt, kind, 'agent run', agent, messages);
        let steps = result.steps?.length ?? 0;
        addUsage(usageOf(result));

        // The trail belongs to the MAIN run: `result` is reassigned by the
        // done-only recovery below, so reading it off the final result loses it
        // entirely. Capture here and top up from later attempts. The terminal
        // collapse renders this into its prompt, which is what stops a cornered
        // model from inventing an id.
        let discoveryTrail = flattenToolCalls(result);
        const captureTrail = (r: AgentGenerateResult) => {
          const more = flattenToolCalls(r);
          if (more.length) discoveryTrail = [...discoveryTrail, ...more];
        };

        // Set only by the single-turn terminal collapse below.
        let terminalObject: unknown;
        let terminalPrompt: string | undefined;

        // What the model said INSTEAD of calling `done`, one entry per declining
        // attempt. Surfaced on the eventual throw via err.text, which
        // failureDiagnostics turns into the /debug record's responseText and
        // failover.ts prints to the container log.
        const declinedAttempts: string[] = [];
        const noteIfDeclined = (label: string, r: AgentGenerateResult) => {
          if (!(r.staticToolCalls || []).some((c) => c.toolName === 'done')
            && typeof r.text === 'string' && r.text.trim()) {
            declinedAttempts.push(`[${label}] ${r.text.trim()}`);
          }
        };
        noteIfDeclined('main', result);

        // Recovery for "agent did not call the done tool" (#140): re-run once
        // with prepareStep pinned to done-only. Carry the first run's tool-call
        // and tool-result messages forward — replaying the bare `messages`
        // strips the candidates it surfaced, leaving a cornered agent able only
        // to fabricate an id.
        if (useDoneTool && !(result.staticToolCalls || []).some((c) => c.toolName === 'done')) {
          console.log(`[${kind}] agent stopped without calling done — retrying with done-only`);
          recordAgentRetry();
          lastVia = 'ai-sdk:agent:recovery';
          const priorMessages = result.response?.messages || [];
          const recoveryMessages = priorMessages.length ? [...messages, ...priorMessages] : messages;
          result = await runDeadlined(deadlineAt, kind, 'agent recovery',
            buildRecoveryAgent(leg, system, allTools, temperature, maxOutputTokens, forcedChoice), recoveryMessages);
          steps = result.steps?.length ?? 0;
          addUsage(usageOf(result));
          captureTrail(result);
          noteIfDeclined('recovery', result);

          // Last resort — collapse the loop into ONE single-turn forced-tool
          // call (#1157). The models that land here decline a terminal `done`
          // whatever tool_choice says, yet call a forced tool reliably from a
          // single user prompt, so the fix is conversation SHAPE. Do not add a
          // fourth leg: every attempt draws on the same shared deadline, so it
          // would never be reached on the slow rigs that need this most.
          if (!(result.staticToolCalls || []).some((c) => c.toolName === 'done')) {
            console.log(`[${kind}] recovery also stopped without calling done — collapsing to a single-turn terminal call`);
            recordAgentRetry();
            lastVia = 'ai-sdk:agent:terminal';
            try {
              const prompt = renderTerminalPrompt(messages, discoveryTrail);
              const t = await runDeadlinedCall(deadlineAt, kind, 'agent terminal collapse',
                (signal) => objectViaToolCall(leg, {
                  system, prompt, schema, temperature, maxOutputTokens, signal,
                }));
              terminalObject = t.object;
              addUsage(t.usage);
              terminalPrompt = prompt;
              // A real model call the record should count.
              steps += 1;
            } catch (e) {
              // Text salvage below still gets a shot, then the caller's pool
              // fallback, so log and carry on rather than throwing past both.
              const why = (e as Error)?.message || String(e);
              console.log(`[${kind}] terminal collapse failed (${why}) — falling through to text salvage`);
              declinedAttempts.push(`[terminal] ${why}`);
            }
          }
        }

        let object;
        if (useDoneTool) {
          // staticToolCalls carries the FINAL step's tool calls — the SDK surfaces
          // calls that weren't executed (like our no-execute `done`) here.
          const doneCall = (result.staticToolCalls || []).find((c) => c.toolName === 'done');
          if (doneCall) {
            object = doneCall.input;
          } else if (terminalObject !== undefined) {
            // objectViaToolCall already Zod-parsed it, so it lands here
            // schema-valid, same as a done call.
            object = terminalObject;
          } else {
            // Salvage: some models end the forced loop emitting the answer as
            // text/JSON instead of a `done` call. Parse and Zod-validate before
            // giving up; only throw when there is no usable JSON either.
            try {
              object = schema!.parse(JSON.parse(extractJson(stripThinking(result.text || ''))));
              lastVia = `${lastVia}:text`;
            } catch {
              const err = new Error('agent did not call the done tool before stopping') as AgentFailureError;
              err.text = declinedAttempts.length ? declinedAttempts.join('\n\n') : (result.text || '');
              err.finishReason = result.finishReason;
              // Spend across every leg, in the raw TokenUsage shape
              // failureDiagnostics feeds to usageOf.
              err.usage = { inputTokens: spentUsage.input, outputTokens: spentUsage.output, totalTokens: spentUsage.total };
              err.steps = result.steps;
              throw err;
            }
          }
        } else if (schema) {
          object = result.output;
        } else {
          object = stripThinking(result.text);
        }

        // Carried from the main run rather than re-read off `result`.
        const toolCalls = discoveryTrail;
        return {
          value: { object, steps, toolCalls },
          via: lastVia,
          sampling: samplingWithLocalKnobs(leg.cfg, { temperature }),
          usage: spentUsage,
          perf: perfOf(result),
          warnings: warningsOf(result),
          // Full and untruncated. When the collapse answered, the flattened
          // prompt it saw rides along beside the original messages.
          extra: {
            system, messages, toolCalls, steps,
            ...(terminalPrompt ? { terminalPrompt } : {}),
            response: schema ? JSON.stringify(object, null, 2) : String(object ?? ''),
          },
        };
      } catch (err) {
        // Attribute to the path actually attempted; withFailover writes the
        // record and decides whether a host-unreachable error tries the backup.
        (err as { __via?: string }).__via = lastVia;
        throw err;
      }
    },
  );
}
