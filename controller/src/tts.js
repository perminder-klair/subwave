// TTS dispatcher — picks an engine per voice-kind, with a settings-driven
// override and an automatic fallback if the chosen engine fails.
//
// All callers (queue.js, jingles.js, scheduler.js) now go through here
// instead of importing piper.js or kokoro.js directly.

import * as piper from './piper.js';
import * as kokoro from './kokoro.js';
import * as settings from './settings.js';

export const ENGINES = ['piper', 'kokoro'];

// Voice kinds the system speaks. `kind` is passed by the caller and used to
// look up an engine override in settings. Unknown kinds fall back to default.
export const VOICE_KINDS = [
  'dj-speak',       // listener-request intros + ad-hoc dialogue
  'link',           // between-track auto links (light-duck channel)
  'station-id',     // :15/:45 idents
  'hourly-check',   // top-of-hour time/weather mention
  'weather',        // weather change announcements
  'jingle',         // pre-rendered station idents (offline path)
  'default',        // fallback when a kind isn't explicitly mapped
];

function resolveEngine(kind) {
  const tts = settings.get().tts || {};
  const override = (tts.byKind && tts.byKind[kind]) || null;
  const chosen = override || tts.defaultEngine || 'piper';
  if (!ENGINES.includes(chosen)) return 'piper';
  return chosen;
}

async function speakWith(engine, text, opts) {
  if (engine === 'kokoro') {
    const voice = settings.get().tts?.kokoro?.voice;
    return kokoro.speak(text, { ...opts, voice });
  }
  return piper.speak(text, opts);
}

// Public entry point. Tries the configured engine; on failure, falls back to
// the other engine so the DJ never goes silent because a model crashed.
export async function speak(text, { kind = 'default', outPath } = {}) {
  const primary = resolveEngine(kind);
  try {
    return await speakWith(primary, text, { outPath });
  } catch (err) {
    const fallback = primary === 'kokoro' ? 'piper' : 'kokoro';
    if (fallback === 'kokoro' && !kokoro.isAvailable()) throw err;
    console.error(`[tts] ${primary} failed for kind=${kind}: ${err.message} — falling back to ${fallback}`);
    return speakWith(fallback, text, { outPath });
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
  };
}
