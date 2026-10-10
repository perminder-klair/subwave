// Expose the schema as the sole required emit tool and Zod-validate its input.
// One step returns the object and usage, including for models that ignore JSON mode.

import { generateText, tool, isStepCount, ToolChoiceViolationError } from 'ai';
import { perfOf, warningsOf, createUsageMeter } from '../core/pure.js';
import type { UsageMeter } from '../core/pure.js';
import { reasoningFor, forcedToolChoice, googleSafetyOptions } from '../provider/capabilities.js';

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

// `meter` is the caller's per-leg meter when it has one (djObject, djAgent),
// so this call lands in the same sum as the attempt's other legs; standalone
// callers get a private one. Either way a throw carries the billed usage —
// a declined `emit` is a paid call — and the model's prose, for /debug.
export async function objectViaToolCall(
  leg: any,
  { system, prompt, messages, schema, temperature, maxOutputTokens, signal, meter }: any,
): Promise<{ object: any; usage: any; perf?: any; warnings?: string[] }> {
  const usage: UsageMeter = meter ?? createUsageMeter();
  // This call's own share, so a shared meter's earlier legs are not reported
  // twice by a caller that also sums the returned figure.
  const before = usage.usage();
  let captured: any;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input: any) => { captured = input; return 'received'; },
  });
  let result: any;
  try {
    result = await generateText({
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
      ...googleSafetyOptions(leg.cfg),
      ...(signal ? { abortSignal: signal } : {}),
      onLanguageModelCallEnd: usage.onLanguageModelCallEnd,
    } as any);
    if (captured === undefined) {
      const err: any = new Error('model never called the emit tool');
      err.text = result.text || '';
      err.finishReason = result.finishReason;
      throw err;
    }
    const object = schema.parse(captured);
    const after = usage.usage();
    return {
      object,
      usage: { input: after.input - before.input, output: after.output - before.output, total: after.total - before.total },
      perf: perfOf(result),
      warnings: warningsOf(result),
    };
  } catch (err: any) {
    // The prose the model wrote instead of calling `emit`, for /debug.
    if (ToolChoiceViolationError.isInstance(err)) {
      (err as any).text = err.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n');
    }
    usage.attachTo(err);
    throw err;
  }
}
