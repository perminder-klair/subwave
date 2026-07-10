// Usage-stats aggregation — feeds the admin /stats surface.
//
// Two in-memory ring buffers back the Stats page:
//   - the LLM call ring lives in llm/log.js (recentCalls)
//   - the TTS call ring lives here (ttsCalls), filled by audio/tts.js
// Both hold the last ~120 calls and are lost on controller restart by design
// — /stats reports activity since boot, nothing durable. The pure summarise*
// helpers below roll those rings (plus the DJ-log ring) into the shape the
// /stats route returns.

const MAX_TTS_CALLS = 120;
export const ttsCalls: any[] = [];

// Recorded by audio/tts.js on every speak(): one entry per spoken segment,
// success or failure, including whether the engine fell back to a local one.
// Shape: { kind, engine, requested, fellBack, ok, ms, chars, text, persona, error?, t }
// The raw ring is also exposed on /debug (tts.recentCalls) for the admin
// debug panel's per-call TTS log; summarizeTts() below only reads the
// original aggregate fields.
export function recordTts(call: any) {
  ttsCalls.unshift(call);
  if (ttsCalls.length > MAX_TTS_CALLS) ttsCalls.length = MAX_TTS_CALLS;
}

// --- generic helpers ----------------------------------------------------

function avg(values: number[]) {
  return values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function latencyStats(values) {
  if (!values.length) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: Math.round(avg(sorted)),
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

// --- cost estimation ----------------------------------------------------

// Rough per-1M-token USD pricing for the cloud providers SUB/WAVE can be
// pointed at (early-2026 list prices — treat the resulting figure as an
// estimate, not a bill). Local Ollama is free; anything unmatched is reported
// `priced: false` so the UI can flag the total as partial rather than imply $0.
const PRICING = [
  { provider: 'anthropic', match: 'opus',        in: 15,    out: 75 },
  { provider: 'anthropic', match: 'sonnet',      in: 3,     out: 15 },
  { provider: 'anthropic', match: 'haiku',       in: 1,     out: 5 },
  { provider: 'openai',    match: 'gpt-4o-mini', in: 0.15,  out: 0.6 },
  { provider: 'openai',    match: 'gpt-4o',      in: 2.5,   out: 10 },
  { provider: 'openai',    match: 'o3',          in: 2,     out: 8 },
  { provider: 'openai',    match: 'o1',          in: 15,    out: 60 },
  { provider: 'google',    match: 'flash',       in: 0.075, out: 0.3 },
  { provider: 'google',    match: 'pro',         in: 1.25,  out: 5 },
];

// modelLabel is "<provider>:<model>[:…]" as built by llm/provider.js.
export function estimateCost(modelLabel, usage) {
  const label = (modelLabel || '').toLowerCase();
  const provider = label.split(':')[0];
  if (provider === 'ollama') return { usd: 0, priced: true };
  const row = PRICING.find(p => p.provider === provider && label.includes(p.match));
  if (!row) return { usd: 0, priced: false };
  const usd = (usage.input / 1e6) * row.in + (usage.output / 1e6) * row.out;
  return { usd, priced: true };
}

// --- LLM summary --------------------------------------------------------

// Roll the LLM call ring (llm/log.js recentCalls) into success/latency/token
// /cost totals plus per-kind and per-model breakdowns. `calls` is newest-first.
export function summarizeLlm(calls) {
  const ok = calls.filter(c => c.ok);
  const tokens = { input: 0, output: 0, total: 0 };
  let cost = 0;
  let allPriced = true;
  let anyTokens = false;

  for (const c of ok) {
    const u = c.usage;
    if (u && u.total) {
      anyTokens = true;
      tokens.input += u.input || 0;
      tokens.output += u.output || 0;
      tokens.total += u.total || 0;
      const e = estimateCost(c.model, u);
      cost += e.usd;
      if (!e.priced) allPriced = false;
    }
  }

  const kinds = new Map();
  for (const c of calls) {
    const k = c.kind || 'unknown';
    let g = kinds.get(k);
    if (!g) { g = { kind: k, count: 0, ok: 0, ms: [], tokens: 0 }; kinds.set(k, g); }
    g.count++;
    if (c.ok) g.ok++;
    if (typeof c.ms === 'number') g.ms.push(c.ms);
    if (c.usage?.total) g.tokens += c.usage.total;
  }
  const byKind = [...kinds.values()]
    .map(g => ({ kind: g.kind, count: g.count, ok: g.ok, avgMs: Math.round(avg(g.ms)), tokens: g.tokens }))
    .sort((a, b) => b.count - a.count);

  const models = new Map();
  for (const c of ok) {
    const m = c.model || 'unknown';
    let g = models.get(m);
    if (!g) { g = { model: m, count: 0, tokens: 0, cost: 0, priced: true }; models.set(m, g); }
    g.count++;
    if (c.usage?.total) {
      g.tokens += c.usage.total;
      const e = estimateCost(m, c.usage);
      g.cost += e.usd;
      if (!e.priced) g.priced = false;
    }
  }
  const byModel = [...models.values()]
    .map(g => ({ model: g.model, count: g.count, tokens: g.tokens, costUsd: g.cost, priced: g.priced }))
    .sort((a, b) => b.count - a.count);

  const agentCalls = calls.filter(c => c.via === 'ai-sdk:agent' && c.ok);
  const agent = {
    calls: agentCalls.length,
    avgSteps: round1(avg(agentCalls.map(c => c.steps || 0))),
    avgTools: round1(avg(agentCalls.map(c => c.toolCalls?.length || 0))),
  };

  return {
    window: 120,
    count: calls.length,
    ok: ok.length,
    failed: calls.length - ok.length,
    successRate: calls.length ? ok.length / calls.length : null,
    latency: latencyStats(calls.map(c => c.ms).filter(n => typeof n === 'number')),
    tokens: anyTokens ? tokens : null,
    cost: anyTokens ? { usd: cost, complete: allPriced } : null,
    byKind,
    byModel,
    agent,
  };
}

// --- TTS summary --------------------------------------------------------

function groupCalls(calls, keyFn, keyName) {
  const m = new Map();
  for (const c of calls) {
    const k = keyFn(c) || 'unknown';
    let g = m.get(k);
    if (!g) { g = { key: k, count: 0, ok: 0, ms: [], chars: 0 }; m.set(k, g); }
    g.count++;
    if (c.ok) g.ok++;
    if (typeof c.ms === 'number') g.ms.push(c.ms);
    g.chars += c.chars || 0;
  }
  return [...m.values()]
    .map(g => ({ [keyName]: g.key, count: g.count, ok: g.ok, avgMs: Math.round(avg(g.ms)), chars: g.chars }))
    .sort((a, b) => b.count - a.count);
}

// Roll the TTS call ring into success/latency/fallback totals plus per-engine
// and per-kind breakdowns. `calls` is newest-first.
export function summarizeTts(calls) {
  const ok = calls.filter(c => c.ok);
  const fellBack = calls.filter(c => c.fellBack);
  return {
    window: 120,
    count: calls.length,
    ok: ok.length,
    failed: calls.length - ok.length,
    fellBack: fellBack.length,
    fallbackRate: calls.length ? fellBack.length / calls.length : null,
    latency: latencyStats(calls.map(c => c.ms).filter(n => typeof n === 'number')),
    chars: calls.reduce((a, c) => a + (c.chars || 0), 0),
    byEngine: groupCalls(calls, c => c.engine, 'engine'),
    byKind: groupCalls(calls, c => c.kind, 'kind'),
  };
}

// --- DJ-log summary -----------------------------------------------------

// Count the DJ-log ring (broadcast/queue.js djLog) by event kind — the raw
// list is on /debug, but never rolled up by kind.
export function summarizeDjLog(djLog) {
  const m = new Map();
  for (const e of djLog) m.set(e.kind || 'unknown', (m.get(e.kind || 'unknown') || 0) + 1);
  return {
    count: djLog.length,
    byKind: [...m.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
  };
}

// --- Requests summary ---------------------------------------------------

// Roll the listener-request ring (broadcast/request-log.js recentRequests) into
// success/latency totals plus resolution-path, pick-source and requester
// breakdowns. The Dash carries the per-request review (what was asked + the full
// trace); this is the aggregate the Stats page shows. `requests` is newest-first,
// each entry the durable record written by routes/request.ts recordOutcome —
// terminal `status` is 'resolved' or 'failed'.
export function summarizeRequests(requests) {
  const resolved = requests.filter(r => r.status === 'resolved');
  const misses = requests.filter(r => r.artistMiss);

  // Group by a key, dropping empty keys; `withOk` also carries the resolved
  // count per group (used by the by-path breakdown).
  const tally = (keyFn, keyName, withOk = false) => {
    const m = new Map();
    for (const r of requests) {
      const k = keyFn(r);
      if (!k) continue;
      let g = m.get(k);
      if (!g) { g = { key: k, count: 0, ok: 0 }; m.set(k, g); }
      g.count++;
      if (r.status === 'resolved') g.ok++;
    }
    return [...m.values()]
      .map(g => (withOk ? { [keyName]: g.key, count: g.count, ok: g.ok } : { [keyName]: g.key, count: g.count }))
      .sort((a, b) => b.count - a.count);
  };

  return {
    window: 150,
    count: requests.length,
    resolved: resolved.length,
    failed: requests.length - resolved.length,
    successRate: requests.length ? resolved.length / requests.length : null,
    latency: latencyStats(requests.map(r => r.ms).filter(n => typeof n === 'number')),
    artistMiss: {
      count: misses.length,
      rate: requests.length ? misses.length / requests.length : null,
    },
    byPath: tally(r => r.path, 'path', true),
    byPickSource: tally(r => r.pickSource, 'source'),
    topRequesters: tally(r => r.requester, 'requester').slice(0, 8),
  };
}
