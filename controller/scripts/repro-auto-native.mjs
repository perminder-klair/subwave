// Isolated repro for issue #300: does ToolLoopAgent + discovery tools +
// native Output.object (AUTO tool_choice, no forced done tool, no gating)
// reliably EMIT the structured object on deepseek-v4-flash with the current
// AI SDK? Runs N attempts each with thinking on/off and reports emit rate.
import { createDeepSeek } from '@ai-sdk/deepseek';
import { ToolLoopAgent, tool, isStepCount, Output } from 'ai';
import { z } from 'zod';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('no DEEPSEEK_API_KEY'); process.exit(1); }
const N = Number(process.env.N || 6);
const MODEL = process.env.MODEL || 'deepseek-v4-flash';

const deepseek = createDeepSeek({ apiKey: KEY });
const model = deepseek(MODEL);

// Fake library so the run is deterministic and offline-ish (no Navidrome).
const SONGS = [
  { id: 'a1', title: 'Midnight Drive', artist: 'Neon Hours' },
  { id: 'b2', title: 'Paper Boats', artist: 'Ivory Lane' },
  { id: 'c3', title: 'Saffron Sky', artist: 'Ravi Mehta' },
];
const tools = {
  searchLibrary: tool({
    description: 'Search the music library by artist, title or vibe. Returns songs.',
    inputSchema: z.object({ query: z.string() }),
    execute: async () => SONGS,
  }),
  starredSongs: tool({
    description: "The operator's starred favourites — always a safe pick.",
    inputSchema: z.object({}),
    execute: async () => SONGS,
  }),
};

const SCHEMA = z.object({
  id: z.string().describe('the chosen song id from the tool results'),
  reason: z.string().describe('one short sentence why'),
});

const SYS = 'You are a radio DJ picking the next track. First call a discovery tool to see real songs, then choose ONE by its id. Return your final pick as the structured object.';
const MSG = [{ role: 'user', content: 'Pick the next track. Explore the library first, then commit to one real id.' }];

const COMMIT_AFTER_STEPS = 1;

// strategy: 'auto' = AUTO tool_choice + native Output.object (no forced tools).
//           'forced' = mirror prod: synthetic done tool + toolChoice:'required'
//           + prepareStep gating (discovery-then-done).
async function once(thinking, strategy) {
  const doneTool = tool({
    description: 'Call this exactly once when you have your final answer. Pass the answer as input.',
    inputSchema: SCHEMA,
  });
  const discoveryNames = Object.keys(tools);
  const cfg = {
    model,
    instructions: SYS,
    temperature: 0.6,
    maxOutputTokens: 2048,
    providerOptions: { deepseek: { thinking: { type: thinking ? 'enabled' : 'disabled' } } },
  };
  let agent;
  if (strategy === 'auto') {
    agent = new ToolLoopAgent({ ...cfg, tools, stopWhen: [isStepCount(4)], output: Output.object({ schema: SCHEMA }) });
  } else {
    agent = new ToolLoopAgent({
      ...cfg,
      tools: { ...tools, done: doneTool },
      stopWhen: [isStepCount(4)],
      toolChoice: 'required',
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 0) return { activeTools: discoveryNames, toolChoice: 'required' };
        if (stepNumber >= COMMIT_AFTER_STEPS) return { activeTools: ['done'], toolChoice: 'required' };
        return {};
      },
    });
  }
  const t0 = Date.now();
  try {
    const r = await agent.generate({ messages: MSG });
    let obj;
    if (strategy === 'auto') obj = r.output;
    else obj = (r.staticToolCalls || []).find(c => c.toolName === 'done')?.input;
    const steps = r.steps?.length ?? 0;
    const toolNames = (r.steps || []).flatMap(s => (s.toolCalls || []).map(c => c.toolName)).filter(n => n !== 'done');
    const ok = obj && typeof obj.id === 'string' && SONGS.some(s => s.id === obj.id);
    return { ok, ms: Date.now() - t0, steps, tools: toolNames, obj };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

for (const strategy of ['auto', 'forced']) {
  for (const thinking of [false, true]) {
    let pass = 0;
    console.log(`\n=== strategy=${strategy} thinking=${thinking} | ${MODEL} | ${N} runs ===`);
    for (let i = 0; i < N; i++) {
      const r = await once(thinking, strategy);
      if (r.ok) pass++;
      console.log(
        `#${i + 1} ${r.ok ? 'OK ' : 'FAIL'} ${r.ms}ms steps=${r.steps ?? '-'} tools=[${(r.tools || []).join(',')}]` +
        (r.obj ? ` -> ${JSON.stringify(r.obj)}` : '') +
        (r.error ? ` ERR: ${r.error}` : ''),
      );
    }
    console.log(`>>> ${strategy}/thinking=${thinking}: ${pass}/${N} valid`);
  }
}
