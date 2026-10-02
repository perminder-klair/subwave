// Single source of truth for the Cloud TTS provider picker, shared by the
// Settings voice tab and the per-persona voice slot. No React, no DOM — safe to
// unit-import. Mirrors engineMeta.ts, one level down: Cloud is an engine, these
// are the services it can speak through.

export interface CloudProviderMeta {
  id: string;
  label: string;
  // One-line descriptor under the name — what the operator is choosing.
  blurb: string;
}

// Order mirrors the controller's cloudProviders list (audio/cloudTts.ts).
export const CLOUD_PROVIDERS: CloudProviderMeta[] = [
  { id: 'openai', label: 'OpenAI', blurb: 'Cheap · fast · stock voices' },
  { id: 'elevenlabs', label: 'ElevenLabs', blurb: 'Most natural · your library' },
  { id: 'fish-audio', label: 'Fish Audio', blurb: 'Expressive · performance cues' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', blurb: 'Your own server · no key' },
  // Gemini is a CLOUD PROVIDER here, not a peer engine card: it is a managed
  // Google service reached with the same key as the LLM section, so an operator
  // picking a voice should find it in the list they already know. The engine
  // still resolves as its own id (engineMeta.GEMINI_CLOUD_PROVIDER) — this is a
  // presentation choice, not a second source of truth.
  { id: 'gemini', label: 'Gemini', blurb: 'Google TTS direct · same key as the LLM' },
];

export const CLOUD_PROVIDER_META: Record<string, CloudProviderMeta> = Object.fromEntries(
  CLOUD_PROVIDERS.map(p => [p.id, p]),
);

// Display label for a provider id, including ones not in the curated list (the
// controller is free to report more).
export function cloudProviderLabel(id: string): string {
  return CLOUD_PROVIDER_META[id]?.label || id;
}

// The process env var each managed provider's key lives in. `openai-compatible`
// has no managed-key convention and is absent on purpose.
export const CLOUD_PROVIDER_ENV_KEY: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
  'fish-audio': 'FISH_API_KEY',
};

// Whether each provider has a key behind it, for the picker's badge.
//
// `available.cloudByProvider` alone answers a narrower question than the badge
// asks: it also folds in the saved `tts.cloud.enabled` switch, so on a station
// that has never saved a Cloud engine it reads false for EVERY provider — which
// is precisely when this picker is on screen. The badge would then say "no key"
// directly above a key-status panel saying the key is present. Env presence
// (`GET /settings`'s `env` booleans, the same source that panel reads) is the
// tiebreaker; either one being true means there is a key.
export function resolveKeyPresence(
  providerIds: string[],
  cloudByProvider: Record<string, boolean> | undefined,
  env: Record<string, unknown> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of providerIds) {
    const envVar = CLOUD_PROVIDER_ENV_KEY[id];
    if (!envVar) continue; // openai-compatible resolves off its base URL instead
    const configured = cloudByProvider?.[id];
    const envSet = !!env?.[envVar];
    // An absent flag AND no env key means "not yet known" — leave the id out so
    // cloudProviderStatus renders no badge rather than a wrong one.
    if (configured === undefined && !envSet) continue;
    out[id] = !!configured || envSet;
  }
  return out;
}

export type CloudProviderStatusTone = 'ok' | 'warn';
// 'ready' = usable now; 'off' = will fall back until the operator acts;
// 'unknown' = the caller can't tell (the persona slot doesn't see the base URL),
// which renders no badge rather than a wrong one.
export type CloudProviderStatusState = 'ready' | 'off' | 'unknown';

export interface CloudProviderEnableHint {
  reason: string;
  action?: string;
}

export interface CloudProviderStatus {
  label: string;
  tone: CloudProviderStatusTone;
  state: CloudProviderStatusState;
  // Present whenever state === 'off'.
  hint?: CloudProviderEnableHint;
}

export interface CloudProviderAvailability {
  // SettingsResponse.tts.available.cloudByProvider — key-based providers only.
  cloudByProvider?: Record<string, boolean>;
  // Whether the shared openai-compatible base URL is set. `undefined` where the
  // caller can't see it (the persona slot reads the station's saved value), and
  // that gap is why the state has an explicit 'unknown'.
  compatBaseUrlSet?: boolean;
  // SettingsResponse.tts.available.gemini — the ENGINE flag, not a
  // cloudByProvider entry: Gemini is its own engine id, so the controller
  // reports its key readiness under `available.gemini`.
  gemini?: boolean;
}

export interface CloudProviderStatusOpts {
  // Where the operator adds a missing key. The Settings voice tab carries the
  // field itself, the persona slot has to point at it — same status, different
  // next step, so the copy is the caller's to supply.
  keyAction?: string;
}

// Badge + machine state + enable hint in one branch tree so the three can never
// disagree — same contract as engineMeta.engineStatus. A missing flag means
// "not yet known", so only a hard `=== false` is flagged.
export function cloudProviderStatus(
  id: string,
  availability: CloudProviderAvailability | undefined,
  opts: CloudProviderStatusOpts = {},
): CloudProviderStatus {
  const a = availability || {};
  if (id === 'gemini') {
    // Reads the engine flag, NOT cloudByProvider — Gemini is not a cloud
    // provider on the server, so it has no entry there and borrowing one would
    // report "unknown" on a station that is perfectly keyed.
    if (a.gemini === undefined) return { label: '', tone: 'ok', state: 'unknown' };
    if (a.gemini) return { label: 'key set', tone: 'ok', state: 'ready' };
    return {
      label: 'no key', tone: 'warn', state: 'off',
      hint: {
        reason: 'No Google API key is configured for Gemini TTS',
        action: opts.keyAction || 'add GOOGLE_GENERATIVE_AI_API_KEY in Settings → Voice',
      },
    };
  }
  if (id === 'openai-compatible') {
    // No key-based entry: this provider is trusted once it has somewhere to
    // send the request.
    if (a.compatBaseUrlSet === undefined) return { label: '', tone: 'ok', state: 'unknown' };
    return a.compatBaseUrlSet
      ? { label: 'server set', tone: 'ok', state: 'ready' }
      : {
          label: 'no server', tone: 'warn', state: 'off',
          hint: { reason: 'No base URL is set for your OpenAI-compatible server', action: 'enter its /v1 URL below' },
        };
  }
  const configured = a.cloudByProvider?.[id];
  if (configured === undefined) return { label: '', tone: 'ok', state: 'unknown' };
  if (configured) return { label: 'key set', tone: 'ok', state: 'ready' };
  return {
    label: 'no key', tone: 'warn', state: 'off',
    hint: {
      reason: `No API key is configured for ${cloudProviderLabel(id)}`,
      action: opts.keyAction || 'add it in Settings → Voice',
    },
  };
}
