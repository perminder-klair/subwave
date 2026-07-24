// Shared ElevenLabs key resolution. Both generator clients — sound effects
// (audio/sfx-gen.ts) and beds (audio/bed-gen.ts) — hit ElevenLabs REST endpoints
// with the same credential, and both back a "generatorReady" gate in the admin
// UI. Keeping the resolver here means beds don't depend on the sfx module and
// the two can never drift on how the key is found.

import * as settings from '../settings.js';

// Resolve the ElevenLabs key the same way llm/speech.js does: a key typed into
// Settings only counts when the cloud TTS provider is ElevenLabs; otherwise
// fall back to the ELEVENLABS_API_KEY env var.
export function elevenLabsKey(): string {
  const c = settings.get().tts?.cloud || {};
  const settingsKey = c.provider === 'elevenlabs' ? c.apiKey : '';
  return settingsKey || process.env.ELEVENLABS_API_KEY || '';
}

// True when a key is resolvable — backs the admin UI's "needs a key" state for
// both the sfx and bed generators.
export function isConfigured(): boolean {
  return !!elevenLabsKey();
}
