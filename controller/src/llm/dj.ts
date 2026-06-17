// Public surface for the DJ prompt layer. Implementation split under
// internal/prompts/** by concern (system, context, intro-budget, request,
// scripts, picker). Barrel so call sites keep importing from `llm/dj.js` unchanged.

export { djSystem, lengthMode, lengthPhrase } from './internal/prompts/system.js';
export {
  ANGLES,
  pickAngle,
  randomSeed,
  buildContextLines,
  decoratePrompt,
} from './internal/prompts/context.js';
export { introBudgetPhrase, enforceIntroBudget } from './internal/prompts/intro-budget.js';
export { matchRequest, identifyTrackFromText } from './internal/prompts/request.js';
export {
  generateIntro,
  generateStationId,
  generateAdLib,
  generateLink,
  generateHourlyTime,
} from './internal/prompts/scripts.js';
export { PICKER_CRITERIA, pickNextTrack } from './internal/prompts/picker.js';

// Re-exported so routes/debug.js can read the LLM call ring buffer through the
// same module that produces the calls.
export { recentCalls } from './internal/telemetry/log.js';
