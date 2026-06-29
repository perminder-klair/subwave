// TTS dispatcher — picks an engine per voice-kind, with a settings-driven
// override and an automatic fallback if the chosen engine fails.
//
// All callers (queue.js, jingles.js, scheduler.js) now go through here
// instead of importing piper.js or kokoro.js directly.

import * as piper from './piper.js';
import * as kokoro from './kokoro.js';
import * as chatterbox from './chatterbox.js';
import * as pocketTts from './pocketTts.js';
import * as remoteTts from './remoteTts.js';
import * as cloud from '../llm/speech.js';
import * as settings from '../settings.js';
import { recordTts } from '../stats.js';
import { energyForDaypart } from '../context.js';

export const ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'];

// Voice kinds the system speaks. `kind` is passed by the caller and used to
// look up an engine override in settings. Unknown kinds fall back to default.
export const VOICE_KINDS = [
  'dj-speak',       // listener-request intros + ad-hoc dialogue
  'link',           // between-track auto links (light-duck channel)
  'station-id',     // :15/:45 idents
  'hourly-check',   // top-of-hour time/weather mention
  'weather',        // weather change announcements (segment capability)
  'news',           // headline read (segment capability)
  'traffic',        // tongue-in-cheek traffic filler (segment capability)
  'curiosity',      // on-this-day / oddly-specific factoid (segment capability)
  'album-anniversary', // round-number anniversary of the on-air album (segment capability)
  'library-deep-cut',  // tease a forgotten track by the on-air artist (segment capability)
  'jingle',         // pre-rendered station idents (offline path)
  'default',        // fallback when a kind isn't explicitly mapped
];

// Every spoken segment — track intros, links, idents, weather, news, traffic,
// facts — is voiced by the persona on air: engine and voice come from the
// effective persona's `tts` config. Only jingle rendering (a pre-recorded,
// persona-agnostic stinger) falls back to the global defaultEngine.
const GLOBAL_VOICE_KINDS = new Set(['jingle', 'default']);

// The effective persona's TTS config for a persona-voiced kind, else null.
function djPersonaTts(kind: string): any {
  if (GLOBAL_VOICE_KINDS.has(kind)) return null;
  return settings.getEffectivePersona()?.tts || null;
}

function resolveEngine(kind: string, personaTts: any) {
  const tts = settings.get().tts || {};
  let chosen;
  if (personaTts && ENGINES.includes(personaTts.engine)) {
    chosen = personaTts.engine;          // persona owns the spoken engine
  } else {
    chosen = tts.defaultEngine || 'piper';   // jingle / fallback
  }
  if (!ENGINES.includes(chosen)) return 'piper';
  // `cloud` without a configured key would just throw and fall back — skip
  // the wasted API attempt and resolve straight to a local engine. Check the
  // persona's own provider: a persona on ElevenLabs needs that provider's key,
  // not the global Cloud-engine provider's.
  if (chosen === 'cloud') {
    const provider = (personaTts && personaTts.engine === 'cloud')
      ? personaTts.cloudProvider
      : null;
    if (!cloud.isConfigured(provider)) {
      return tts.defaultEngine && tts.defaultEngine !== 'cloud' ? tts.defaultEngine : 'piper';
    }
  }
  // Chatterbox is opt-in — if the controller image wasn't built with
  // --build-arg WITH_CHATTERBOX=1, the venv isn't there. Skip straight to a
  // local engine instead of trying to spawn a Python that doesn't exist.
  if (chosen === 'chatterbox' && !chatterbox.isAvailable()) {
    return tts.defaultEngine && tts.defaultEngine !== 'chatterbox' ? tts.defaultEngine : 'piper';
  }
  // Same story for PocketTTS — opt-in via --build-arg WITH_POCKETTTS=1.
  // When the venv is absent, route to the saved default (or Piper as the
  // universal local fallback).
  if (chosen === 'pocket-tts' && !pocketTts.isAvailable()) {
    return tts.defaultEngine && tts.defaultEngine !== 'pocket-tts' ? tts.defaultEngine : 'piper';
  }
  // Kokoro ships in the default image, but its model/voices files are pulled at
  // build time and can be missing if that download failed. isAvailable() now
  // existsSyncs them, so route around a broken Kokoro install instead of
  // spawning a worker that just dies on load and falls back per segment.
  if (chosen === 'kokoro' && !kokoro.isAvailable()) {
    return tts.defaultEngine && tts.defaultEngine !== 'kokoro' ? tts.defaultEngine : 'piper';
  }
  // The remote engine needs a configured URL and a reachable sidecar — unlike
  // the local engines, which gate on installed venvs/models. When the URL is
  // blank or the /health probe hasn't succeeded yet, fall back to the default.
  if (chosen === 'remote' && !remoteTts.isAvailable()) {
    return tts.defaultEngine && tts.defaultEngine !== 'remote' ? tts.defaultEngine : 'piper';
  }
  return chosen;
}

// Effective voice level trim (dB) for a spoken segment of `kind`: the resolved
// engine's per-engine gain (settings.tts.gainDb) plus the on-air persona's own
// trim (persona.tts.gainDb), clamped to ±TTS_GAIN_CLAMP_DB. Applied downstream
// by broadcast/queue.ts as a Liquidsoap `liq_amplify` annotation on the handoff
// file — the same mechanism music loudness uses. 0 = unity (no annotation
// written), i.e. today's behaviour. Uses the *resolved* engine (post
// availability/key fallback), so the gain matches the engine that will actually
// speak; the rare runtime-throw fallback inside speak() is an error path.
export function voiceGainDb(kind: string): number {
  const personaTts = djPersonaTts(kind);
  const engine = resolveEngine(kind, personaTts);
  const tts: any = settings.get().tts || {};
  const engineGain = settings.clampTtsGain(tts.gainDb?.[engine]);
  const personaGain = personaTts ? settings.clampTtsGain(personaTts.gainDb) : 0;
  return settings.clampTtsGain(engineGain + personaGain);
}

async function speakWith(engine: string, text: string, opts: any, personaTts: any) {
  if (engine === 'kokoro') {
    const voice = (personaTts && personaTts.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.kokoro?.voice;
    return kokoro.speak(text, { ...opts, voice });
  }
  if (engine === 'chatterbox') {
    // For chatterbox, persona's `voice` is a reference-WAV filename (resolved
    // by chatterbox.ts against config.chatterbox.voiceDir). Empty/missing →
    // built-in default voice.
    const voice = (personaTts && personaTts.engine === 'chatterbox' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.chatterbox?.referenceVoice;
    return chatterbox.speak(text, { ...opts, voice });
  }
  if (engine === 'pocket-tts') {
    // PocketTTS voice is a built-in id (alba, anna, …). Persona override wins;
    // otherwise the global pocketTts voice. The worker falls back to the
    // configured default if the id isn't recognised, so a stale persona
    // value never causes a silent segment.
    const voice = (personaTts && personaTts.engine === 'pocket-tts' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.pocketTts?.voice;
    return pocketTts.speak(text, { ...opts, voice });
  }
  if (engine === 'cloud') {
    // Persona picks provider + voice; the shared tts.cloud holds key + model.
    const cloudOverride = (personaTts && personaTts.engine === 'cloud')
      ? { provider: personaTts.cloudProvider, voice: personaTts.voice }
      : null;
    return cloud.speak(text, { ...opts, cloudOverride });
  }
  if (engine === 'remote') {
    // Remote engine — persona's `voice` is forwarded as-is to the endpoint,
    // which interprets it (built-in id, reference-wav filename, or VoiceDesign
    // prompt). No global fallback voice — the endpoint owns its defaults.
    const voice = (personaTts && personaTts.engine === 'remote' && personaTts.voice)
      ? personaTts.voice
      : undefined;
    return remoteTts.speak(text, { ...opts, voice });
  }
  // For piper, persona's `voice` is an .onnx filename (resolved by piper.ts
  // against config.voices.dir). Empty/missing → the baked-in default voice.
  const voice = (personaTts && personaTts.engine === 'piper' && personaTts.voice)
    ? personaTts.voice
    : undefined;
  return piper.speak(text, { ...opts, voice });
}

// TTS engines read "SUB/WAVE" as "sub slash wave". Spell the station name
// phonetically before synthesis — visual branding keeps the slash, audio doesn't.
function normalizeForSpeech(text: string) {
  if (!text) return text;
  return text.replace(/\bSUB\s*(?:\/|slash)\s*WAVE\b/gi, 'Subwave');
}

// Admin voice-preview ("Play sample"). Renders a one-off sample WAV with an
// EXPLICIT engine + voice, deliberately bypassing both the on-air persona
// resolution and the silent fallback chain in speak() — the operator wants to
// hear exactly the engine they picked, or get a real error if it's unavailable
// (sidecar down, no cloud key). A synthetic persona-shaped object routes the
// voice/provider through speakWith() the same way a live persona would. `speed`
// is the final rate multiplier to audition, clamped to the playout [0.5,2.0]
// band; gain (dB) is a playout-time mix trim and is intentionally NOT baked in.
// Returns the path to the generated WAV — the caller serves and unlinks it.
const PREVIEW_TEXT_MAX = 200;
const DEFAULT_PREVIEW_TEXT = "You're listening to SUB/WAVE. This is a voice preview.";

export async function synthesizeSample(
  { engine, voice = '', cloudProvider = 'openai', speed, text }: {
    engine: string;
    voice?: string;
    cloudProvider?: string;
    speed?: number;
    text?: string;
  },
): Promise<string> {
  if (!ENGINES.includes(engine)) throw new Error(`Unknown engine: ${engine}`);
  const raw = (typeof text === 'string' && text.trim()) ? text.trim() : DEFAULT_PREVIEW_TEXT;
  const sample = normalizeForSpeech(raw.slice(0, PREVIEW_TEXT_MAX));
  const scale = settings.clampTtsSpeed(speed);
  // Synthetic persona so speakWith() picks up the requested voice/provider
  // exactly (its per-engine branches key off personaTts.engine === <engine>).
  const personaTts = { engine, voice, cloudProvider };
  // No outPath → each engine self-generates a WAV path under config.piper.outDir
  // (reaped by cleanupOldVoices) and returns it.
  return speakWith(engine, sample, { speedScale: scale, language: '', soul: '' }, personaTts);
}

// Public entry point. Tries the configured engine; on failure, falls back to
// a local engine so the DJ never goes silent because a model (or the network)
// failed. Piper is the universal fallback — local, keyless, fast.
//
// Every call is timed and recorded into the TTS ring buffer (stats.js) so the
// admin Stats page can show per-engine usage, latency, and the fallback rate.
export async function speak(
  text: string,
  { kind = 'default', outPath, speedScale }: { kind?: string; outPath?: string; speedScale?: number } = {},
) {
  const speakText = normalizeForSpeech(text);
  const personaTts = djPersonaTts(kind);
  const primary = resolveEngine(kind, personaTts);
  // Persona on-air language (e.g. "French") rides along to the cloud engine as a
  // pronunciation hint so a non-English script isn't read with English phonetics
  // (issue #558). DJ-voiced kinds only — never jingles — and '' (ignored) for
  // the default English persona. Local engines ignore the field; only
  // cloud-speech.ts reads it (the voice model carries the language for piper /
  // kokoro / pocket-tts).
  const language = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(settings.getEffectivePersona()?.language || '').trim();
  // The persona's soul (e.g. "thoughtful and a little wistful") rides the same
  // path so the voice delivery carries the same character as the writing (issue
  // #579). DJ-voiced kinds only, like `language`; only the OpenAI gpt-4o*-tts
  // path in cloud-speech.ts reads it (its free-text `instructions` field), every
  // other engine ignores it.
  const soul = GLOBAL_VOICE_KINDS.has(kind)
    ? ''
    : String(settings.getEffectivePersona()?.soul || '').trim();
  // Delivery pace — a MULTIPLIER on the engine's configured speech rate (1.0 =
  // unchanged), composed (not overridden) on top of an operator's global env
  // base PIPER_SPEED/KOKORO_SPEED/CLOUD_TTS_SPEED. Three factors multiply:
  //   engine base (settings.tts.speed[engine]) × persona (persona.tts.speed)
  //   × daypart energy (energyForDaypart().speed)
  // The engine base applies UNIVERSALLY — including jingles/default — mirroring
  // how the env base already does; persona × daypart apply only to live,
  // persona-voiced kinds (jingles are pre-rendered offline, so a jingle cut at
  // 2am must not carry 2am pacing into a noon playout). An explicit `speedScale`
  // (e.g. a future talk-up-to-post budget) replaces the persona/daypart live
  // term but still composes with the engine base. Resolved-engine speed (post
  // availability/key fallback) is used so the rate matches the engine that
  // speaks — same approach as voiceGainDb(); the rare runtime-throw fallback
  // reuses this scale. All factors default to 1.0, so a stock station is
  // byte-for-byte unchanged. Final product clamped to [0.5, 2.0].
  const ttsCfg: any = settings.get().tts || {};
  const engineSpeed = settings.clampTtsSpeed(ttsCfg.speed?.[primary]);
  const live = speedScale != null
    ? speedScale
    : GLOBAL_VOICE_KINDS.has(kind)
      ? 1
      : (personaTts ? settings.clampTtsSpeed(personaTts.speed) : 1) * energyForDaypart().speed;
  // Bounds-clamp the product but do NOT snap to the 0.05 grid — the daypart
  // energy is a non-grid value, so at default knobs (all 1.0) the on-air scale
  // stays exactly today's daypart figure. Snapping happens only on the stored
  // per-engine / per-persona knobs (clampTtsSpeed above).
  const scale = Math.min(settings.TTS_SPEED_MAX, Math.max(settings.TTS_SPEED_MIN, engineSpeed * live));
  const started = Date.now();
  const chars = (speakText || '').length;
  try {
    const result = await speakWith(primary, speakText, { outPath, speedScale: scale, language, soul }, personaTts);
    recordTts({
      kind, engine: primary, requested: primary, fellBack: false,
      ok: true, ms: Date.now() - started, chars, t: new Date().toISOString(),
    });
    return result;
  } catch (err) {
    // Piper is the universal local fallback — no model load, no API key.
    // From any non-piper engine we always fall back to piper; if piper itself
    // is the primary, try kokoro (only if its worker is installed).
    const fallback = primary === 'piper' ? 'kokoro' : 'piper';
    if (fallback === 'kokoro' && !kokoro.isAvailable()) {
      recordTts({
        kind, engine: primary, requested: primary, fellBack: false,
        ok: false, ms: Date.now() - started, chars, error: err.message,
        t: new Date().toISOString(),
      });
      throw err;
    }
    console.error(`[tts] ${primary} failed for kind=${kind}: ${err.message} — falling back to ${fallback}`);
    try {
      const result = await speakWith(fallback, speakText, { outPath, speedScale: scale, language, soul }, personaTts);
      recordTts({
        kind, engine: fallback, requested: primary, fellBack: true,
        ok: true, ms: Date.now() - started, chars, t: new Date().toISOString(),
      });
      return result;
    } catch (err2) {
      recordTts({
        kind, engine: fallback, requested: primary, fellBack: true,
        ok: false, ms: Date.now() - started, chars, error: err2.message,
        t: new Date().toISOString(),
      });
      throw err2;
    }
  }
}

// Re-exported so callers don't have to know which engine wrote the file.
// Piper is the original owner of the voice output dir; cleanup is engine-agnostic
// because every engine writes WAVs into the same directory.
export { cleanupOldVoices } from './piper.js';

export function availableEngines() {
  return {
    piper: true,
    kokoro: kokoro.isAvailable(),
    chatterbox: chatterbox.isAvailable(),
    'pocket-tts': pocketTts.isAvailable(),
    // Whether PocketTTS can clone voices (gated weights present). null = not
    // yet known. The admin UI uses this to warn that a cloned .wav voice will
    // silently revert to a built-in when cloning is unavailable (issue #238).
    pocketTtsCloning: pocketTts.cloningAvailable(),
    cloud: cloud.isConfigured(),
    remote: remoteTts.isAvailable(),
    // Per-provider — a persona's cloud voice is only usable if *its* provider
    // is configured, which can differ from the global Cloud-engine provider.
    cloudByProvider: {
      openai: cloud.isConfigured('openai'),
      elevenlabs: cloud.isConfigured('elevenlabs'),
    },
  };
}

// True when a PocketTTS `voice` value is a cloned reference (a .wav filename)
// rather than a built-in voice id. Mirrors resolveVoice()'s split in
// audio/pocketTts.ts — anything ending in .wav (or an absolute path) is a clone.
function isPocketClone(voice?: string | null): boolean {
  const v = (voice || '').trim();
  return !!v && (/\.wav$/i.test(v) || v.startsWith('/'));
}

// Snapshot of how a spoken segment would currently route: which engine the
// effective persona's voice resolves to, and whether that's a fallback from
// the engine the persona actually asked for. Surfaced in /debug so the
// operator can see *who speaks* without waiting for a segment to air.
export function describeRouting() {
  const persona = settings.getEffectivePersona();
  const personaTts = persona?.tts || null;
  const tts = settings.get().tts || {};
  const requested = personaTts?.engine || tts.defaultEngine || 'piper';
  const engine = resolveEngine('dj-speak', personaTts);   // any persona-voiced kind
  let voice = null;
  let provider = null;
  if (engine === 'cloud') {
    voice = personaTts?.engine === 'cloud' ? personaTts.voice : tts.cloud?.voice;
    provider = (personaTts?.engine === 'cloud' ? personaTts.cloudProvider : tts.cloud?.provider) as any;
  } else if (engine === 'kokoro') {
    voice = (personaTts?.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : tts.kokoro?.voice;
  } else if (engine === 'chatterbox') {
    // For chatterbox, `voice` is the reference-WAV filename; empty → built-in.
    voice = (personaTts?.engine === 'chatterbox' && personaTts.voice)
      ? personaTts.voice
      : (tts.chatterbox?.referenceVoice || null);
  } else if (engine === 'pocket-tts') {
    voice = (personaTts?.engine === 'pocket-tts' && personaTts.voice)
      ? personaTts.voice
      : (tts.pocketTts?.voice || null);
  } else if (engine === 'piper') {
    // For piper, `voice` is the .onnx filename; empty → baked-in default.
    voice = (personaTts?.engine === 'piper' && personaTts.voice)
      ? personaTts.voice
      : null;
  } else if (engine === 'remote') {
    voice = (personaTts?.engine === 'remote' && personaTts.voice)
      ? personaTts.voice
      : null;
  }
  // If the on-air persona asks PocketTTS for a cloned voice but the engine
  // can't clone (gated weights absent), the .wav silently reverts to a built-in
  // — the root cause of issue #238. Surface it so /debug shows *why* the voice
  // isn't what the operator picked, instead of a healthy-looking no-op.
  let warning: string | null = null;
  if (engine === 'pocket-tts' && isPocketClone(voice) && pocketTts.cloningAvailable() === false) {
    warning = 'PocketTTS voice cloning is unavailable in this build (gated weights '
      + 'not loaded) — this cloned voice reverts to a built-in. Set HF_TOKEN to enable cloning.';
  }
  return {
    effectivePersona: persona ? { id: persona.id, name: persona.name } : null,
    available: availableEngines(),
    spoken: {
      requested,
      engine,
      voice: voice || null,
      provider: provider || null,
      fellBack: requested !== engine,
      warning,
    },
    jingle: { engine: resolveEngine('jingle', null) },
  };
}
