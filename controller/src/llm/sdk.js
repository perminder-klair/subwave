// AI SDK wrapper — the single chokepoint for every LLM call in the controller.
//
// Two primitives:
//   djText   — free-text generation (DJ intros, links, idents, skill segments)
//   djObject — schema-validated structured output (request matching, picker)
//
// Both resolve their model through llm/provider.js, so switching providers in
// Settings reroutes every call with no change here or at the call sites.

import { generateText, Output } from 'ai';
import { languageModel, activeModelLabel } from './provider.js';
import { record } from './log.js';

// Some models (Qwen 3, DeepSeek R1, etc.) emit a <think>…</think> reasoning
// block before the answer. We ask the provider to disable thinking AND strip
// any leftover tags defensively — `think: false` isn't honoured uniformly.
const THINK_TAG_RE = /<think>[\s\S]*?<\/think>\s*/gi;
const DANGLING_THINK_RE = /^[\s\S]*?<\/think>\s*/i;

function stripThinking(s) {
  if (!s) return s;
  return s.replace(THINK_TAG_RE, '').replace(DANGLING_THINK_RE, '').trim();
}

// `repeat_penalty` is Ollama-specific and lives under providerOptions.ollama;
// non-Ollama providers ignore the block entirely, so it's safe to always pass.
function ollamaOptions(repeatPenalty) {
  const opts = { think: false };
  if (repeatPenalty != null) opts.options = { repeat_penalty: repeatPenalty };
  return { ollama: opts };
}

// Free-text DJ generation.
export async function djText({
  system,
  prompt,
  temperature = 0.9,
  topP = 0.95,
  repeatPenalty = 1.15,
  seed = null,
  maxOutputTokens = null,
  kind = 'sdk.djText',
}) {
  const started = Date.now();
  try {
    const result = await generateText({
      model: languageModel(),
      system,
      prompt,
      temperature,
      topP,
      ...(seed != null ? { seed } : {}),
      ...(maxOutputTokens != null ? { maxOutputTokens } : {}),
      providerOptions: ollamaOptions(repeatPenalty),
    });
    const out = stripThinking(result.text);
    record({
      kind, ok: true, ms: Date.now() - started,
      model: activeModelLabel(),
      sampling: { temperature, top_p: topP, repeat_penalty: repeatPenalty, seed },
      via: 'ai-sdk',
      systemPreview: system?.slice(0, 200),
      user: prompt,
      response: out,
      t: new Date().toISOString(),
    });
    return out;
  } catch (err) {
    record({
      kind, ok: false, ms: Date.now() - started,
      model: activeModelLabel(), via: 'ai-sdk',
      user: prompt, error: err.message, t: new Date().toISOString(),
    });
    throw err;
  }
}

// Schema-validated structured output. `schema` is a Zod object schema; the
// returned value is parsed and validated — no manual JSON.parse, no regex
// recovery. Throws if the model can't produce a conforming object.
export async function djObject({
  system,
  prompt,
  schema,
  temperature = 0.4,
  kind = 'sdk.djObject',
}) {
  const started = Date.now();
  try {
    const result = await generateText({
      model: languageModel(),
      system,
      prompt,
      temperature,
      output: Output.object({ schema }),
      providerOptions: ollamaOptions(null),
    });
    const object = result.output;
    record({
      kind, ok: true, ms: Date.now() - started,
      model: activeModelLabel(),
      sampling: { temperature },
      via: 'ai-sdk',
      systemPreview: system?.slice(0, 200),
      user: prompt,
      response: JSON.stringify(object).slice(0, 500),
      t: new Date().toISOString(),
    });
    return object;
  } catch (err) {
    record({
      kind, ok: false, ms: Date.now() - started,
      model: activeModelLabel(), via: 'ai-sdk',
      user: prompt, error: err.message, t: new Date().toISOString(),
    });
    throw err;
  }
}
