// TTS dispatcher — picks an engine per voice-kind, with a settings-driven
// override and an automatic fallback if the chosen engine fails.
//
// All callers (queue.js, jingles.js, scheduler.js) now go through here
// instead of importing piper.js or kokoro.js directly.

import * as piper from './piper.js';
import * as kokoro from './kokoro.js';
import * as cloud from '../llm/speech.js';
import * as settings from '../settings.js';

export const ENGINES = ['piper', 'kokoro', 'cloud'];

// Voice kinds the system speaks. `kind` is passed by the caller and used to
// look up an engine override in settings. Unknown kinds fall back to default.
export const VOICE_KINDS = [
  'dj-speak',       // listener-request intros + ad-hoc dialogue
  'link',           // between-track auto links (light-duck channel)
  'station-id',     // :15/:45 idents
  'hourly-check',   // top-of-hour time/weather mention
  'weather',        // weather change announcements (skills/weather.js)
  'news',           // headline read (skills/news.js)
  'traffic',        // tongue-in-cheek traffic filler (skills/traffic.js)
  'random-facts',   // "did you know" filler (skills/random-facts.js)
  'jingle',         // pre-rendered station idents (offline path)
  'default',        // fallback when a kind isn't explicitly mapped
];

// DJ-spoken kinds — these are voiced by the persona on air, so their engine
// and voice come from the effective persona's `tts` config rather than the
// global byKind/defaultEngine routing. Everything else (weather, news,
// jingles…) stays on the global routing.
const DJ_SPOKEN_KINDS = new Set(['dj-speak', 'link', 'station-id', 'hourly-check']);

// The effective persona's TTS config for a DJ-spoken kind, else null.
function djPersonaTts(kind) {
  if (!DJ_SPOKEN_KINDS.has(kind)) return null;
  return settings.getEffectivePersona()?.tts || null;
}

function resolveEngine(kind, personaTts) {
  const tts = settings.get().tts || {};
  let chosen;
  if (personaTts && ENGINES.includes(personaTts.engine)) {
    chosen = personaTts.engine;          // persona owns the DJ-spoken engine
  } else {
    const override = (tts.byKind && tts.byKind[kind]) || null;
    chosen = override || tts.defaultEngine || 'piper';
  }
  if (!ENGINES.includes(chosen)) return 'piper';
  // `cloud` without a configured key would just throw and fall back — skip
  // the wasted API attempt and resolve straight to a local engine.
  if (chosen === 'cloud' && !cloud.isConfigured()) {
    return tts.defaultEngine && tts.defaultEngine !== 'cloud' ? tts.defaultEngine : 'piper';
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

// Public entry point. Tries the configured engine; on failure, falls back to
// a local engine so the DJ never goes silent because a model (or the network)
// failed. Piper is the universal fallback — local, keyless, fast.
export async function speak(text, { kind = 'default', outPath } = {}) {
  const personaTts = djPersonaTts(kind);
  const primary = resolveEngine(kind, personaTts);
  try {
    return await speakWith(primary, text, { outPath }, personaTts);
  } catch (err) {
    const fallback = primary === 'piper' ? 'kokoro' : 'piper';
    if (fallback === 'kokoro' && !kokoro.isAvailable()) throw err;
    console.error(`[tts] ${primary} failed for kind=${kind}: ${err.message} — falling back to ${fallback}`);
    return speakWith(fallback, text, { outPath }, personaTts);
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
  };
}
