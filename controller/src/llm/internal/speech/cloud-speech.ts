// Cloud TTS engine — generates a voice file via the AI SDK's speech models
// (OpenAI or ElevenLabs). Sits behind tts.js as the `cloud` engine, peer to
// the local `piper` and `kokoro` engines.
//
// The AI SDK has no provider for Piper or Kokoro (they're local CLIs), so
// this only covers cloud voices — tts.js still owns the dispatch + fallback.

import { experimental_generateSpeech as generateSpeech } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';

// Default TTS model per cloud provider. A model id is provider-specific — an
// OpenAI id like "gpt-4o-mini-tts" is invalid against ElevenLabs and vice
// versa. When a persona overrides the provider away from the global Cloud
// engine setting, the global `tts.cloud.model` no longer applies, so we fall
// back to the new provider's default here. Mirror of CLOUD_MODELS[*][0] in
// web/lib/cloudVoices.js.
const CLOUD_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini-tts',
  elevenlabs: 'eleven_flash_v2_5',
};

// Speech-rate multiplier limits per provider. A value outside the supported
// range makes the provider API reject the request, so we clamp before calling.
// ElevenLabs allows 0.7–1.2; OpenAI allows 0.25–4.0.
const SPEED_RANGE: Record<string, [number, number]> = {
  elevenlabs: [0.7, 1.2],
  openai: [0.25, 4.0],
};

function clampSpeed(speed: any, provider: string) {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  const [lo, hi] = SPEED_RANGE[provider] || [0.25, 4.0];
  return Math.min(hi, Math.max(lo, n));
}

function cloudCfg() {
  return settings.get().tts?.cloud || {};
}

function speechModel(c: any) {
  if (c.provider === 'elevenlabs') {
    const provider = createElevenLabs(c.apiKey ? { apiKey: c.apiKey } : {});
    return provider.speech(c.model);
  }
  if (c.provider === 'openai-compatible') {
    // Any self-hosted server that exposes /v1/audio/speech (Chatterbox,
    // Qwen3 TTS, VibeVoice, etc.). Mirrors llm/provider.ts — most local
    // servers accept any non-empty key, so fall back to a placeholder.
    const provider = createOpenAI({
      baseURL: c.baseUrl,
      apiKey: c.apiKey || 'unused',
      name: 'openai-compatible',
    });
    return provider.speech(c.model);
  }
  const provider = createOpenAI(c.apiKey ? { apiKey: c.apiKey } : {});
  return provider.speech(c.model);
}

// True when the cloud engine has a usable key (from Settings or the
// provider's env var). tts.js calls this before routing to `cloud` so a
// misconfigured station silently uses the local engine instead.
//
// `providerOverride` asks about a *persona's* provider rather than the global
// Cloud-engine provider — a persona on ElevenLabs needs ELEVENLABS_API_KEY
// even when the global provider is OpenAI.
export function isConfigured(providerOverride: string | null = null) {
  const c = cloudCfg();
  // Operator's explicit "Off" switch — cloud reports unavailable even with a key.
  if (c.enabled === false) return false;
  const provider = providerOverride || c.provider;
  if (!provider) return false;
  // openai-compatible has no managed-API key convention. It's configured iff
  // the operator gave us a baseUrl + a model — the global model is always
  // used since there's no per-provider default to fall back to.
  if (provider === 'openai-compatible') {
    return !!(c.baseUrl && c.model);
  }
  // When overriding provider the model is auto-resolved per provider, so it's
  // always present; only the global-provider path depends on the stored model.
  const model = (providerOverride && providerOverride !== c.provider)
    ? CLOUD_DEFAULT_MODELS[providerOverride]
    : c.model;
  if (!model) return false;
  const envKey = provider === 'elevenlabs'
    ? process.env.ELEVENLABS_API_KEY
    : process.env.OPENAI_API_KEY;
  // A key typed into Settings only counts for the global provider it was
  // entered against — not for a persona that overrode to a different one.
  const settingsKey = (!providerOverride || providerOverride === c.provider)
    ? c.apiKey
    : null;
  return !!(settingsKey || envKey);
}

// Generate speech and write it to a file. Returns the path — same contract as
// piper.speak / kokoro.speak so tts.js treats all three engines alike.
//
// `cloudOverride` ({ provider, voice }) lets a persona pick its own cloud
// provider + voice while still sharing the global model + apiKey from Settings.
export async function speak(
  text: string,
  { outPath, cloudOverride = null, speedScale }: { outPath?: string; cloudOverride?: any; speedScale?: number } = {},
) {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  const base = cloudCfg();
  const c: any = { ...base, ...(cloudOverride || {}) };
  // A model id is provider-specific. When a persona overrode the provider away
  // from the global Cloud engine setting, the stored model belongs to the
  // wrong provider — swap in the new provider's default. openai-compatible
  // has no default (server-specific), so personas overriding *to* it must
  // share whatever the operator typed as the global model.
  if (cloudOverride?.provider && cloudOverride.provider !== base.provider) {
    c.model = CLOUD_DEFAULT_MODELS[cloudOverride.provider] || c.model;
  }
  // openai-compatible servers always need the global baseUrl from settings —
  // persona-level overrides only carry provider+voice.
  if (c.provider === 'openai-compatible') {
    c.baseUrl = base.baseUrl;
    c.apiKey = base.apiKey;
  }

  // Speech rate — the per-call speedScale (daypart energy) composes on top of
  // CLOUD_TTS_SPEED / TTS_SPEED, then clamped to the provider's range. Only
  // sent when it differs from default so default stations are unaffected and
  // providers that ignore the field never see it. Skipped for openai-compatible
  // — local engines vary on whether they accept `speed`.
  const isCompat = c.provider === 'openai-compatible';
  const speed = isCompat
    ? 1.0
    : clampSpeed(config.tts.cloudSpeed * (speedScale != null ? speedScale : 1), c.provider);

  const result = await generateSpeech({
    model: speechModel(c),
    text,
    voice: c.voice || undefined,
    ...(speed !== 1.0 ? { speed } : {}),
    // ElevenLabs gates 44.1 kHz PCM/WAV behind paid tiers — a free/lower-tier
    // key 403s ("Forbidden") on pcm_44100. mp3 is allowed on every tier and
    // OpenAI honours it too, so it's the safe cross-provider request.
    // openai-compatible: omit the param entirely and let the server choose —
    // `result.audio.format` below drives the file extension regardless.
    ...(isCompat ? {} : { outputFormat: c.provider === 'elevenlabs' ? 'mp3' : 'wav' }),
  });

  const fmt = result.audio.format || 'mp3';
  const finalPath = outPath
    || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.${fmt}`);
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(finalPath, Buffer.from(result.audio.uint8Array));
  return finalPath;
}
