// Single source of truth for the TTS engine picker, shared by PersonaVoiceCard and
// TtsSection. No React, no DOM — safe to unit-import.

export interface EngineMeta {
  id: string;
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
  { id: 'cloud',      label: 'Cloud',      blurb: 'OpenAI · ElevenLabs · Fish' },
  { id: 'remote',     label: 'Remote',     blurb: 'Self-hosted HTTP endpoint' },
];

// The persona-only "follow the station" card, offered FIRST so the default
// reads as a choice rather than a fallback. Kept out of ENGINES because that
// list is also the fallback slot's and the settings default-engine picker's,
// neither of which can inherit (see PERSONA_TTS_INHERIT in the controller's
// schemas/persona.ts). engineStatus()'s default branch already gives it no
// badge and never mutes it.
export const INHERIT_ENGINE: EngineMeta = {
  id: 'inherit',
  label: 'Station default',
  blurb: 'Follow Settings → TTS voice',
};

export const PERSONA_ENGINES: EngineMeta[] = [INHERIT_ENGINE, ...ENGINES];

export const ENGINE_META: Record<string, EngineMeta> = Object.fromEntries(
  [INHERIT_ENGINE, ...ENGINES].map(e => [e.id, e]),
);

export type EngineStatusTone = 'ok' | 'warn';
// Machine-readable readiness; `label` is display copy and free to change.
// 'off' = not usable now (EngineSelector mutes the card); 'starting' = transient,
// badge only, no muting.
export type EngineStatusState = 'ready' | 'starting' | 'off';

// Shown by EngineSelector as a persistent note when the *selected* engine isn't ready.
export interface EngineEnableHint {
  reason: string;
  action?: string;
}

export interface EngineStatus {
  label: string;
  tone: EngineStatusTone;
  state: EngineStatusState;
  // Present whenever state !== 'ready'.
  hint?: EngineEnableHint;
}

// SettingsResponse.tts.available. Mostly per-engine booleans; a couple carry richer
// values, hence the mixed type. `heavyEnabled` is the sidecar's configured engine
// list (TTS_HEAVY_ENGINES), null when it's unreachable or not in use.
export interface EngineAvailability {
  heavyEnabled?: string[] | null;
  cloudByProvider?: Record<string, boolean>;
  [engine: string]: boolean | string[] | null | Record<string, boolean> | undefined;
}

export interface EngineStatusOpts {
  // What to do about an unconfigured Cloud engine. The default points at the
  // Settings voice tab, which is wrong copy when you are already standing on
  // it — that page passes its own.
  cloudKeyAction?: string;
}

// Badge + machine state + enable hint in one branch tree, so the three can never
// disagree. A missing flag means "not yet known / assumed up", so only a hard
// `=== false` is flagged. `warn` is the recoverable-problem tone.
export function engineStatus(
  id: string,
  available: EngineAvailability | undefined,
  opts: EngineStatusOpts = {},
): EngineStatus {
  const a = available || {};
  switch (id) {
    case 'piper':
      return { label: 'ready', tone: 'ok', state: 'ready' };
    case 'kokoro':
      return a.kokoro === false
        ? {
            label: 'unavailable', tone: 'warn', state: 'off',
            hint: { reason: 'Kokoro is not installed in the controller image' },
          }
        : { label: 'ready', tone: 'ok', state: 'ready' };
    case 'chatterbox':
    case 'pocket-tts': {
      if (a[id] !== false) return { label: 'ready', tone: 'ok', state: 'ready' };
      // The sidecar's configured engine list says WHY: deliberately disabled vs
      // still loading vs the whole sidecar down.
      const name = ENGINE_META[id]?.label || id;
      const enabled = Array.isArray(a.heavyEnabled) ? a.heavyEnabled : null;
      if (enabled) {
        return enabled.includes(id)
          ? {
              label: 'starting…', tone: 'warn', state: 'starting', // enabled, weights still loading
              hint: { reason: `${name} is enabled but its sidecar worker is still starting`, action: 'wait for the tts-heavy health check, then reload' },
            }
          : {
              label: 'engine off', tone: 'warn', state: 'off', // disabled via TTS_HEAVY_ENGINES
              hint: { reason: `${name} is disabled by TTS_HEAVY_ENGINES`, action: `enable ${id} in TTS_HEAVY_ENGINES and recreate tts-heavy` },
            };
      }
      return {
        label: 'sidecar off', tone: 'warn', state: 'off',
        hint: { reason: 'The tts-heavy sidecar is offline', action: 'docker compose --profile tts-heavy up -d' },
      };
    }
    case 'cloud':
      return a.cloud === false
        ? {
            label: 'no key', tone: 'warn', state: 'off',
            hint: {
              reason: 'No API key is configured for the selected provider',
              action: opts.cloudKeyAction || 'add it in Settings → Voice',
            },
          }
        : { label: 'key set', tone: 'ok', state: 'ready' };
    case 'remote':
      return a.remote === false
        ? {
            label: 'unreachable', tone: 'warn', state: 'off',
            hint: { reason: 'The remote TTS endpoint is unreachable', action: 'check its URL and service status in Settings → Voice' },
          }
        : { label: 'ready', tone: 'ok', state: 'ready' };
    default:
      return { label: '', tone: 'ok', state: 'ready' };
  }
}
