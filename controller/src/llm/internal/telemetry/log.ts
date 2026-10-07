// Keep telemetry below core and prompts in the dependency graph to avoid import cycles.

import { appendFile } from 'node:fs/promises';
import { statSync, renameSync } from 'node:fs';
import { STATE_DIR } from '../../../config.js';
import { logEvent, cap } from '../../../observability/events.js';
import { addDailyUsage } from './budget.js';

const MAX_CALLS = 120;
export const recentCalls: any[] = [];

// Monotonic, since-boot sum of tokens reported by successful calls. Unlike the
// ring buffer above (a rolling window of the last MAX_CALLS calls), this only
// ever climbs — it backs the listener-facing token ticker on the player. Reset
// to 0 on restart by design, like every other in-memory stat (see stats.ts).
let lifetimeTokens = 0;
export function lifetimeTokenCount() {
  return lifetimeTokens;
}

function logSuccess(call: any) {
  if (!call.ok) return;
  const usage = Number.isFinite(call.usage?.input) && Number.isFinite(call.usage?.output)
    ? `${call.usage.input}/${call.usage.output} tokens`
    : 'token usage unavailable';
  console.log(`[${call.kind}] ${call.model} via ${call.via} — ${call.ms}ms, ${usage}`);
}

export function record(call: any) {
  recentCalls.unshift(call);
  if (recentCalls.length > MAX_CALLS) recentCalls.length = MAX_CALLS;
  // Metadata only: prompts and responses stay in /debug and events.jsonl.
  // One line per success makes long-running container logs attributable by
  // generator without enabling raw request capture (#1435).
  logSuccess(call);
  // Mirror summarizeLlm: only successful calls that report usage contribute.
  if (call.ok && call.usage?.total) lifetimeTokens += call.usage.total;

  // Today's tally is deliberately NOT under the `ok` guard above (issue #1195).
  // The provider bills for a call that throws just the same, and djAgent's
  // cascade can burn several legs' worth before it gives up — a pick that runs
  // main → recovery → terminal collapse and still throws spent three billable
  // calls, then falls back to the pool picker (a fourth, which IS counted).
  // Counting only successes made the cap a cap on *successful* spend, which an
  // operator on a flaky model could overshoot via failures alone. The number is
  // already on the record: failureDiagnostics() (core/pure.ts) normalises the
  // summed `err.usage` that agent.ts attaches on the throw, and failover.ts's
  // recordFailure spreads it on. The lifetime ticker stays success-only on
  // purpose — it's the listener-facing counter on the player and mirrors
  // summarizeLlm (stats.ts), so /stats semantics are unchanged.
  //
  // Not every failure carries usage: provider HTTP errors and deadline aborts
  // throw bare, so this makes the cap more honest, not exhaustive.
  if (call.usage?.total) addDailyUsage(call.usage.total);

  // Durable, trace-correlated event. The ring buffer above is lost on restart
  // and uncorrelated; this lands on the unified events.jsonl timeline.
  logEvent('llm', {
    kind: call.kind,
    ok: call.ok,
    ms: call.ms,
    model: call.model,
    via: call.via,
    usage: call.usage || null,
    // AI SDK 7 per-step performance (model wait, per-tool ms, tokens/sec) and
    // provider warnings — e.g. a provider that ignored the reasoning param.
    perf: call.perf || undefined,
    warnings: call.warnings || undefined,
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
      // Picker tools return either a bare track array or, when empty, a
      // { tracks: [], note, rule } hint object — count both shapes so an
      // empty-with-hint result still logs resultCount: 0 (the log analyzer
      // keys on it), not undefined.
      resultCount: Array.isArray(tc.result) ? tc.result.length
        : Array.isArray(tc.result?.tracks) ? tc.result.tracks.length
        : undefined,
    });
  }
}

// Durable append-only log of auto-picker decisions. The in-memory ring buffer
// above is lost on restart; this tab-separated file in the shared state volume
// survives, so repeated-pick patterns stay reviewable after the fact.
// Best-effort: a write failure must never break a pick.
const PICKS_LOG = `${STATE_DIR}/logs/picks.log`;
// Rotate to one .old backup at this cap — same policy as subsonic.log and
// requests.log. Checked on module load and every 500 picks; this was the one
// append log in the state dir with no size bound at all.
const PICKS_LOG_MAX_BYTES = 10 * 1024 * 1024;

function maybeRotatePicksLog() {
  try {
    if (statSync(PICKS_LOG).size > PICKS_LOG_MAX_BYTES) {
      renameSync(PICKS_LOG, `${PICKS_LOG}.old`);
    }
  } catch {}
}

maybeRotatePicksLog();
let _picksSinceRotateCheck = 0;

// Done-tool retry churn (D2, request-hardening): counted at the strategy
// layer's two retry log sites (llm/internal/strategy/agent.ts, "stopped
// without calling done" / "recovery also stopped without calling done") so
// /debug can show the rate per model choice — a live station logging ~20 of
// these in 5h is the same symptom the corrective re-pick (repickFromSeen /
// repickRequestFromSeen in broadcast/dj-agent.ts) exists to salvage, and this
// is the counter that tells an operator how often that symptom is firing.
// Monotonic since-boot count, like lifetimeTokens above — resets on restart.
let agentDoneRetries = 0;
export function recordAgentRetry() { agentDoneRetries += 1; }
export function agentDoneRetryCount() { return agentDoneRetries; }

export function recordPick({ song, reason, source }: { song: any; reason?: string; source?: string }) {
  if (++_picksSinceRotateCheck >= 500) {
    _picksSinceRotateCheck = 0;
    maybeRotatePicksLog();
  }
  const line = [
    new Date().toISOString(),
    source || '?',
    `${song?.artist || '?'} — ${song?.title || '?'}`,
    (reason || '').replace(/\s+/g, ' ').trim(),
  ].join('\t') + '\n';
  appendFile(PICKS_LOG, line).catch(() => {});
}
