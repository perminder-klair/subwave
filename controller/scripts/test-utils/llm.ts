// Replaces fake OpenAI envelopes. Defaults match common fixtures; callers keep
// differing metadata and usage explicit, and override ambiguous finish reasons.
interface CompletionOptions {
  id?: string;
  created?: number;
  model?: unknown;
  message: Record<string, unknown>;
  finishReason?: string;
  usage?: Record<string, unknown>;
}

export function chatCompletion(input: CompletionOptions | string) {
  const options: CompletionOptions = typeof input === 'string' ? { message: { role: 'assistant', content: input } } : input;
  const { id = 'x', created = 1, message, usage = { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } } = options;
  return {
    id, object: 'chat.completion', created,
    model: 'model' in options ? options.model : 'fixture-model',
    choices: [{ index: 0, message, finish_reason: options.finishReason ?? ('tool_calls' in message ? 'tool_calls' : 'stop') }],
    usage,
  };
}

export function chatCompletionResponse(options: CompletionOptions | string, init?: ResponseInit) {
  return Response.json(chatCompletion(options), init);
}
