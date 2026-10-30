// Public surface for the cloud TTS engine. Implementation in
// internal/speech/cloud-speech.ts (generateSpeech isolated there).
// Barrel so call sites keep importing from `llm/speech.js` unchanged.

export { speak, isConfigured, requestedCloudExpressionCueFamilyForPersona } from './internal/speech/cloud-speech.js';
export { listVoices } from './internal/speech/voice-catalog.js';
export { probeFishKey } from './internal/speech/fish-audio.js';
export { elevenLabsTtsModelIds } from './internal/core/pure.js';
