// Ring buffer of recent LLM calls — feeds the admin /debug surface so the
// last MAX_CALLS model calls (prompt, response, latency, provider) are
// inspectable without log diving.
//
// Lives in its own module so both the SDK wrapper (sdk.js) and the prompt
// layer (dj.js) can record without an import cycle.

import { appendFile } from 'node:fs/promises';

const MAX_CALLS = 120;
export const recentCalls = [];

export function record(call) {
  recentCalls.unshift(call);
  if (recentCalls.length > MAX_CALLS) recentCalls.length = MAX_CALLS;
}

// Durable append-only log of auto-picker decisions. The in-memory ring buffer
// above is lost on restart; this tab-separated file in the shared state volume
// survives, so repeated-pick patterns stay reviewable after the fact.
// Best-effort: a write failure must never break a pick.
const PICKS_LOG = '/var/sub-wave/logs/picks.log';

export function recordPick({ song, reason, source }) {
  const line = [
    new Date().toISOString(),
    source || '?',
    `${song?.artist || '?'} — ${song?.title || '?'}`,
    (reason || '').replace(/\s+/g, ' ').trim(),
  ].join('\t') + '\n';
  appendFile(PICKS_LOG, line).catch(() => {});
}
