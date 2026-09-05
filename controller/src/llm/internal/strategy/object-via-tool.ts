// Structured output via a forced tool call. The result schema is presented as
// an `emit` tool the model MUST call (toolChoice:'required'); we capture and
// Zod-validate its input. This is the reliable structured-output path for
// models that ignore JSON mode but handle tool calls fine (Ollama). Single step
// — the model's only legal move is to call `emit` once. Returns the validated
// object plus a token-usage block so callers can log it alongside the other
// branches.

import { generateText, tool, isStepCount } from 'ai';
import { usageOf, perfOf, warningsOf } from '../core/pure.js';
import { reasoningFor, forcedToolChoice } from '../provider/capabilities.js';

// The TRANSPORT rule for this path, stated in the system channel because that
// is where the model weighs it. It lives HERE, not in any caller's prompt, for
// the reason every other cross-cutting decision in this codebase lives in one
// module: the caller cannot know which branch djObject will take
// (needsToolCallObject resolves that per LEG, at call time), so a caller that
// writes its own output-channel instruction is guessing — and half the time it
// guesses against the transport actually chosen.
//
// Issue #1536 is that failure with a measurement attached: the tagger's prompt
// said "Return ONLY a JSON object" while this path sent toolChoice:'required',
// and gemma-4-12b on llama.cpp spent its whole generation budget arguing with
// itself over which of the two to obey ("Wait! I just noticed... 'Return ONLY'.
// ... Tool calls are often used for *actions*. I'll go with direct output.")
// before being cancelled. The `emit` tool's DESCRIPTION already said calling it
// is how you answer; a tool description does not carry the weight a system
// instruction does against a system instruction pulling the other way.
//
// Kept to one line, no double quotes: it is prepended to every forced-object
// call on every leg, including the picker's terminal collapse.
export const EMIT_ANSWER_INSTRUCTION =
  'Answer by calling the `emit` tool exactly once with the complete result — the tool call IS your answer. Do not write the result as text, JSON or a code block in your reply.';

// The caller's system prompt with the transport rule appended, or the rule
// alone when the caller has no system prompt. Last, so it is the nearest thing
// to the model's turn.
export function emitInstructions(system?: string): string {
  const base = typeof system === 'string' ? system.trim() : '';
  return base ? `${base}\n\n${EMIT_ANSWER_INSTRUCTION}` : EMIT_ANSWER_INSTRUCTION;
}

export async function objectViaToolCall(
  leg: any,
  { system, prompt, messages, schema, temperature, maxOutputTokens, signal }: any,
): Promise<{ object: any; usage: any; perf?: any; warnings?: string[] }> {
  let captured: any;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input: any) => { captured = input; return 'received'; },
  });
  const result = await generateText({
    // Forced single-tool call — always no-think (the no-think model is identical
    // to leg.model except for OpenRouter, where reasoning is fixed at build time).
    model: leg.noThinkModel ?? leg.model,
    instructions: emitInstructions(system),
    ...(messages ? { messages } : { prompt }),
    temperature,
    maxOutputTokens,
    tools: { emit },
    // 'required' by default; an operator can downgrade to 'auto' per leg for a
    // server whose forced-tool backend crashes (issue #570). With one tool
    // visible + the "call it exactly once" instruction, a capable model still
    // emits via the tool; a miss throws below → caller's fallback.
    toolChoice: forcedToolChoice(leg.cfg),
    stopWhen: isStepCount(1),
    reasoning: reasoningFor(leg.cfg, { forceNoThink: true }),
    ...(signal ? { abortSignal: signal } : {}),
  } as any);
  if (captured === undefined) throw new Error('model never called the emit tool');
  return { object: schema.parse(captured), usage: usageOf(result), perf: perfOf(result), warnings: warningsOf(result) };
}
