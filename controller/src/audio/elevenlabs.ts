// Shared ElevenLabs key resolution for the sfx and bed generator clients, so
// neither depends on the other and the two can't drift on how the key is found.

import * as settings from '../settings.js';

// Same resolution as llm/speech.js: a key in Settings counts only when the
// cloud TTS provider is ElevenLabs, else the ELEVENLABS_API_KEY env var.
export function elevenLabsKey(): string {
  const c = settings.get().tts?.cloud || {};
  const settingsKey = c.provider === 'elevenlabs' ? c.apiKey : '';
  return settingsKey || process.env.ELEVENLABS_API_KEY || '';
}

export function isConfigured(): boolean {
  return !!elevenLabsKey();
}
