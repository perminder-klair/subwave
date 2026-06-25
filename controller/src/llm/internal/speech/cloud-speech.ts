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

// Minimal language-name → ISO 639-1 map for the ElevenLabs `language` param
// (its language_code). OpenAI's gpt-4o-mini-tts takes a free-text instruction
// instead, so it needs no map. Best-effort — an unknown name falls through to
// no code (the script text still carries the language); extend as needed.
const LANG_ISO: Record<string, string> = {
  english: 'en', french: 'fr', spanish: 'es', german: 'de', italian: 'it',
  portuguese: 'pt', dutch: 'nl', polish: 'pl', russian: 'ru', turkish: 'tr',
  arabic: 'ar', hindi: 'hi', japanese: 'ja', korean: 'ko', chinese: 'zh',
  mandarin: 'zh', cantonese: 'zh', swedish: 'sv', norwegian: 'no',
  danish: 'da', finnish: 'fi', greek: 'el', czech: 'cs', romanian: 'ro',
  hungarian: 'hu', ukrainian: 'uk', indonesian: 'id', malay: 'ms',
  filipino: 'fil', tagalog: 'tl', vietnamese: 'vi', thai: 'th', hebrew: 'he',
  bulgarian: 'bg', croatian: 'hr', slovak: 'sk', tamil: 'ta', punjabi: 'pa',
  bengali: 'bn', urdu: 'ur', persian: 'fa', farsi: 'fa',
};

function isoCodeFor(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (LANG_ISO[key]) return LANG_ISO[key];
  // "brazilian portuguese" / "latin american spanish" → match the last word.
  const last = key.split(/\s+/).pop() || '';
  return LANG_ISO[last] || null;
}

// Per-provider delivery hint built from the on-air persona's character (`soul`)
// and language. OpenAI's gpt-4o*-tts honours a free-text `instructions` field
// (tts-1 / tts-1-hd ignore or reject it): the soul shapes vocal tone/pacing the
// same way it shapes the writing (issue #579), and the language is layered on as
// a pronunciation directive so a non-English script isn't read with English
// phonetics (issue #558). ElevenLabs has no free-text field — it honours only an
// ISO `language` code, so the soul can't ride there. openai-compatible servers
// vary on which fields they accept (the same reason `speed` is skipped for
// them), so they get no hint. No soul and no language → {} so the bare default
// path stays byte-identical.
function deliveryHint(
  { language, soul }: { language?: string; soul?: string },
  provider: string,
  model: string,
): { instructions?: string; language?: string } {
  const lang = String(language || '').trim();
  const character = String(soul || '').trim();
  if (provider === 'openai') {
    // `instructions` only steers gpt-4o*-tts models; tts-1 / tts-1-hd ignore or
    // reject it, so don't send it there (a 400 would drop us to an English
    // local fallback — worse than no hint).
    if (!/gpt-4o.*tts/i.test(String(model || ''))) return {};
    const parts: string[] = [];
    if (character) parts.push(`Convey this character in your tone and delivery: ${character}.`);
    if (lang) parts.push(`Speak entirely in ${lang}, using natural, native ${lang} pronunciation and accent. Do not read the text with an English accent.`);
    return parts.length ? { instructions: parts.join(' ') } : {};
  }
  if (provider === 'elevenlabs') {
    const iso = isoCodeFor(lang);
    return iso ? { language: iso } : {};
  }
  return {};
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
  { outPath, cloudOverride = null, speedScale, language, soul }: { outPath?: string; cloudOverride?: any; speedScale?: number; language?: string; soul?: string } = {},
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
    // Persona character (soul) + language → provider-native delivery hint
    // (issues #579 / #558).
    ...deliveryHint({ language, soul }, c.provider, c.model),
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
