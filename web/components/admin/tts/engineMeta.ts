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
  { id: 'remote',     label: 'Remote',     blurb: 'Self-hosted HTTP endpoint' },
];

export const ENGINE_META: Record<string, EngineMeta> = Object.fromEntries(
  ENGINES.map(e => [e.id, e]),
);

// The controller's availableEngines() shape. Missing/undefined key means
// "not yet known / assumed up" — consumers only gate on `=== false`.
export interface TtsAvailable {
  piper?: boolean;
  kokoro?: boolean;
  chatterbox?: boolean;
  'pocket-tts'?: boolean;
  cloud?: boolean;
  remote?: boolean;
  pocketTtsCloning?: boolean | null;
  cloudByProvider?: Record<string, boolean>;
}

export type EngineStatusTone = 'ok' | 'warn';
export interface EngineStatus {
  label: string;
  tone: EngineStatusTone;
}

// Pure: derive an engine's status badge from the controller's availability map.
// A missing/undefined flag means "not yet known / assumed up", so we only flag
// a hard `=== false`. `warn` is the recoverable-problem tone (sidecar down, no
// cloud key); `ok` is the quiet ready state.
export function engineStatus(
  id: string,
  available: TtsAvailable | undefined,
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
      return a.chatterbox === false
        ? { label: 'sidecar off', tone: 'warn' }
        : { label: 'ready', tone: 'ok' };
    case 'pocket-tts':
      return a['pocket-tts'] === false
        ? { label: 'sidecar off', tone: 'warn' }
        : { label: 'ready', tone: 'ok' };
    case 'cloud':
      return a.cloud === false
        ? { label: 'no key', tone: 'warn' }
        : { label: 'key set', tone: 'ok' };
    case 'remote':
      return a.remote === false
        ? { label: 'unreachable', tone: 'warn' }
        : { label: 'ready', tone: 'ok' };
    default:
      return { label: '', tone: 'ok' };
  }
}

export interface EngineEnableHint {
  reason: string;
  // The exact shell command or UI action needed to enable this engine.
  action?: string;
}

// Pure: derive the "how to enable this engine" hint for an unavailable engine.
// Returns undefined when the engine is available or the hint doesn't apply.
export function engineEnableHint(
  id: string,
  available: TtsAvailable | undefined,
): EngineEnableHint | undefined {
  const a = available || {};
  switch (id) {
    case 'kokoro':
      return a.kokoro === false
        ? { reason: 'Kokoro model or venv not present on the controller' }
        : undefined;
    case 'chatterbox':
      return a.chatterbox === false
        ? {
            reason: 'tts-heavy sidecar is offline',
            action: 'docker compose --profile tts-heavy up -d',
          }
        : undefined;
    case 'pocket-tts':
      return a['pocket-tts'] === false
        ? {
            reason: 'tts-heavy sidecar is offline',
            action: 'docker compose --profile tts-heavy up -d',
          }
        : undefined;
    case 'cloud':
      return a.cloud === false
        ? { reason: 'no API key configured for this provider', action: 'add it in Settings → Voice' }
        : undefined;
    case 'remote':
      return a.remote === false
        ? { reason: 'remote endpoint is unreachable', action: 'check the URL in Settings → Voice' }
        : undefined;
    default:
      return undefined;
  }
}
