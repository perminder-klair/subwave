// Structured output via a forced tool call. The result schema is presented as
// an `emit` tool the model MUST call (toolChoice:'required'); we capture and
// Zod-validate its input. This is the reliable structured-output path for
// models that ignore JSON mode but handle tool calls fine (Ollama). Single step
// — the model's only legal move is to call `emit` once. Returns the validated
// object plus a token-usage block so callers can log it alongside the other
// branches.

import { generateText, tool, stepCountIs } from 'ai';
import { usageOf } from '../core/pure.js';
import { providerOptions } from '../provider/capabilities.js';

export async function objectViaToolCall(
  leg: any,
  { system, prompt, messages, schema, temperature, maxOutputTokens }: any,
): Promise<{ object: any; usage: any }> {
  let captured: any;
  const emit = tool({
    description: 'Return your final answer. Call this tool exactly once, with the complete result — calling it IS how you answer.',
    inputSchema: schema,
    execute: async (input: any) => { captured = input; return 'received'; },
  });
  const result = await generateText({
    model: leg.model,
    system,
    ...(messages ? { messages } : { prompt }),
    temperature,
    maxOutputTokens,
    tools: { emit },
    toolChoice: 'required',
    stopWhen: stepCountIs(1),
    providerOptions: providerOptions(leg.cfg, { forceNoThink: true }),
  } as any);
  if (captured === undefined) throw new Error('model never called the emit tool');
  return { object: schema.parse(captured), usage: usageOf(result) };
}
