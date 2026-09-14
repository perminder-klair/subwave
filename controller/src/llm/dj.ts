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
  CONTEXT_FIELDS,
  normalizeContextFields,
} from './internal/prompts/context.js';
export { introBudgetPhrase, enforceIntroBudget, firstVocalMsFor } from './internal/prompts/intro-budget.js';
export { matchRequest, identifyTrackFromText } from './internal/prompts/request.js';
export {
  AIR_TIME_CLAUSE,
  REQUESTER_NAME_CLAUSE,
  REQUESTER_GREETING_CLAUSE,
  generateIntro,
  generateStationId,
  signoffPrompt,
  generateSignoff,
  generateHandoffGreeting,
  generateAdLib,
  generateLink,
  generateHourlyTime,
} from './internal/prompts/scripts.js';
export { generateBanter } from './internal/prompts/banter.js';
export {
  generateProgrammePlan,
  generateProgrammeIntro,
  generateProgrammeOutro,
  generateProgrammeFeature,
  generateProgrammeExchange,
} from './internal/prompts/programme.js';
export { PICKER_CRITERIA, pickNextTrack, showMusicLean, effectsGuidance } from './internal/prompts/picker.js';
// The authored-prompt accessor (llm/instructions/*.md), re-exported so prompt
// builders outside llm/ (broadcast/dj-agent/schemas.ts) address the blocks
// through the barrel rather than reaching into internal/.
export { instruction } from './internal/prompts/instructions.js';
// Re-exported here so the prompt builders can describe the harness's real loop
// shape without reaching past the dj/ barrel into the provider layer.
export { promptDiscoverySteps } from './internal/provider/legs.js';
export { generatePersona, generateShow, generateTheme, generateSaySuggestions } from './internal/prompts/generate.js';

// Re-exported so routes/debug.js can read the LLM call ring buffer through the
// same module that produces the calls.
export { recentCalls } from './internal/telemetry/log.js';
