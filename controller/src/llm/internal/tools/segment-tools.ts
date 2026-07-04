// AI SDK tool library — wraps each on-offer skill's data tool (its tool.mjs)
// for the segment-director agent (skills/_agent.js) to call before deciding
// whether to air a between-track segment. The counterpart of picker-tools.ts
// (music discovery): that set lets the DJ agent explore the library, these let
// it look at the world.
//
// Built-in and custom skills run on identical footing: every cap that ships a
// `toolFn` (loaded from its directory's tool.mjs by skills/loader.js) gets one
// tool here, invoked as `toolFn(ctx, state, services, config, input)`:
//   ctx      — the moment ({ time, weather, festival, dominantMood, clock })
//   state    — dedup memory carried across ticks (seen headlines, last artist…)
//   services — the curated station facade (search, library, play log, feeds…)
//   config   — the skill's own frontmatter (e.g. news' feed / feedMaxItems)
//   input    — the agent's arguments for the skill's declared `inputs` params
//              (nullable strings; {} for the historical zero-arg tools)
//
// Every skill tool now lives in state/skills (built-ins seeded there on first
// boot), so all of them run behind a hard timeout + try/catch — a slow or
// throwing skill degrades to "no data" rather than hanging the tick. The
// network-heavy built-ins (web-search, news RSS, on-this-day) must finish within
// the timeout or that tick simply yields no segment.

import { tool } from 'ai';
import { z } from 'zod';
import { buildStationServices } from './station-services.js';

export function buildSegmentTools(ctx: any, state: any, caps: any[]) {
  const services = buildStationServices();
  const tools: any = {};

  for (const cap of caps as any[]) {
    if (typeof cap.toolFn !== 'function' || !cap.toolName) continue;
    // A skill's optional `inputs` export ({ name: description }) becomes
    // agent-steerable string parameters — nullable (required-but-null, the
    // same convention as the segment schema's sfx field, which small models
    // handle better than optional keys), so a model that passes null still
    // gets the skill's own default behaviour. No `inputs` → the historical
    // zero-arg tool.
    const shape: Record<string, any> = {};
    for (const [name, desc] of Object.entries(cap.toolInputs || {})) {
      shape[name] = z.string().nullable().describe(String(desc));
    }
    tools[cap.toolName] = tool({
      description: cap.toolDesc,
      inputSchema: z.object(shape),
      execute: async (input: any) => {
        try {
          const p = Promise.resolve(cap.toolFn(ctx, state, services, cap.config, input || {}));
          return await withTimeout(p, 8000);
        } catch (err: any) {
          return { error: err?.message || String(err) };
        }
      },
    });
  }

  return tools;
}

// Resolve `p`, or reject after `ms` — keeps any skill's tool.mjs from stalling
// the segment tick indefinitely.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`tool timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}
