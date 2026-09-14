// Public surface for the LLM call ring buffer + durable pick log. Implementation
// in internal/telemetry/log.ts. Barrel so call sites keep importing from
// `llm/log.js` unchanged.

export { recentCalls, record, recordPick, lifetimeTokenCount } from './internal/telemetry/log.js';

// Done-tool retry churn (D2) — the strategy layer's two "stopped without
// calling done" retry sites record here; /debug reports the since-boot count
// so an operator can see the retry rate per model choice.
export { recordAgentRetry, agentDoneRetryCount } from './internal/telemetry/log.js';

// Daily LLM token tally — the running count the budget cap is enforced against.
// `seedDailyUsageFromLog` is called once at boot (server.ts) so a mid-day
// restart resumes the count instead of resetting it. `budgetMode` (the pure
// normal/soft/hard policy) is re-exported here so the whole budget surface sits
// behind one barrel; broadcast/dj-budget.ts combines it with settings.llm.
export { dailyTokensUsed, seedDailyUsageFromLog } from './internal/telemetry/budget.js';
export { budgetMode } from './internal/core/pure.js';

// Downloadable form of the ring buffer above (#1485). Pure serialisers only —
// the /debug route pairs them with `dj.recentCalls`, which is the same array
// this barrel exports. Exporting what is already rendered, verbatim: no field is
// added and none is filtered.
export {
  llmCallExportFormat,
  llmCallExportFilename,
  serializeLlmCalls,
  LLM_CALL_EXPORT_CONTENT_TYPE,
  type LlmCallExportFormat,
} from './internal/telemetry/export.js';

// Raw-request debug log status (the rolling ${STATE_DIR}/logs/llm-debug.log).
// Re-exported here so the /debug route can report the toggle state + file path
// without reaching into internal/. The capture itself lives in the provider
// registry's debugFetch.
export {
  rawDebugEnabled,
  rawDebugEnabledViaEnv,
  setRawDebugStderrMirror,
  LLM_DEBUG_LOG,
  LLM_DEBUG_MAX,
} from './internal/telemetry/raw-debug.js';
