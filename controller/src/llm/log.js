// Ring buffer of recent LLM calls — feeds the admin /debug surface so the
// last 30 model calls (prompt, response, latency, provider) are inspectable
// without log diving.
//
// Lives in its own module so both the SDK wrapper (sdk.js) and the prompt
// layer (dj.js) can record without an import cycle.

export const recentCalls = [];

export function record(call) {
  recentCalls.unshift(call);
  if (recentCalls.length > 30) recentCalls.length = 30;
}
