// Cloud TTS engine (OpenAI, ElevenLabs, Fish Audio), sitting behind tts.js as
// the `cloud` engine. tts.js still owns the dispatch + fallback.

import { generateSpeech } from 'ai';
import { resolvePersonaVoiceSlot } from '../../../audio/persona-engine.js';
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { createOpenAI } from '@ai-sdk/openai';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';
import { transcodeAudio, hasFfmpeg } from '../../../audio/audio-import.js';
import { compatParamsBody } from '../../../settings/compat-params.js';
import { cloudExpressionCueFamily, isElevenLabsV3, snapV3Stability, soulBrief } from '../core/pure.js';
import { FISH_DEFAULT_MODEL, synthesizeFish } from './fish-audio.js';

// Default TTS model per cloud provider. A model id is provider-specific, so a
// persona that overrides the provider away from the global setting cannot use
// the global `tts.cloud.model`. Mirror of CLOUD_MODELS[*][0] in
// web/lib/cloudVoices.js.
const CLOUD_DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini-tts',
  elevenlabs: 'eleven_flash_v2_5',
  'fish-audio': FISH_DEFAULT_MODEL,
};

// Pure resolution rules mirroring speak() below plus resolveEngine() in
// audio/tts.ts: the persona owns the engine when set, else the station
// defaultEngine speaks, and a persona that overrode the provider takes that
// provider's default model. An unrecognised persona engine fails CLOSED to '',
// which also means "not cloud", so callers apply no model-specific hints. Pinned
// in scripts/llm-pure.test.ts so the mirror claim is testable.
//
// Legacy inline keys and compatibility-server bearers occupy separate slots, so
// a compat persona keeps its credential without forwarding an OpenAI/ElevenLabs
// secret to an arbitrary URL. Fish stays env/secrets-only.
export function sharedCloudApiKeyForRequest(
  provider: string,
  globalProvider: string,
  inlineKey: string | null | undefined,
  compatKey: string | null | undefined,
): string {
  if (provider === 'fish-audio') return '';
  if (provider === 'openai-compatible') {
    // The legacy slot is accepted only when compatibility is also the globally
    // selected provider.
    return compatKey || (globalProvider === 'openai-compatible' ? inlineKey || '' : '');
  }
  return provider === globalProvider ? inlineKey || '' : '';
}

export function modelForCloudRequest(
  globalProvider: string,
  globalModel: string,
  override: { provider?: string; model?: string } | null | undefined,
): string {
  if (override?.model) return override.model;
  if (override?.provider && override.provider !== globalProvider) {
    return CLOUD_DEFAULT_MODELS[override.provider] || globalModel;
  }
  return globalModel;
}

export function resolveCloudProvider(
  personaTts: { engine?: string; cloudProvider?: string } | null | undefined,
  cfg: { defaultEngine?: string; provider?: string },
): string {
  const explicit = personaTts?.engine === 'cloud';
  if (!explicit && (personaTts?.engine || cfg.defaultEngine !== 'cloud')) return '';
  return (explicit ? personaTts?.cloudProvider : '') || cfg.provider || '';
}

export function resolveCloudModel(
  personaTts: { engine?: string; cloudProvider?: string } | null | undefined,
  cfg: { defaultEngine?: string; provider?: string; model?: string },
): string {
  const explicit = personaTts?.engine === 'cloud';
  if (!explicit && (personaTts?.engine || cfg.defaultEngine !== 'cloud')) return '';
  const personaProvider = explicit ? personaTts?.cloudProvider : '';
  if (personaProvider && personaProvider !== cfg.provider) {
    return CLOUD_DEFAULT_MODELS[personaProvider] || cfg.model || '';
  }
  return cfg.model || '';
}

type CloudPersona = {
  tts?: { engine?: string; cloudProvider?: string };
} | null | undefined;

// The model `persona` actually resolves to at speak() time, or '' when it won't
// be voiced by a usable cloud engine (#696). Adds resolveEngine()'s key check to
// the pure rule above: an enabled-but-unconfigured cloud engine reroutes to a
// local engine that reads brackets aloud, so report no model and no hint.
// djSystem() gates its hint on this.
export function resolveCloudModelForPersona(persona: CloudPersona): string {
  const t: any = settings.get().tts || {};
  // Resolve 'inherit' before asking the pure rule, which keys off engine ===
  // 'cloud': a raw inherit slot would read as "pinned to another engine" and
  // cost a cloud station its expression-cue hints.
  const slot = resolvePersonaVoiceSlot(persona?.tts, t);
  const model = resolveCloudModel(slot, {
    defaultEngine: t.defaultEngine,
    provider: t.cloud?.provider,
    model: t.cloud?.model,
  });
  if (!model) return '';
  const explicit = slot?.engine === 'cloud';
  if (!isConfigured(explicit ? slot?.cloudProvider || null : null)) return '';
  return model;
}

// Provider twin of resolveCloudModelForPersona, used by prompt policy so the
// bracket-cue hint never reaches a local fallback that would read them aloud.
export function resolveCloudProviderForPersona(persona: CloudPersona): string {
  const t: any = settings.get().tts || {};
  const slot = resolvePersonaVoiceSlot(persona?.tts, t);
  const provider = resolveCloudProvider(slot, {
    defaultEngine: t.defaultEngine,
    provider: t.cloud?.provider,
  });
  if (!provider) return '';
  const explicit = slot?.engine === 'cloud';
  if (!isConfigured(explicit ? slot?.cloudProvider || null : null)) return '';
  return provider;
}

// Availability-independent twin, for speech already generated or queued: a
// script can carry tags from when its provider was healthy even if the key or
// Cloud switch changed before airtime, and sanitization must key off that
// original provenance rather than current readiness.
export function requestedCloudExpressionCueFamilyForPersona(persona: CloudPersona) {
  const t: any = settings.get().tts || {};
  const slot = resolvePersonaVoiceSlot(persona?.tts, t);
  return cloudExpressionCueFamily(
    resolveCloudProvider(slot, {
      defaultEngine: t.defaultEngine,
      provider: t.cloud?.provider,
    }),
    resolveCloudModel(slot, {
      defaultEngine: t.defaultEngine,
      provider: t.cloud?.provider,
      model: t.cloud?.model,
    }),
  );
}

// Speech-rate multiplier limits per provider; a value outside the range is
// rejected by the API, so clamp before calling.
const SPEED_RANGE: Record<string, [number, number]> = {
  elevenlabs: [0.7, 1.2],
  openai: [0.25, 4.0],
  'fish-audio': [0.5, 2.0],
};

function clampSpeed(speed: any, provider: string) {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0) return 1.0;
  const [lo, hi] = SPEED_RANGE[provider] || [0.25, 4.0];
  return Math.min(hi, Math.max(lo, n));
}

// Where the computed speech `speed` is applied: the request body's `speed` field
// or a local ffmpeg atempo stretch. At most one is ever non-null — unity gives
// neither, openai-compatible without `sendSpeed` stretches locally (#942), and
// everything else sends the field. Pinned in scripts/llm-pure.test.ts.
export function speedDirective(
  provider: string,
  sendSpeed: boolean,
  speed: number,
): { body: number | null; atempo: number | null } {
  if (speed === 1.0) return { body: null, atempo: null };
  if (provider === 'openai-compatible' && !sendSpeed) return { body: null, atempo: speed };
  return { body: speed, atempo: null };
}

// Language-name → ISO 639-1 for the ElevenLabs `language` param. Best-effort:
// an unknown name falls through to no code, and the script text still carries
// the language. OpenAI takes a free-text instruction instead and needs no map.
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

// Per-provider delivery hint from the persona's `soul` and language. OpenAI's
// gpt-4o*-tts honours a free-text `instructions` field (#579), with language
// layered on as a pronunciation directive (#558). ElevenLabs honours only an ISO
// `language` code, so the soul can't ride there, and openai-compatible servers
// vary too much to hint at all. No soul and no language → {}.
function deliveryHint(
  { language, soul }: { language?: string; soul?: string },
  provider: string,
  model: string,
): { instructions?: string; language?: string } {
  const lang = String(language || '').trim();
  // Brief, not the full soul: this rides every spoken line and only steers tone
  // and pacing, so a long soul's backstory just enlarges each request.
  const character = soulBrief(soul);
  if (provider === 'openai') {
    // tts-1 / tts-1-hd ignore or reject `instructions`, and a 400 drops the line
    // to an English local fallback — worse than no hint.
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

// Merge the operator's extra body fields into the outgoing /audio/speech POST
// (#1317). It must happen at the FETCH layer: the AI SDK's OpenAI speech model
// builds a closed body and its providerOptions hatch accepts only
// `instructions` + `speed`.
//
// Everything degrades to a pass-through rather than throwing — a param that
// doesn't make it costs an un-tuned render, an exception costs the whole segment.
// Extras merge LAST so an SDK default can be corrected; the fields SUB/WAVE owns
// are reserved in settings/compat-params.ts.
function compatBodyFetch(extras: Record<string, unknown>): FetchFunction | undefined {
  if (!Object.keys(extras).length) return undefined;
  return async (input, init) => {
    const body = init?.body;
    if (typeof body !== 'string') return fetch(input, init);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return fetch(input, init);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fetch(input, init);
    // Re-stringify rather than patching the text: undici recomputes
    // Content-Length for a string body on its own.
    return fetch(input, { ...init, body: JSON.stringify({ ...parsed, ...extras }) });
  };
}

function speechModel(c: any) {
  if (c.provider === 'elevenlabs') {
    const provider = createElevenLabs(c.apiKey ? { apiKey: c.apiKey } : {});
    return provider.speech(c.model);
  }
  if (c.provider === 'openai-compatible') {
    // Any self-hosted server exposing /v1/audio/speech. Most accept any
    // non-empty key, so fall back to a placeholder.
    const provider = createOpenAI({
      baseURL: c.baseUrl,
      apiKey: c.apiKey || 'unused',
      name: 'openai-compatible',
      // Undefined with no extras configured, so the request shape is unchanged.
      fetch: compatBodyFetch(compatParamsBody(c.compatParams)),
    });
    return provider.speech(c.model);
  }
  const provider = createOpenAI(c.apiKey ? { apiKey: c.apiKey } : {});
  return provider.speech(c.model);
}

// True when the cloud engine has a usable key (Settings or env). tts.js calls
// this before routing to `cloud`, so a misconfigured station falls to a local
// engine. `providerOverride` asks about a PERSONA's provider rather than the
// global one — a persona on ElevenLabs needs ELEVENLABS_API_KEY even when the
// global provider is OpenAI.
export function isConfigured(providerOverride: string | null = null) {
  const c = cloudCfg();
  // Operator's explicit "Off" switch: unavailable even with a key.
  if (c.enabled === false) return false;
  const provider = providerOverride || c.provider;
  if (!provider) return false;
  // openai-compatible has no managed-key convention: configured iff baseUrl +
  // model are set, and it always uses the global model.
  if (provider === 'openai-compatible') {
    return !!(c.baseUrl && c.model);
  }
  // A provider override auto-resolves its model, so only the global-provider
  // path depends on the stored one.
  const model = (providerOverride && providerOverride !== c.provider)
    ? CLOUD_DEFAULT_MODELS[providerOverride]
    : c.model;
  if (!model) return false;
  const envKey = provider === 'elevenlabs'
    ? process.env.ELEVENLABS_API_KEY
    : provider === 'fish-audio'
      ? process.env.FISH_API_KEY
      : process.env.OPENAI_API_KEY;
  // A key typed into Settings counts only for the global provider it was entered
  // against. Fish is env/secrets-only: the legacy shared cloud.apiKey slot may
  // hold an OpenAI/ElevenLabs key and must never cross providers.
  const settingsKey = provider !== 'fish-audio' && (!providerOverride || providerOverride === c.provider)
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
  { outPath, cloudOverride = null, speedScale, language, soul, signal }: { outPath?: string; cloudOverride?: any; speedScale?: number; language?: string; soul?: string; signal?: AbortSignal } = {},
) {
  if (!text || !text.trim()) throw new Error('Empty TTS text');
  const base = cloudCfg();
  const c: any = { ...base, ...(cloudOverride || {}) };
  c.apiKey = sharedCloudApiKeyForRequest(
    c.provider,
    base.provider,
    base.apiKey,
    base.compatApiKey,
  );
  // A model id is provider-specific. Persona provider overrides use the new
  // provider's default; previews may explicitly override that model so the
  // operator auditions the exact unsaved tier/custom id.
  c.model = modelForCloudRequest(base.provider, base.model, cloudOverride);
  // openai-compatible servers always need the global baseUrl from settings —
  // persona-level overrides only carry provider+voice.
  if (c.provider === 'openai-compatible') {
    c.baseUrl = base.baseUrl;
  }

  // Speech rate — the per-call speedScale (daypart energy) composes on top of
  // CLOUD_TTS_SPEED / TTS_SPEED, then clamped to the provider's range. Only
  // sent when it differs from default so default stations are unaffected and
  // providers that ignore the field never see it.
  //
  // openai-compatible servers default to NOT receiving `speed` — implementations
  // are wildly uneven (#942: a Chatterbox shim behind LiteLLM produced
  // comb-filtered "echo chamber" audio with broken mp3 frame timestamps whenever
  // `speed` was present, and daypart energy makes it non-unity most of the day).
  // The server renders at 1x and the rate is applied locally via ffmpeg atempo
  // below, so every knob still works without the fragile server-side path.
  //
  // Escape hatch: tts.cloud.sendSpeed puts a compat server back on the native
  // `speed` field and skips the local stretch — for a server that honours it
  // cleanly (e.g. the hosted DJ Brain voice), where native speed beats
  // time-stretch artifacts. openai / elevenlabs always take the field.
  // speedDirective() owns the routing (unit-pinned in scripts/llm-pure.test.ts).
  const isCompat = c.provider === 'openai-compatible';
  const speed = clampSpeed(config.tts.cloudSpeed * (speedScale != null ? speedScale : 1), c.provider);
  const rate = speedDirective(c.provider, !!c.sendSpeed, speed);
  const stretchLocally = rate.atempo != null;

  // ElevenLabs voice_settings — expressive knobs the operator tunes in the
  // Cloud TTS section of admin → Settings (issue #696). Only spread when the
  // provider is actually elevenlabs so the openai / openai-compatible request
  // shape stays byte-identical. The AI SDK's ElevenLabs provider exposes them
  // as camelCase `voiceSettings.*` on `providerOptions.elevenlabs`.
  //
  // Omit the block entirely while the knobs sit at their shipped defaults
  // (issue #915 review): sending explicit values overrides whatever per-voice
  // settings the operator saved in ElevenLabs VoiceLab, so an untouched station
  // must defer to the voice's own settings the way it did before #696. Once any
  // knob is tuned we send the full set (the API takes voice_settings
  // all-or-nothing) — with `stability` snapped to eleven_v3's discrete
  // {0,0.5,1} so a tuned slider can't 400 the call into a Piper fallback.
  const elevenlabsOpts = c.provider === 'elevenlabs' && !settings.cloudVoiceSettingsAreDefault(c)
    ? {
      elevenlabs: {
        voiceSettings: {
          stability: isElevenLabsV3(c.model) ? snapV3Stability(c.voiceStability) : c.voiceStability,
          style: c.voiceStyle,
          similarityBoost: c.voiceSimilarityBoost,
          useSpeakerBoost: c.voiceUseSpeakerBoost,
        },
      },
    }
    : null;

  // Fish has its own managed REST contract rather than an AI SDK speech model:
  // model is a required header, voice is `reference_id`, and MP3 bytes stream
  // directly in the response. Keep it inside the existing cloud engine so all
  // dispatcher fallback, preview, stats, gain, and queue behavior is reused.
  if (c.provider === 'fish-audio') {
    return synthesizeFish({
      apiKey: process.env.FISH_API_KEY || '',
      model: c.model || FISH_DEFAULT_MODEL,
      text,
      referenceId: c.voice,
      temperature: c.temperature,
      topP: c.topP,
      latency: c.latency,
      speed,
      outPath,
    }, { signal });
  }

  const result = await generateSpeech({
    model: speechModel(c),
    text,
    voice: c.voice || undefined,
    ...(rate.body != null ? { speed: rate.body } : {}),
    // Persona character (soul) + language → provider-native delivery hint
    // (issues #579 / #558).
    ...deliveryHint({ language, soul }, c.provider, c.model),
    // ElevenLabs gates 44.1 kHz PCM/WAV behind paid tiers — a free/lower-tier
    // key 403s ("Forbidden") on pcm_44100. mp3 is allowed on every tier and
    // OpenAI honours it too, so it's the safe cross-provider request.
    // openai-compatible: omit the param entirely and let the server choose —
    // `result.audio.format` below drives the file extension regardless.
    ...(isCompat ? {} : { outputFormat: c.provider === 'elevenlabs' ? 'mp3' : 'wav' }),
    ...(elevenlabsOpts ? { providerOptions: elevenlabsOpts } : {}),
    abortSignal: signal,
  });

  const audio = Buffer.from(result.audio.uint8Array);

  // Local speed for openai-compatible: transcode to WAV with an atempo chain
  // (pitch-preserving, and WAV output means applyEdgeFades works on the result
  // too). Best-effort — if ffmpeg is missing or chokes, air the 1x render
  // rather than throwing into the Piper fallback (a rate miss is inaudible
  // next to a voice change). The fallback writes the server's original bytes
  // under the .wav name; Liquidsoap decodes by content, not extension.
  if (stretchLocally) {
    const wavPath = outPath
      || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      if (!(await hasFfmpeg())) throw new Error('ffmpeg unavailable');
      await transcodeAudio(audio, { outPath: wavPath, format: 'wav', atempo: speed });
      return wavPath;
    } catch (err: any) {
      console.warn(`[cloud-tts] local speed ${speed}x skipped (${err?.message || err}); airing 1x render`);
      await mkdir(path.dirname(wavPath), { recursive: true });
      await writeFile(wavPath, audio);
      return wavPath;
    }
  }

  const fmt = result.audio.format || 'mp3';
  const finalPath = outPath
    || path.join(config.piper.outDir, `${crypto.randomBytes(6).toString('hex')}.${fmt}`);
  await mkdir(path.dirname(finalPath), { recursive: true });
  await writeFile(finalPath, audio);
  return finalPath;
}
