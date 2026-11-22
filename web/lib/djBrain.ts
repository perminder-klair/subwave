// The SUB/WAVE DJ Brain preset: one base URL and one key, wired into the
// openai-compatible LLM and (on a plan with a voice) the openai-compatible
// cloud voice. The brain is not a provider of its own; everything downstream is
// the ordinary compat path.
//
// Both setup surfaces (the onboarding wizard's LLM step and Settings → LLM
// provider) build their save from `djBrainSettingsPatch`, so they wire the same
// fields. Whether the key includes the voice is the brain's answer, read by the
// controller's POST /settings/dj-brain/check (controller/src/llm/dj-brain.ts).

export const DJ_BRAIN_BASE_URL = 'https://my.getsubwave.com/v1';
export const DJ_BRAIN_SIGNUP_URL = 'https://my.getsubwave.com/brain';
export const DJ_BRAIN_CHAT_MODEL = 'dj-brain';
export const DJ_BRAIN_VOICE_MODEL = 'dj-brain-voice';

export interface DjBrainCheckResult {
  ok: boolean;
  voice: boolean;
  message: string;
  latencyMs: number;
}

/** Two base URLs name the same server, ignoring whitespace and trailing slashes. */
export function sameBaseUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.trim().replace(/\/+$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

/** A base URL that is the hosted brain, with or without a trailing slash. */
export function isDjBrainUrl(url: string): boolean {
  return sameBaseUrl(url, DJ_BRAIN_BASE_URL);
}

/**
 * The LLM route is the DJ Brain: openai-compatible at the hosted brain, or at
 * another URL serving the brain's own model id (a brain run elsewhere). Read
 * from what is routed, never from a key being on file, so the admin pages can't
 * call the brain wired after the provider moved on.
 */
export function isBrainRoute(llm: { provider?: string; baseUrl?: string; model?: string }): boolean {
  if (llm.provider !== 'openai-compatible') return false;
  const url = (llm.baseUrl ?? '').trim();
  if (!url) return false;
  return isDjBrainUrl(url) || (llm.model ?? '').trim() === DJ_BRAIN_CHAT_MODEL;
}

/** The cloud voice is the brain's: openai-compatible at the brain's base URL. */
export function isBrainVoice(cloud: { provider?: string; baseUrl?: string }, brainUrl: string): boolean {
  return cloud.provider === 'openai-compatible' && sameBaseUrl(cloud.baseUrl ?? '', brainUrl);
}

/**
 * Whether a Save may wire the studio voice. The plan must include it, and the
 * voice needs a key in its own slot (`tts.cloud.compatApiKey`): typed this
 * run, or already saved for a voice that points at this brain. A key on file
 * for another voice server does not count, since the brain would refuse it.
 * A blank key on a plan that gained the voice later wires nothing, rather
 * than a cloud voice with no key.
 */
export function brainVoiceWirable(input: {
  planHasVoice: boolean;
  token: string;
  /** The cloud voice points at this brain and its compat key slot holds a key. */
  brainVoiceKeyOnFile: boolean;
}): boolean {
  if (!input.planHasVoice) return false;
  return !!input.token.trim() || input.brainVoiceKeyOnFile;
}

export interface DjBrainPatchInput {
  baseUrl: string;
  /** Typed this run; blank keeps the key on file. */
  token: string;
  chatModel?: string;
  voiceModel?: string;
  voiceName?: string;
  /** The key includes the studio voice. */
  voice: boolean;
  /**
   * The station's current default engine. Only `piper` (the shipped default
   * nobody chose) or `cloud` is taken over; any other engine was a deliberate
   * pick and is left alone.
   */
  stationEngine: string;
  /**
   * The station's cloud voice is currently the brain's (openai-compatible at a
   * brain URL). A brain-only key then takes it back off, so a Studio → Brain
   * switch doesn't leave every line 429ing before its rescue.
   */
  voiceWiredToBrain?: boolean;
}

/** Whether a save may point the station's default voice at the brain. */
export function brainMayTakeEngine(stationEngine: string): boolean {
  return stationEngine === 'piper' || stationEngine === 'cloud';
}

/** The settings patch for a DJ Brain save. Pure. */
export function djBrainSettingsPatch(input: DjBrainPatchInput) {
  const url = input.baseUrl.trim();
  const token = input.token.trim();
  const key = token ? { apiKey: token } : {};
  const llm = {
    provider: 'openai-compatible',
    baseUrl: url,
    // The compat blocks reject an empty model id.
    model: input.chatModel?.trim() || DJ_BRAIN_CHAT_MODEL,
    ...key,
  };
  if (!input.voice) {
    if (!input.voiceWiredToBrain) return { llm };
    return {
      llm,
      tts: {
        ...(input.stationEngine === 'cloud' ? { defaultEngine: 'piper' } : {}),
        cloud: { enabled: false },
      },
    };
  }
  return {
    llm,
    tts: {
      // Without this the cloud block is configured but never reached.
      ...(brainMayTakeEngine(input.stationEngine) ? { defaultEngine: 'cloud' } : {}),
      cloud: {
        enabled: true,
        provider: 'openai-compatible',
        baseUrl: url,
        model: input.voiceModel?.trim() || DJ_BRAIN_VOICE_MODEL,
        voice: input.voiceName?.trim() ?? '',
        // The brain's voice honours native `speed`, so skip the local atempo
        // stretch (#942).
        sendSpeed: true,
        // The compat voice reads its own slot first (cloud-speech.ts
        // sharedCloudApiKeyForRequest), so the legacy `apiKey` slot would lose
        // to a key left there by an earlier compatible voice server.
        ...(token ? { compatApiKey: token } : {}),
      },
    },
  };
}
