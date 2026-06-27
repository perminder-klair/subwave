// Single source of truth for the TTS engine picker: per-engine descriptors and
// a pure availability→badge mapping. Shared by the Personas page
// (PersonaVoiceCard) and the Settings page (TtsSection) so the engine list,
// blurbs and status logic live in exactly one place instead of being duplicated
// across the two surfaces. No React, no DOM — safe to unit-import.

export interface EngineMeta {
  id: string;
  // Display name shown on the card.
  label: string;
  // One-line descriptor under the name — what the operator is choosing.
  blurb: string;
}

// Order mirrors the on-air dispatcher (controller audio/tts.ts ENGINES).
export const ENGINES: EngineMeta[] = [
  { id: 'piper',      label: 'Piper',      blurb: 'Local · fast · keyless' },
  { id: 'kokoro',     label: 'Kokoro',     blurb: 'More natural, slower' },
  { id: 'chatterbox', label: 'Chatterbox', blurb: 'Clone a voice from a clip' },
  { id: 'pocket-tts', label: 'PocketTTS',  blurb: 'Multilingual · CPU-only' },
  { id: 'cloud',      label: 'Cloud',      blurb: 'OpenAI / ElevenLabs' },
];

export const ENGINE_META: Record<string, EngineMeta> = Object.fromEntries(
  ENGINES.map(e => [e.id, e]),
);

export type EngineStatusTone = 'ok' | 'warn';
export interface EngineStatus {
  label: string;
  tone: EngineStatusTone;
}

// Pure: derive an engine's status badge from the controller's availability map
// (SettingsResponse.tts.available — piper/kokoro/chatterbox/pocket-tts/cloud
// booleans). A missing/undefined flag means "not yet known / assumed up", so we
// only flag a hard `=== false`. `warn` reads as the recoverable-problem tone
// (sidecar down, no cloud key); `ok` is the quiet ready state.
export function engineStatus(
  id: string,
  available: Record<string, boolean> | undefined,
): EngineStatus {
  const a = available || {};
  switch (id) {
    case 'piper':
      return { label: 'ready', tone: 'ok' };
    case 'kokoro':
      return a.kokoro === false
        ? { label: 'unavailable', tone: 'warn' }
        : { label: 'ready', tone: 'ok' };
    case 'chatterbox':
    case 'pocket-tts':
      return a[id] === false
        ? { label: 'sidecar off', tone: 'warn' }
        : { label: 'ready', tone: 'ok' };
    case 'cloud':
      return a.cloud === false
        ? { label: 'no key', tone: 'warn' }
        : { label: 'key set', tone: 'ok' };
    default:
      return { label: '', tone: 'ok' };
  }
}
