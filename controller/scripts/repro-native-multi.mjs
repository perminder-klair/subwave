// Cross-provider check of the #300 question on the CURRENT AI SDK: does
// ToolLoopAgent + discovery tools + native Output.object (AUTO tool_choice, no
// forced done tool, no gating) reliably EMIT the structured object after
// calling a tool? Re-runs the exact models the sdk.ts comment recorded as 0/n
// on the old SDK, via OpenRouter (one key, many providers), plus direct
// DeepSeek. The failure signature we care about: an object emitted with ZERO
// discovery tool calls (hallucination / no-explore) or an empty/invalid id.
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { ToolLoopAgent, tool, stepCountIs, Output } from 'ai';
import { z } from 'zod';

const N = Number(process.env.N || 5);
const orKey = process.env.OPENROUTER_API_KEY;
const dsKey = process.env.DEEPSEEK_API_KEY;
const openrouter = orKey ? createOpenRouter({ apiKey: orKey }) : null;
const deepseek = dsKey ? createDeepSeek({ apiKey: dsKey }) : null;

// [label, model]. OpenRouter models cover the #300 table; deepseek-direct is the
// already-verified control.
// [label, model, providerOptions?]
const TARGETS = [
  openrouter && ['or:openai/gpt-4.1-mini', openrouter('openai/gpt-4.1-mini')],
  openrouter && ['or:anthropic/claude-haiku-4.5', openrouter('anthropic/claude-haiku-4.5')],
  openrouter && ['or:google/gemini-3.5-flash', openrouter('google/gemini-3.5-flash')],
  openrouter && ['or:moonshotai/kimi-k2.6', openrouter('moonshotai/kimi-k2.6')],
  deepseek && ['ds:deepseek-v4-flash (thinking ON)', deepseek('deepseek-v4-flash'), { deepseek: { thinking: { type: 'enabled' } } }],
  deepseek && ['ds:deepseek-v4-flash (thinking OFF)', deepseek('deepseek-v4-flash'), { deepseek: { thinking: { type: 'disabled' } } }],
].filter(Boolean);

const SCHEMA = z.object({ id: z.string(), reason: z.string() });
const SONGS = [{ id: 'a1', title: 'Midnight Drive' }, { id: 'b2', title: 'Paper Boats' }, { id: 'c3', title: 'Saffron Sky' }];
const SYS = 'You are a radio DJ picking the next track. First call searchLibrary to see real songs, then choose ONE by its id and return the structured object {id, reason}.';
const tools = { searchLibrary: tool({ description: 'List the songs in the library.', inputSchema: z.object({}), execute: async () => SONGS }) };

async function once(model, providerOptions) {
  const t0 = Date.now();
  try {
    const agent = new ToolLoopAgent({
      model, instructions: SYS, tools,
      stopWhen: [stepCountIs(4)], temperature: 0.6, maxOutputTokens: 400,
      output: Output.object({ schema: SCHEMA }),
      ...(providerOptions ? { providerOptions } : {}),
    });
    const r = await agent.generate({ messages: [{ role: 'user', content: 'Pick the next track. Explore first, then commit to a real id.' }] });
    const obj = r.output;
    const toolNames = (r.steps || []).flatMap(s => (s.toolCalls || []).map(c => c.toolName));
    const called = toolNames.length > 0;
    const validId = obj && typeof obj.id === 'string' && SONGS.some(s => s.id === obj.id);
    // "ok" = emitted a real id AND actually explored (the picker's real bar).
    return { ok: validId && called, ms: Date.now() - t0, called, validId, obj };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

for (const [label, model, popts] of TARGETS) {
  let pass = 0;
  console.log(`\n=== ${label} | ${N} runs ===`);
  for (let i = 0; i < N; i++) {
    const r = await once(model, popts);
    if (r.ok) pass++;
    console.log(`#${i + 1} ${r.ok ? 'OK ' : 'FAIL'} ${r.ms}ms calledTool=${r.called ?? '-'} validId=${r.validId ?? '-'}` + (r.obj ? ` -> ${JSON.stringify(r.obj).slice(0, 90)}` : '') + (r.error ? ` ERR: ${r.error}` : ''));
  }
  console.log(`>>> ${label}: ${pass}/${N}`);
}
