// Direct data-provider runtime for a skill's optional tool.mjs. The Segment
// runtime calls a selected provider before asking the model to write, keeping
// data gathering outside the model's control.
//
// Built-in and custom skills run on identical footing. Every cap that ships a
// `toolFn` (loaded from its directory's tool.mjs by skills/loader.js) is invoked
// as `toolFn(ctx, state, services, config, input)`:
//   ctx      — the moment ({ time, weather, festival, dominantMood, clock })
//   state    — dedup memory carried across ticks (seen headlines, last artist…)
//   services — the curated station facade (search, library, play log, feeds…)
//   config   — the skill's own frontmatter (e.g. news' feed / feedMaxItems)
//   input    — `{}`: the provider's own default input
//
// Every skill tool now lives in state/skills (built-ins seeded there on first
// boot), so all of them run behind a hard timeout + try/catch — a slow or
// throwing skill degrades to "no data" rather than hanging the tick. The
// network-heavy built-ins (web-search, news RSS, on-this-day) must finish within
// the timeout or that tick simply yields no segment.

import { buildStationServices } from './station-services.js';
// A slow or throwing provider yields `{ error }` rather than hanging the tick.
// Inputs are the skill's own defaults (`{}`).
export async function fetchSegmentData(cap: any, ctx: any, state: any): Promise<any> {
  if (typeof cap?.toolFn !== 'function') return null;
  const services = buildStationServices();
  try {
    const p = Promise.resolve(cap.toolFn(ctx, state, services, cap.config, {}));
    return await withTimeout(p, 8000);
  } catch (err: any) {
    return { error: err?.message || String(err) };
  }
}

// The fetched tool data, rendered into the prompt. Compact but readable;
// capped so a fat feed can't crowd the system prompt out of a small context.
//
// Lives beside fetchSegmentData rather than in skills/_agent.ts because both
// code-driven (pool-mode) callers need it — the segment director and the
// co-hosted discussion path — and skills/cohosted.ts cannot import _agent.js
// without closing an eval-time cycle. _agent.ts re-exports it, so llm-bench
// and every other importer keep their existing path.
export function dataBlock(data: unknown) {
  if (data == null) return '';
  let body: string;
  try { body = JSON.stringify(data, null, 1); } catch { body = String(data); }
  if (body.length > 6000) body = body.slice(0, 6000) + '\n…(truncated)';
  return `\n\nSource data for this segment (write only from this and the current moment — do not invent facts):\n${body}`;
}

// Resolve `p`, or reject after `ms` — keeps any skill's tool.mjs from stalling
// the segment tick indefinitely.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`tool timed out after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}
