// Does the updated ai-sdk-ollama support native Output.object (Ollama `format`
// JSON-schema mode)? If yes, the needsToolCallObject() workaround (force
// structured output through a tool call on every Ollama leg) could be relaxed.
// Tests: (A) native Output.object, no tools — the core needsToolCallObject
// question; (B) ToolLoopAgent + tools + native Output.object — the #300
// question for Ollama.
import { createOllama } from 'ai-sdk-ollama';
import { ToolLoopAgent, tool, stepCountIs, Output, generateText } from 'ai';
import { z } from 'zod';

const URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'qwen3.5:0.8b';
const N = Number(process.env.N || 5);
const ollama = createOllama({ baseURL: URL });
const model = ollama(MODEL);

const SCHEMA = z.object({ id: z.string(), reason: z.string() });
const SONGS = [{ id: 'a1', title: 'Midnight Drive' }, { id: 'b2', title: 'Paper Boats' }];
const SYS = 'You are a radio DJ. Choose ONE song and return the structured object {id, reason}.';

async function nativeNoTools() {
  const t0 = Date.now();
  try {
    const r = await generateText({
      model, system: SYS,
      prompt: `Pick one of these and return {id, reason}: ${JSON.stringify(SONGS)}`,
      output: Output.object({ schema: SCHEMA }),
      providerOptions: { ollama: { think: false } },
    });
    const obj = r.output;
    const ok = obj && SONGS.some(s => s.id === obj.id);
    return { ok, ms: Date.now() - t0, obj };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

async function toolLoopNative() {
  const tools = { searchLibrary: tool({ description: 'List songs.', inputSchema: z.object({}), execute: async () => SONGS }) };
  const t0 = Date.now();
  try {
    const agent = new ToolLoopAgent({
      model, instructions: SYS + ' First call searchLibrary, then pick.',
      tools, stopWhen: [stepCountIs(4)],
      output: Output.object({ schema: SCHEMA }),
      providerOptions: { ollama: { think: false } },
    });
    const r = await agent.generate({ messages: [{ role: 'user', content: 'Pick the next track.' }] });
    const obj = r.output;
    const tn = (r.steps || []).flatMap(s => (s.toolCalls || []).map(c => c.toolName));
    const ok = obj && SONGS.some(s => s.id === obj.id);
    return { ok, ms: Date.now() - t0, obj, tools: tn };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

// C: the PROD path for Ollama — forced done-tool loop with gating. Regression
// check that the ai-sdk-ollama bump didn't break the only strategy that works.
async function toolLoopDone() {
  const COMMIT_AFTER_STEPS = 1;
  const songsTool = { searchLibrary: tool({ description: 'List songs.', inputSchema: z.object({}), execute: async () => SONGS }) };
  const done = tool({ description: 'Call once with your final answer.', inputSchema: SCHEMA });
  const t0 = Date.now();
  try {
    const agent = new ToolLoopAgent({
      model, instructions: SYS + ' First call searchLibrary, then commit via done.',
      tools: { ...songsTool, done }, stopWhen: [stepCountIs(4)],
      toolChoice: 'required',
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 0) return { activeTools: ['searchLibrary'], toolChoice: 'required' };
        if (stepNumber >= COMMIT_AFTER_STEPS) return { activeTools: ['done'], toolChoice: 'required' };
        return {};
      },
      providerOptions: { ollama: { think: false } },
    });
    const r = await agent.generate({ messages: [{ role: 'user', content: 'Pick the next track.' }] });
    const obj = (r.staticToolCalls || []).find(c => c.toolName === 'done')?.input;
    const tn = (r.steps || []).flatMap(s => (s.toolCalls || []).map(c => c.toolName)).filter(n => n !== 'done');
    const ok = obj && SONGS.some(s => s.id === obj.id);
    return { ok, ms: Date.now() - t0, obj, tools: tn };
  } catch (e) { return { ok: false, ms: Date.now() - t0, error: e.message }; }
}

for (const [label, fn] of [['A: native Output.object, no tools', nativeNoTools], ['B: ToolLoopAgent + tools + native Output.object', toolLoopNative], ['C: PROD forced done-tool loop', toolLoopDone]]) {
  let pass = 0;
  console.log(`\n=== ${label} | ${MODEL} | ${N} runs ===`);
  for (let i = 0; i < N; i++) {
    const r = await fn();
    if (r.ok) pass++;
    console.log(`#${i + 1} ${r.ok ? 'OK ' : 'FAIL'} ${r.ms}ms` + (r.tools ? ` tools=[${r.tools.join(',')}]` : '') + (r.obj ? ` -> ${JSON.stringify(r.obj)}` : '') + (r.error ? ` ERR: ${r.error}` : ''));
  }
  console.log(`>>> ${pass}/${N} valid`);
}
