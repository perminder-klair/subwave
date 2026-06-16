// djAgent — conversational tool-loop with structured output. The primitive
// behind the session DJ agent (broadcast/dj-agent.js) and the segment director
// (skills/_agent.js): a ToolLoopAgent is given the discovery tools and a step
// cap, fed a `messages` array (the session chat window) instead of a single
// prompt, and returns a schema-validated final object. Throws on failure so the
// caller can fall back to a stateless path.
//
// STRATEGY (resolved per leg by agentPlan() below):
//   1. Native-first (non-Ollama tool-using agents): native Output.object with
//      AUTO tool_choice. Needs no forced tool_choice, so it sidesteps the whole
//      "thinking mode does not support this tool_choice" class (Anthropic +
//      DeepSeek reject forced tools while thinking). Verified 5/5 across openai
//      (gpt-4.1-mini), anthropic (claude-haiku-4.5), google (gemini-3.5-flash),
//      openrouter (kimi-k2.6); deepseek needs thinking off (5/5 off vs 1/5 on —
//      forceNoThink handles it). On any miss it falls through to (2), so worst
//      case is the prior behaviour, never a regression. Older models still fail
//      native (gemini-2.5-flash, llama-3.3-70b → 0/n) — the fall-through covers them.
//   2. Done-tool (Ollama always; everyone else on a native miss): the forced
//      tool-calling pattern below. Ollama is excluded from native because its
//      tool-loop Output.object returns schema-valid-but-EMPTY JSON WITHOUT ever
//      calling discovery (verified 0/3 on glm-5.1/qwen3.5/nemotron:cloud), so the
//      done-tool path is the only one that works there.
//
// The done-tool pattern (the AI SDK's documented "Forced Tool Calling"): a
// synthetic `done` tool whose inputSchema IS the schema is added alongside the
// discovery tools, `toolChoice:'required'` forces a tool call every step, and
// prepareStep corners the model into discovery-then-done.

import { Output, stepCountIs, hasToolCall, ToolLoopAgent, tool } from 'ai';
import { withFailover } from '../core/failover.js';
import { withTransientRetry, withDeadline } from '../core/retry.js';
import { stripThinking, extractJson, usageOf, flattenToolCalls, failureDiagnostics } from '../core/pure.js';
import { needsToolCallObject, providerOptions, samplingWithNumCtx } from '../provider/capabilities.js';
import { objectViaToolCall } from './object-via-tool.js';
import { agentPlan } from './plan.js';

const MAX_TOKENS_AGENT = 8000;

// prepareStep pins activeTools so EVERY step is a cornered single-purpose
// request — step 0 = discovery only, step >= COMMIT_AFTER_STEPS = `done` only.
// Both restrict activeTools at the request level, the only lever cloud Ollama
// models actually honour (they ignore a plain `toolChoice:'required'` when
// several tools are visible and just emit prose — ending the loop with no `done`
// call). COMMIT_AFTER_STEPS = 1 leaves NO free middle step, so that failure
// window is closed: the model gets exactly one discovery call, then must emit
// `done`. One targeted, session-aware discovery call still yields ~8 candidates.
// Raising this re-opens the middle-step failure window on cloud Ollama; don't,
// unless the provider honours `toolChoice`.
const COMMIT_AFTER_STEPS = 1;

function buildDoneTool(schema: any) {
  return tool({
    description: 'Call this exactly once when you have your final answer. Pass the answer as input. Calling this tool IS how you respond — do not emit text after.',
    inputSchema: schema,
  });
}

// Step 0 forces a discovery tool — never `done` — so the model can't commit a
// hallucinated id before seeing any library results. Step >= COMMIT_AFTER_STEPS
// forces `done`: with only `done` active the model cannot keep exploring and
// must emit its final answer, guaranteeing a `done` call before the step cap.
function gatedDiscoveryPrepareStep(discoveryToolNames: string[]) {
  return async ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber === 0) {
      return { activeTools: discoveryToolNames, toolChoice: 'required' };
    }
    if (stepNumber >= COMMIT_AFTER_STEPS) {
      return { activeTools: ['done'], toolChoice: 'required' };
    }
    return {};
  };
}

// The withDeadline(Promise.race + abort) + withTransientRetry wrapper around a
// single agent.generate(). The `timeout` generate option is NOT honoured by the
// ai-sdk-ollama transport, so the wall-clock ceiling is enforced here; the abort
// signal is forwarded so transports that DO support cancellation stop the request
// server-side. Main run and recovery each get the full timeoutMs (worst case ~2×).
function runDeadlined(timeoutMs: any, kind: string, label: string, agent: any, messages: any) {
  return withDeadline(timeoutMs, `${kind} ${label}`, (signal) =>
    withTransientRetry(kind, () => agent.generate({
      messages,
      ...(signal ? { abortSignal: signal } : {}),
    })));
}

export async function djAgent({
  system,
  messages,
  tools,
  schema,
  maxSteps = 8,
  temperature = 0.6,
  maxOutputTokens = MAX_TOKENS_AGENT,
  kind = 'sdk.djAgent',
  timeoutMs,
}: any): Promise<{ object: any; steps: number; toolCalls: any[] }> {
  return withFailover(
    kind,
    (err) => ({ system, messages, ...failureDiagnostics(err) }),
    async (leg) => {
      const toolCount = tools ? Object.keys(tools).length : 0;
      const plan = agentPlan(leg.cfg, schema, toolCount);
      // Default to the agent path; branches override before their await. A
      // failure record always attributes to the path actually attempted.
      let lastVia = 'ai-sdk:agent';
      try {
        // No discovery tools + an Ollama model that ignores JSON mode: there is
        // no loop to run, and ToolLoopAgent + Output.object would throw
        // NoObjectGeneratedError. Get the structured result from a forced tool call.
        if (plan === 'object-via-tool') {
          lastVia = 'ai-sdk:tool';
          const { object, usage } = await withTransientRetry(kind,
            () => objectViaToolCall(leg, { system, prompt: undefined, messages, schema, temperature, maxOutputTokens }));
          return {
            value: { object, steps: 0, toolCalls: [] },
            via: lastVia,
            sampling: samplingWithNumCtx(leg.cfg, { temperature }),
            usage,
            extra: { system, messages, toolCalls: [], steps: 0, response: JSON.stringify(object, null, 2) },
          };
        }

        // ----- Native-first structured output (non-Ollama tool-using agents) -----
        // Prefer native Output.object where it now emits reliably (see header).
        // No forced tool_choice → no thinking conflict, and simpler than the
        // done-tool harness. On a miss we fall through to the done-tool path
        // below (lastVia stays ':native' so the eventual record attributes there).
        if (plan === 'native-then-done') {
          try {
            lastVia = 'ai-sdk:agent:native';
            const nativeAgent = new ToolLoopAgent({
              model: leg.model,
              instructions: system,
              tools,
              stopWhen: [stepCountIs(maxSteps)],
              temperature,
              maxOutputTokens,
              // Thinking off: makes deepseek reliable (5/5 vs 1/5) and is harmless
              // elsewhere — the pick is structured extraction; the DJ's free-text
              // (djText) still reasons.
              providerOptions: providerOptions(leg.cfg, { forceNoThink: true }),
              output: Output.object({ schema }),
            } as any);
            const nr: any = await runDeadlined(timeoutMs, kind, 'native run', nativeAgent, messages);
            const nObj = nr.output;
            const nSteps = nr.steps?.length ?? 0;
            // The cross-provider failure signature is "emitted the object WITHOUT
            // calling a discovery tool" (deepseek-thinking-on, ollama). Require a
            // real discovery call so a no-explore hallucination can't slip through:
            // the caller resolves the id against `seen`, which only tool calls
            // populate, so an explored pick is also a resolvable one.
            const explored = (nr.steps || []).some((s: any) => (s.toolCalls || []).length > 0);
            if (nObj && explored) {
              const toolCalls = flattenToolCalls(nr);
              return {
                value: { object: nObj, steps: nSteps, toolCalls },
                via: lastVia,
                sampling: samplingWithNumCtx(leg.cfg, { temperature }),
                usage: usageOf(nr),
                extra: { system, messages, toolCalls, steps: nSteps, response: JSON.stringify(nObj, null, 2) },
              };
            }
            console.log(`[${kind}] native output produced no usable pick (explored=${explored}) — falling back to done-tool`);
          } catch (e: any) {
            console.log(`[${kind}] native output failed (${e?.message}) — falling back to done-tool`);
          }
        }

        // Unified main agent: done-tool (Ollama-with-tools, or any native miss),
        // native-no-tools (schema-only off Ollama → agent-level Output.object), or
        // free-text (no schema). useDoneTool is the original predicate, kept verbatim.
        const useDoneTool = schema != null && (needsToolCallObject(leg.cfg) || toolCount > 0);
        const allTools = useDoneTool ? { ...tools, done: buildDoneTool(schema) } : tools;

        const discoveryToolNames = tools ? Object.keys(tools) : [];
        const useGatedDiscovery = useDoneTool && discoveryToolNames.length > 0;
        const prepareStep = useGatedDiscovery ? gatedDiscoveryPrepareStep(discoveryToolNames) : undefined;

        const agent = new ToolLoopAgent({
          model: leg.model,
          instructions: system,
          tools: allTools,
          // The no-execute `done` tool already terminates the loop when called;
          // hasToolCall('done') is belt-and-suspenders, and inert on the native
          // path where no `done` tool exists.
          stopWhen: [stepCountIs(maxSteps), hasToolCall('done')],
          temperature,
          maxOutputTokens,
          // useDoneTool forces tool calls every step — suppress thinking on the
          // providers that reject forced tools mid-reasoning (Anthropic/DeepSeek).
          providerOptions: providerOptions(leg.cfg, { forceNoThink: useDoneTool }),
          ...(useDoneTool ? { toolChoice: 'required' } : {}),
          ...(prepareStep ? { prepareStep } : {}),
          // Native path: structured output via Output.object. Done-tool path: the
          // schema lives on the `done` tool, so no agent-level output.
          ...(schema && !useDoneTool ? { output: Output.object({ schema }) } : {}),
        } as any);
        // timeoutMs (when set) is a hard ceiling — a slow/looping run throws,
        // flows through the catch below, and the caller falls back to its
        // stateless path rather than blocking on a pathological model call.
        let result: any = await runDeadlined(timeoutMs, kind, 'agent run', agent, messages);
        let steps = result.steps?.length ?? 0;

        // Recovery for the "agent did not call the done tool" failure mode (issue
        // #140). Local/cloud Ollama models occasionally ignore toolChoice:'required'
        // at step 0 — they emit prose instead of any tool call, the loop ends with
        // zero tool calls, and we'd otherwise throw. Re-run once with prepareStep
        // pinned to `done`-only so `done` is the model's only legal move. Crucially
        // carry the first run's tool-call + tool-result messages (the discovery
        // trail) forward: that run DID surface candidates into the caller's `seen`
        // map; replaying only the bare `messages` strips them, so a cornered agent
        // could only fabricate an id (100% unknown-id). Feeding the trail back lets
        // it commit to a REAL surfaced id. Harmless for free-text recovery.
        if (useDoneTool && !(result.staticToolCalls || []).some((c: any) => c.toolName === 'done')) {
          console.log(`[${kind}] agent stopped without calling done — retrying with done-only`);
          lastVia = 'ai-sdk:agent:recovery';
          const priorMessages = (result as any).response?.messages || [];
          const recoveryMessages = priorMessages.length ? [...messages, ...priorMessages] : messages;
          const recoveryAgent = new ToolLoopAgent({
            model: leg.model,
            instructions: system,
            tools: allTools,
            stopWhen: [stepCountIs(2), hasToolCall('done')],
            temperature,
            maxOutputTokens,
            // Recovery forces done-only every step, so it has the same
            // Anthropic/DeepSeek thinking conflict as the main run — suppress here too.
            providerOptions: providerOptions(leg.cfg, { forceNoThink: true }),
            toolChoice: 'required',
            prepareStep: async () => ({ activeTools: ['done'], toolChoice: 'required' }),
          } as any);
          result = await runDeadlined(timeoutMs, kind, 'agent recovery', recoveryAgent, recoveryMessages);
          steps = result.steps?.length ?? 0;
        }

        let object;
        if (useDoneTool) {
          // staticToolCalls carries the FINAL step's tool calls — the SDK surfaces
          // calls that weren't executed (like our no-execute `done`) here.
          const doneCall = (result.staticToolCalls || []).find((c: any) => c.toolName === 'done');
          if (doneCall) {
            object = (doneCall as any).input;
          } else {
            // Salvage: some models (deepseek-v4-flash) end the forced loop emitting
            // the answer as text/JSON instead of a `done` call — even after the
            // done-only recovery. Parse it from text and Zod-validate before giving
            // up, mirroring djObject's recovery. Only throw (→ caller's pool
            // fallback) when there's no usable JSON either.
            try {
              object = schema.parse(JSON.parse(extractJson(stripThinking(result.text || ''))));
              lastVia = `${lastVia}:text`;
            } catch {
              throw new Error('agent did not call the done tool before stopping');
            }
          }
        } else if (schema) {
          object = result.output;
        } else {
          object = stripThinking(result.text);
        }

        // Flatten the discovery-tool trail for /debug (excludes the `done` tool).
        const toolCalls = flattenToolCalls(result);
        return {
          value: { object, steps, toolCalls },
          via: lastVia,
          sampling: samplingWithNumCtx(leg.cfg, { temperature }),
          usage: usageOf(result),
          // Full, untruncated — the agent's entire input and trail.
          extra: {
            system, messages, toolCalls, steps,
            response: schema ? JSON.stringify(object, null, 2) : String(object ?? ''),
          },
        };
      } catch (err) {
        // Attribute to the path actually attempted; withFailover writes the
        // record and decides whether a host-unreachable error tries the backup.
        (err as any).__via = lastVia;
        throw err;
      }
    },
  );
}
