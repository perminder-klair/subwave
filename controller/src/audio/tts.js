// TTS dispatcher — picks an engine per voice-kind, with a settings-driven
// override and an automatic fallback if the chosen engine fails.
//
// All callers (queue.js, jingles.js, scheduler.js) now go through here
// instead of importing piper.js or kokoro.js directly.

import * as piper from './piper.js';
import * as kokoro from './kokoro.js';
import * as cloud from '../llm/speech.js';
import * as settings from '../settings.js';
import { recordTts } from '../stats.js';

export const ENGINES = ['piper', 'kokoro', 'cloud'];

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
  'random-facts',   // "did you know" filler (segment capability)
  'jingle',         // pre-rendered station idents (offline path)
  'default',        // fallback when a kind isn't explicitly mapped
];

// Every spoken segment — track intros, links, idents, weather, news, traffic,
// facts — is voiced by the persona on air: engine and voice come from the
// effective persona's `tts` config. Only jingle rendering (a pre-recorded,
// persona-agnostic stinger) falls back to the global defaultEngine.
const GLOBAL_VOICE_KINDS = new Set(['jingle', 'default']);

// The effective persona's TTS config for a persona-voiced kind, else null.
function djPersonaTts(kind) {
  if (GLOBAL_VOICE_KINDS.has(kind)) return null;
  return settings.getEffectivePersona()?.tts || null;
}

function resolveEngine(kind, personaTts) {
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
  return chosen;
}

async function speakWith(engine, text, opts, personaTts) {
  if (engine === 'kokoro') {
    const voice = (personaTts && personaTts.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : settings.get().tts?.kokoro?.voice;
    return kokoro.speak(text, { ...opts, voice });
  }
  if (engine === 'cloud') {
    // Persona picks provider + voice; the shared tts.cloud holds key + model.
    const cloudOverride = (personaTts && personaTts.engine === 'cloud')
      ? { provider: personaTts.cloudProvider, voice: personaTts.voice }
      : null;
    return cloud.speak(text, { ...opts, cloudOverride });
  }
  return piper.speak(text, opts);
}

// TTS engines read "SUB/WAVE" as "sub slash wave". Spell the station name
// phonetically before synthesis — visual branding keeps the slash, audio doesn't.
function normalizeForSpeech(text) {
  if (!text) return text;
  return text.replace(/\bSUB\s*(?:\/|slash)\s*WAVE\b/gi, 'Subwave');
}

// Public entry point. Tries the configured engine; on failure, falls back to
// a local engine so the DJ never goes silent because a model (or the network)
// failed. Piper is the universal fallback — local, keyless, fast.
//
// Every call is timed and recorded into the TTS ring buffer (stats.js) so the
// admin Stats page can show per-engine usage, latency, and the fallback rate.
export async function speak(text, { kind = 'default', outPath } = {}) {
  const speakText = normalizeForSpeech(text);
  const personaTts = djPersonaTts(kind);
  const primary = resolveEngine(kind, personaTts);
  const started = Date.now();
  const chars = (speakText || '').length;
  try {
    const result = await speakWith(primary, speakText, { outPath }, personaTts);
    recordTts({
      kind, engine: primary, requested: primary, fellBack: false,
      ok: true, ms: Date.now() - started, chars, t: new Date().toISOString(),
    });
    return result;
  } catch (err) {
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
      const result = await speakWith(fallback, speakText, { outPath }, personaTts);
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
    cloud: cloud.isConfigured(),
    // Per-provider — a persona's cloud voice is only usable if *its* provider
    // is configured, which can differ from the global Cloud-engine provider.
    cloudByProvider: {
      openai: cloud.isConfigured('openai'),
      elevenlabs: cloud.isConfigured('elevenlabs'),
    },
  };
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
    provider = personaTts?.engine === 'cloud' ? personaTts.cloudProvider : tts.cloud?.provider;
  } else if (engine === 'kokoro') {
    voice = (personaTts?.engine === 'kokoro' && personaTts.voice)
      ? personaTts.voice
      : tts.kokoro?.voice;
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
    },
    jingle: { engine: resolveEngine('jingle', null) },
  };
}
