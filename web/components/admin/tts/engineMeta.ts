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
  { id: 'kokoro',     label: 'Kokoro',     blurb: 'More natural · multilingual' },
  { id: 'chatterbox', label: 'Chatterbox', blurb: 'Clone a voice from a clip' },
  { id: 'pocket-tts', label: 'PocketTTS',  blurb: 'Multilingual · CPU-only' },
  { id: 'cloud',      label: 'Cloud',      blurb: 'OpenAI / ElevenLabs' },
  { id: 'remote',     label: 'Remote',     blurb: 'Self-hosted HTTP endpoint' },
];

export const ENGINE_META: Record<string, EngineMeta> = Object.fromEntries(
  ENGINES.map(e => [e.id, e]),
);

export type EngineStatusTone = 'ok' | 'warn';
export interface EngineStatus {
  label: string;
  tone: EngineStatusTone;
}

// The controller's availability map (SettingsResponse.tts.available). Most keys
// are per-engine booleans, but a couple carry richer values — hence the mixed
// value type. `heavyEnabled` is the tts-heavy sidecar's configured engine list
// (TTS_HEAVY_ENGINES): a string[] when the sidecar is reachable and reports it,
// null when it's unreachable / not in use.
export interface EngineAvailability {
  heavyEnabled?: string[] | null;
  cloudByProvider?: Record<string, boolean>;
  [engine: string]: boolean | string[] | null | Record<string, boolean> | undefined;
}

// Pure: derive an engine's status badge from the controller's availability map.
// A missing/undefined flag means 'not yet known / assumed up', so we only flag
// a hard `=== false`. `warn` reads as the recoverable-problem tone (sidecar
// down, engine disabled, no cloud key); `ok` is the quiet ready state.
export function engineStatus(
  id: string,
  available: EngineAvailability | undefined,
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
    case 'pocket-tts': {
      if (a[id] !== false) return { label: 'ready', tone: 'ok' };
      // Engine isn't ready. Use the sidecar's configured engine list to say
      // *why*: deliberately disabled vs still loading vs whole sidecar down.
      const enabled = Array.isArray(a.heavyEnabled) ? a.heavyEnabled : null;
      if (enabled) {
        return enabled.includes(id)
          ? { label: 'starting…', tone: 'warn' } // enabled, weights still loading
          : { label: 'engine off', tone: 'warn' }; // disabled via TTS_HEAVY_ENGINES
      }
      return { label: 'sidecar off', tone: 'warn' };
    }
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
  action?: string;
}

export function engineEnableHint(
  id: string,
  available: EngineAvailability | undefined,
): EngineEnableHint | undefined {
  const a = available || {};
  switch (id) {
    case 'kokoro':
      return a.kokoro === false
        ? { reason: 'Kokoro is not installed in the controller image' }
        : undefined;
    case 'chatterbox':
    case 'pocket-tts': {
      if (a[id] !== false) return undefined;
      const enabled = Array.isArray(a.heavyEnabled) ? a.heavyEnabled : null;
      if (enabled && enabled.includes(id)) {
        return { reason: id + ' is enabled but its sidecar worker is still starting', action: 'wait for the tts-heavy health check, then reload' };
      }
      if (enabled) {
        return { reason: id + ' is disabled by TTS_HEAVY_ENGINES', action: 'enable ' + id + ' in TTS_HEAVY_ENGINES and recreate tts-heavy' };
      }
      return { reason: 'tts-heavy sidecar is offline', action: 'docker compose --profile tts-heavy up -d' };
    }
    case 'cloud':
      return a.cloud === false
        ? { reason: 'no API key is configured for the selected provider', action: 'add it in Settings → Voice' }
        : undefined;
    case 'remote':
      return a.remote === false
        ? { reason: 'the remote TTS endpoint is unreachable', action: 'check its URL and service status in Settings → Voice' }
        : undefined;
    default:
      return undefined;
  }
}
