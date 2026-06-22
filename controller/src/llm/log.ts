// Public surface for the LLM call ring buffer + durable pick log. Implementation
// in internal/telemetry/log.ts. Barrel so call sites keep importing from
// `llm/log.js` unchanged.

export { recentCalls, record, recordPick, lifetimeTokenCount } from './internal/telemetry/log.js';

// Raw-request debug log status (the rolling ${STATE_DIR}/logs/llm-debug.log).
// Re-exported here so the /debug route can report the toggle state + file path
// without reaching into internal/. The capture itself lives in the provider
// registry's debugFetch.
export {
  rawDebugEnabled,
  rawDebugEnabledViaEnv,
  LLM_DEBUG_LOG,
  LLM_DEBUG_MAX,
} from './internal/telemetry/raw-debug.js';
