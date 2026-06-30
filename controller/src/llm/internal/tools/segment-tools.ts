// AI SDK tool library — wraps each on-offer skill's data tool (its tool.mjs)
// for the segment-director agent (skills/_agent.js) to call before deciding
// whether to air a between-track segment. The counterpart of picker-tools.ts
// (music discovery): that set lets the DJ agent explore the library, these let
// it look at the world.
//
// Built-in and custom skills run on identical footing: every cap that ships a
// `toolFn` (loaded from its directory's tool.mjs by skills/loader.js) gets one
// tool here, invoked as `toolFn(ctx, state, services, config)`:
//   ctx      — the moment ({ time, weather, festival, dominantMood, clock })
//   state    — dedup memory carried across ticks (seen headlines, last artist…)
//   services — the curated station facade (search, library, play log, feeds…)
//   config   — the skill's own frontmatter (e.g. news' feed / feedMaxItems)
//
// Operator (custom) tools run operator-supplied code, so they're fenced behind
// a hard timeout + try/catch — a slow or throwing skill degrades to "no data"
// rather than hanging the tick. First-party built-in tools run unfenced.

import { tool } from 'ai';
import { z } from 'zod';
import { buildStationServices } from './station-services.js';

export function buildSegmentTools(ctx: any, state: any, caps: any[]) {
  const services = buildStationServices();
  const tools: any = {};

  for (const cap of caps as any[]) {
    if (typeof cap.toolFn !== 'function' || !cap.toolName) continue;
    const fenced = !!cap.custom;
    tools[cap.toolName] = tool({
      description: cap.toolDesc,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const p = Promise.resolve(cap.toolFn(ctx, state, services, cap.config));
          return await (fenced ? withTimeout(p, 8000) : p);
        } catch (err: any) {
          return { error: err?.message || String(err) };
        }
      },
    });
  }

  return tools;
}

// Resolve `p`, or reject after `ms` — keeps an operator skill's tool.mjs from
// stalling the segment tick indefinitely.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`tool timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}
