// Ring buffer of recent LLM calls — feeds the admin /debug surface so the
// last MAX_CALLS model calls (prompt, response, latency, provider) are
// inspectable without log diving.
//
// Lives low in the dependency graph so both the failover harness (core) and the
// prompt layer (prompts) can record without an import cycle.

import { appendFile } from 'node:fs/promises';
import { STATE_DIR } from '../../../config.js';
import { logEvent, cap } from '../../../observability/events.js';

const MAX_CALLS = 120;
export const recentCalls: any[] = [];

export function record(call: any) {
  recentCalls.unshift(call);
  if (recentCalls.length > MAX_CALLS) recentCalls.length = MAX_CALLS;

  // Durable, trace-correlated event. The ring buffer above is lost on restart
  // and uncorrelated; this lands on the unified events.jsonl timeline.
  logEvent('llm', {
    kind: call.kind,
    ok: call.ok,
    ms: call.ms,
    model: call.model,
    via: call.via,
    usage: call.usage || null,
    error: call.error || null,
    system: cap(call.system),
    prompt: cap(call.user),
    messages: Array.isArray(call.messages)
      ? call.messages.map((m: any) => ({ role: m.role, content: cap(m.content, 2000) }))
      : undefined,
    response: cap(call.response),
    steps: call.steps,
    toolCount: Array.isArray(call.toolCalls) ? call.toolCalls.length : undefined,
  });

  // One event per agent tool call, so tool use is individually on the timeline.
  for (const tc of call.toolCalls || []) {
    logEvent('tool', {
      kind: call.kind,
      name: tc.name,
      args: cap(JSON.stringify(tc.args ?? null), 1000),
      resultCount: Array.isArray(tc.result) ? tc.result.length : undefined,
    });
  }
}

// Durable append-only log of auto-picker decisions. The in-memory ring buffer
// above is lost on restart; this tab-separated file in the shared state volume
// survives, so repeated-pick patterns stay reviewable after the fact.
// Best-effort: a write failure must never break a pick.
const PICKS_LOG = `${STATE_DIR}/logs/picks.log`;

export function recordPick({ song, reason, source }: { song: any; reason?: string; source?: string }) {
  const line = [
    new Date().toISOString(),
    source || '?',
    `${song?.artist || '?'} — ${song?.title || '?'}`,
    (reason || '').replace(/\s+/g, ' ').trim(),
  ].join('\t') + '\n';
  appendFile(PICKS_LOG, line).catch(() => {});
}
