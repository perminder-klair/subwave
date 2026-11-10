import { TTS_CLOUD_PROVIDERS } from '../../../lib/schemas.generated';

// Normalize the provider before comparing saved credentials. Omit blank fields the controller rejects so existing values survive.

export type CloudProviderId = (typeof TTS_CLOUD_PROVIDERS)[number];

const VALID = TTS_CLOUD_PROVIDERS as readonly string[];

/** Use the raw provider when valid, otherwise the saved provider, then the enum fallback. Stale
 * forms must preserve the station provider. */
export function normalizeCloudProvider(
  raw: unknown,
  saved?: unknown,
): CloudProviderId {
  const r = String(raw ?? '').trim();
  if (VALID.includes(r)) return r as CloudProviderId;
  const s = String(saved ?? '').trim();
  if (VALID.includes(s)) return s as CloudProviderId;
  return TTS_CLOUD_PROVIDERS[0];
}

/** The one provider the controller accepts a blank voice from. Mirrors the
 *  `allowEmpty` branch in `settings.ts`; a blank voice anywhere else is
 *  omitted instead of sent. */
export function allowsBlankVoice(provider: string): boolean {
  return provider === 'openai-compatible';
}

export interface CloudSaveInput {
  /** Pass the raw form provider so credential comparisons use the same normalization. */
  provider?: string;
  model?: string;
  voice?: string;
  /** The provider currently persisted, or '' when none is. */
  savedProvider?: string;
  /** Fish always clears the legacy shared key, even without a provider transition. */
  isFish?: boolean;
}

// Omit blank fields only when retaining the same provider. On transitions send blanks so validation
// rejects incomplete settings instead of inheriting another provider's model or voice. Only
// openai-compatible accepts a blank voice.

export interface CloudSaveDecision {
  provider: CloudProviderId;
  /** Omitted when blank AND nothing moved. Sent verbatim on a transition. */
  model?: string;
  /** Sent as '' only for the provider that accepts it, or on a transition. */
  voice?: string;
  /** Whether to send `apiKey: ''`. Compared against the NORMALIZED provider. */
  clearInlineKey: boolean;
  /** True when the provider actually changed, so a caller can explain a 400. */
  isTransition: boolean;
}

export function decideCloudSave(input: CloudSaveInput): CloudSaveDecision {
  const provider = normalizeCloudProvider(input.provider, input.savedProvider);
  const saved = String(input.savedProvider ?? '').trim();
  const model = String(input.model ?? '').trim();
  const voice = String(input.voice ?? '').trim();

  const isTransition = !!saved && saved !== provider;
  const mayOmitBlanks = !isTransition;

  return {
    provider,
    ...(model || !mayOmitBlanks ? { model } : {}),
    ...(voice || !mayOmitBlanks || allowsBlankVoice(provider) ? { voice } : {}),
    clearInlineKey: !!input.isFish || isTransition,
    isTransition,
  };
}