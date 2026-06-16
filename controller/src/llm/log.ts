// Public surface for the LLM call ring buffer + durable pick log. Implementation
// in internal/telemetry/log.ts. Barrel so call sites keep importing from
// `llm/log.js` unchanged.

export { recentCalls, record, recordPick } from './internal/telemetry/log.js';
