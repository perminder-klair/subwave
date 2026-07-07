// Public surface for the AI SDK primitives. The implementation lives under
// internal/strategy/** (one module per primitive) over internal/core/** (the
// failover/retry/pure runtime) and internal/provider/** (the registry). Kept as
// a barrel so every call site keeps importing from `llm/sdk.js` unchanged.

export { djText } from './internal/strategy/text.js';
export { djObject } from './internal/strategy/object.js';
export { djAgent } from './internal/strategy/agent.js';
export { isUnreachable, isQuotaOrAuthError, errReason, nearestId, stripThinking, nullableFromModel, objectFromModel } from './internal/core/pure.js';
