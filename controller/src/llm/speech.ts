// Public surface for the cloud TTS engine. Implementation in
// internal/speech/cloud-speech.ts (generateSpeech isolated there).
// Barrel so call sites keep importing from `llm/speech.js` unchanged.

export { speak, isConfigured } from './internal/speech/cloud-speech.js';
export { listVoices, normalizeVoiceList } from './internal/speech/voice-catalog.js';
export type { CloudVoice, VoiceListResult } from './internal/speech/voice-catalog.js';
