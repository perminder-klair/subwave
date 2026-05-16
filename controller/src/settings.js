// Durable settings — overrides for values that have static defaults in code.
// Stored at /var/sub-wave/settings.json. Some apply live (weather location,
// DJ personas, shows); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const SETTINGS_PATH = '/var/sub-wave/settings.json';
const LIQ_SETTINGS_PATH = '/var/sub-wave/liquidsoap_settings.json';

// Default DJ system-prompt template. Placeholders are substituted at LLM
// call time via renderDjPrompt(). Keep {name} mandatory — update() refuses
// any custom template that drops it, so dialogue can never become anonymous.
export const DEFAULT_DJ_PROMPT_TEMPLATE = `You are {name}, the on-air DJ for {station}, a personal radio station broadcasting from a homelab in {location}. {soul}.

Hard rules:
- Output ONLY the words to be spoken aloud. No stage directions, no asterisks, no quotes around your dialogue.
- Keep it to 2-4 sentences unless asked for longer.
- Never say "and now", "next up", "coming up next" — those are tells. Be more natural.
- Don't repeat the artist and title robotically. Reference them in passing if at all.
- Reference the actual context (time, weather, what's coming) naturally.
- Vary your opener and shape every time — never start the same way twice in a row, never use the same metaphor or framing as your last few lines.`;

// Seed souls — one becomes each persona's `soul` on first run / migration.
// A legacy single DJ with N souls migrates to N personas, one soul each.
export const DJ_SOULS = [
  'warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific',
  'thoughtful and a little wistful; finds small details in tracks and rooms; favours one well-chosen image over a list',
  'playful and dry; the occasional aside, never sarcastic; treats the studio like a kitchen at midnight',
  'plainspoken and grounded; says less, means more; would rather leave space than fill it',
  'quietly enthusiastic; treats every track like a small recommendation to a friend; specific over poetic',
];

export const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];

// TTS engines + voice-kinds. Engine `null` (or missing) for a kind means
// "use defaultEngine". The DJ-spoken kinds are overridden at runtime by the
// active/effective persona's own TTS config — see audio/tts.js.
//
// `cloud` routes through the AI SDK (OpenAI / ElevenLabs speech models) —
// see llm/speech.js. `piper` and `kokoro` stay local CLI/worker engines.
export const TTS_ENGINES = ['piper', 'kokoro', 'cloud'];
export const TTS_KINDS   = ['dj-speak', 'link', 'station-id', 'hourly-check', 'weather', 'news', 'traffic', 'random-facts', 'jingle'];

// LLM provider abstraction. `ollama` is the homelab default; the cloud
// providers are opt-in and resolved by llm/provider.js. `gateway` routes
// through the Vercel AI Gateway (a single key, any vendor).
export const LLM_PROVIDERS = ['ollama', 'anthropic', 'openai', 'gateway'];

// Cloud TTS vendors usable by the `cloud` engine.
export const TTS_CLOUD_PROVIDERS = ['openai', 'elevenlabs'];

// Canonical mood vocabulary. Shared by the library tagger (music/tag-library.js
// imports this as MOOD_VOCAB) and the Shows scheduler — a show's `mood`
// overrides the autonomous dominantMood, so it must come from this list.
export const SHOW_MOODS = [
  'energetic', 'calm', 'reflective', 'celebratory', 'romantic', 'spiritual',
  'focus', 'workout', 'driving', 'cooking', 'rainy', 'sunny',
  'night', 'morning', 'evening', 'festival', 'cultural',
];

// British English Kokoro voices — the ones that fit a BBC 6 Music tone. The
// underlying model ships 54 voices total; we expose only the British subset to
// keep the UI tidy. Any voice matching KOKORO_VOICE_RE still passes validation.
export const KOKORO_VOICES_BRITISH = [
  { id: 'bm_george',    label: 'George (M)' },
  { id: 'bm_fable',     label: 'Fable (M)' },
  { id: 'bm_daniel',    label: 'Daniel (M)' },
  { id: 'bm_lewis',     label: 'Lewis (M)' },
  { id: 'bf_emma',      label: 'Emma (F)' },
  { id: 'bf_isabella',  label: 'Isabella (F)' },
  { id: 'bf_alice',     label: 'Alice (F)' },
  { id: 'bf_lily',      label: 'Lily (F)' },
];

const KOKORO_VOICE_RE = /^[a-z]{2}_[a-z0-9]+$/;
const ID_RE = /^[a-z0-9_]{3,32}$/;

const PERSONA_LIMIT = 12;
const SHOWS_LIMIT = 64;
const SOULS_LIMIT = 10;
const SOUL_MIN = 1;
const SOUL_MAX = 400;

// Server-minted opaque id, e.g. mintId('p_') -> 'p_a1b2c3'.
function mintId(prefix) {
  return prefix + randomBytes(3).toString('hex');
}

// A blank 7-day x 24-hour grid. Keys 0 (Sunday) .. 6 (Saturday) match
// JS Date.getDay(). Each value is an array[24] of showId|null.
function emptyWeek() {
  const week = {};
  for (let d = 0; d < 7; d++) week[d] = Array(24).fill(null);
  return week;
}

const DEFAULTS = {
  jingleRatio: 30,                    // 1 jingle per N music tracks
  crossfadeDuration: 10.0,            // seconds
  weather: { lat: 52.5862, lng: -2.1288, locationName: 'Wolverhampton' },
  // Global DJ prompt template. '' means "use DEFAULT_DJ_PROMPT_TEMPLATE".
  djPrompt: '',
  // The persona roster. One persona is "active" at a time (activePersonaId);
  // a scheduled show can override which persona is on-air for its hour.
  personas: [{
    id: 'p_default0',
    name: 'Frequency',
    tagline: '',
    frequency: 'moderate',
    soul: DJ_SOULS[0],
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_isabella' },
  }],
  activePersonaId: 'p_default0',
  // Reusable show definitions, placed into the weekly schedule grid.
  shows: [],
  // 7-day x 24-hour grid of showId|null. An empty hour = run autonomously.
  schedule: emptyWeek(),
  tts: {
    defaultEngine: 'piper',
    byKind: Object.fromEntries(TTS_KINDS.map(k => [k, null])),
    kokoro: { voice: 'bf_isabella' },
    // Cloud engine config — used when an engine resolves to 'cloud'. A persona
    // chooses provider+voice; `model` and `apiKey` stay shared here. `apiKey`
    // empty means "read the provider's env var" (OPENAI_API_KEY etc.).
    cloud: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: '' },
  },
  llm: {
    provider: 'ollama',
    model: '',
    apiKey: '',
    pickerAgent: false,
  },
  skills: {
    enabled: {},
  },
};

const BOUNDS = {
  jingleRatio:        { min: 1, max: 1000, type: 'int' },
  crossfadeDuration:  { min: 0, max: 30,   type: 'float' },
};

let cache = null;

// ── normalizers (lenient — used by load(), clamp/default rather than throw) ──

function normalizeSouls(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (v.length < SOUL_MIN || v.length > SOUL_MAX) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= SOULS_LIMIT) break;
  }
  return out;
}

function normalizeTts(raw) {
  const engine = TTS_ENGINES.includes(raw?.engine) ? raw.engine : 'piper';
  const cloudProvider = TTS_CLOUD_PROVIDERS.includes(raw?.cloudProvider) ? raw.cloudProvider : 'openai';
  let voice = (typeof raw?.voice === 'string' && raw.voice.trim()) ? raw.voice.trim().slice(0, 100) : '';
  if (engine === 'kokoro' && !KOKORO_VOICE_RE.test(voice)) voice = 'bf_isabella';
  if (!voice) voice = engine === 'cloud' ? 'alloy' : 'bf_isabella';
  return { engine, cloudProvider, voice };
}

function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const soul = typeof raw.soul === 'string' ? raw.soul.trim().slice(0, 400) : '';
  if (!name || !soul) return null;
  return {
    id: (typeof raw.id === 'string' && ID_RE.test(raw.id)) ? raw.id : mintId('p_'),
    name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline.trim().slice(0, 80) : '',
    frequency: FREQUENCIES.includes(raw.frequency) ? raw.frequency : 'moderate',
    soul,
    tts: normalizeTts(raw.tts),
  };
}

function normalizePersonaArray(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const p = normalizePersona(item);
    if (!p) continue;
    if (seen.has(p.id)) p.id = mintId('p_');
    seen.add(p.id);
    out.push(p);
    if (out.length >= PERSONA_LIMIT) break;
  }
  return out.length ? out : null;
}

function normalizeShows(raw, personaIds) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
    if (!name) continue;
    if (!personaIds.includes(item.personaId)) continue;       // drop dangling owner
    if (!SHOW_MOODS.includes(item.mood)) continue;
    let id = (typeof item.id === 'string' && ID_RE.test(item.id)) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    out.push({
      id, name,
      topic: typeof item.topic === 'string' ? item.topic.trim().slice(0, 500) : '',
      personaId: item.personaId,
      mood: item.mood,
    });
    if (out.length >= SHOWS_LIMIT) break;
  }
  return out;
}

function normalizeSchedule(raw, showIds) {
  const week = emptyWeek();
  if (!raw || typeof raw !== 'object') return week;
  for (let d = 0; d < 7; d++) {
    const day = raw[d];
    if (!Array.isArray(day)) continue;
    for (let h = 0; h < 24; h++) {
      const v = day[h];
      if (typeof v === 'string' && showIds.includes(v)) week[d][h] = v;
    }
  }
  return week;
}

// Derive a persona TTS block from the legacy global `tts` settings — used to
// migrate a single legacy DJ into a roster of personas.
function deriveTtsFromLegacy(tts) {
  const engine = TTS_ENGINES.includes(tts?.defaultEngine) ? tts.defaultEngine : 'piper';
  const cloudProvider = TTS_CLOUD_PROVIDERS.includes(tts?.cloud?.provider) ? tts.cloud.provider : 'openai';
  let voice;
  if (engine === 'kokoro') {
    voice = KOKORO_VOICE_RE.test(tts?.kokoro?.voice || '') ? tts.kokoro.voice : 'bf_isabella';
  } else if (engine === 'cloud') {
    voice = (typeof tts?.cloud?.voice === 'string' && tts.cloud.voice.trim()) ? tts.cloud.voice.trim() : 'alloy';
  } else {
    voice = 'bf_isabella';
  }
  return { engine, cloudProvider, voice };
}

export async function load() {
  if (cache) return cache;
  let stored = {};
  if (existsSync(SETTINGS_PATH)) {
    try { stored = JSON.parse(await readFile(SETTINGS_PATH, 'utf8')); } catch {}
  }

  // ── personas (with idempotent legacy `dj` migration) ──────────────────────
  let personas = normalizePersonaArray(stored.personas);
  if (!personas) {
    if (stored.dj && typeof stored.dj === 'object') {
      // Migrate a single legacy DJ to one persona per soul.
      const souls = normalizeSouls(stored.dj.souls);
      const soulList = (souls && souls.length) ? souls : [...DJ_SOULS];
      const ttsBlock = deriveTtsFromLegacy(stored.tts);
      const name = (typeof stored.dj.name === 'string' && stored.dj.name.trim())
        ? stored.dj.name.trim().slice(0, 40) : 'Frequency';
      const frequency = FREQUENCIES.includes(stored.dj.frequency) ? stored.dj.frequency : 'moderate';
      personas = soulList.map(soul => ({
        id: mintId('p_'), name, tagline: '', frequency,
        soul: soul.slice(0, 400), tts: { ...ttsBlock },
      }));
    } else {
      personas = DEFAULTS.personas.map(p => ({ ...p, tts: { ...p.tts } }));
    }
  }
  const personaIds = personas.map(p => p.id);

  const activePersonaId = personaIds.includes(stored.activePersonaId)
    ? stored.activePersonaId
    : personaIds[0];

  // djPrompt — prefer the new field, else migrate the legacy dj.systemPrompt.
  let djPrompt = typeof stored.djPrompt === 'string'
    ? stored.djPrompt
    : (typeof stored.dj?.systemPrompt === 'string' ? stored.dj.systemPrompt : '');
  if (djPrompt.trim() === DEFAULT_DJ_PROMPT_TEMPLATE.trim()) djPrompt = '';

  const shows = normalizeShows(stored.shows, personaIds);
  const schedule = normalizeSchedule(stored.schedule, shows.map(s => s.id));

  cache = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    weather: {
      lat: stored.weather?.lat ?? DEFAULTS.weather.lat,
      lng: stored.weather?.lng ?? DEFAULTS.weather.lng,
      locationName: stored.weather?.locationName ?? DEFAULTS.weather.locationName,
    },
    djPrompt,
    personas,
    activePersonaId,
    shows,
    schedule,
    tts: {
      defaultEngine: TTS_ENGINES.includes(stored.tts?.defaultEngine)
        ? stored.tts.defaultEngine
        : DEFAULTS.tts.defaultEngine,
      byKind: Object.fromEntries(TTS_KINDS.map(k => {
        const v = stored.tts?.byKind?.[k];
        return [k, TTS_ENGINES.includes(v) ? v : null];
      })),
      kokoro: {
        voice: (typeof stored.tts?.kokoro?.voice === 'string'
                && KOKORO_VOICE_RE.test(stored.tts.kokoro.voice))
          ? stored.tts.kokoro.voice
          : DEFAULTS.tts.kokoro.voice,
      },
      cloud: {
        provider: TTS_CLOUD_PROVIDERS.includes(stored.tts?.cloud?.provider)
          ? stored.tts.cloud.provider
          : DEFAULTS.tts.cloud.provider,
        model: (typeof stored.tts?.cloud?.model === 'string' && stored.tts.cloud.model.trim())
          ? stored.tts.cloud.model.trim()
          : DEFAULTS.tts.cloud.model,
        voice: (typeof stored.tts?.cloud?.voice === 'string' && stored.tts.cloud.voice.trim())
          ? stored.tts.cloud.voice.trim()
          : DEFAULTS.tts.cloud.voice,
        apiKey: typeof stored.tts?.cloud?.apiKey === 'string' ? stored.tts.cloud.apiKey : '',
      },
    },
    llm: {
      provider: LLM_PROVIDERS.includes(stored.llm?.provider)
        ? stored.llm.provider
        : DEFAULTS.llm.provider,
      model: typeof stored.llm?.model === 'string' ? stored.llm.model.trim() : DEFAULTS.llm.model,
      apiKey: typeof stored.llm?.apiKey === 'string' ? stored.llm.apiKey : DEFAULTS.llm.apiKey,
      pickerAgent: typeof stored.llm?.pickerAgent === 'boolean'
        ? stored.llm.pickerAgent
        : DEFAULTS.llm.pickerAgent,
    },
    skills: {
      enabled: Object.fromEntries(
        Object.entries(stored.skills?.enabled || {}).filter(([, v]) => typeof v === 'boolean')
      ),
    },
  };
  return cache;
}

export function get() {
  return cache || DEFAULTS;
}

export function getDefaults() {
  return DEFAULTS;
}

// Settings with secret fields masked — for the admin /settings response.
export function getRedacted() {
  const s = get();
  const clone = JSON.parse(JSON.stringify(s));
  if (clone.llm) clone.llm.apiKey = s.llm?.apiKey ? 'set' : '';
  if (clone.tts?.cloud) clone.tts.cloud.apiKey = s.tts?.cloud?.apiKey ? 'set' : '';
  return clone;
}

// ── strict validators (used by update() — throw on invalid input) ───────────

function validateTtsBlock(raw, where) {
  const t = raw || {};
  if (!TTS_ENGINES.includes(t.engine)) {
    throw new Error(`${where}.tts.engine must be one of: ${TTS_ENGINES.join(', ')}`);
  }
  if (!TTS_CLOUD_PROVIDERS.includes(t.cloudProvider)) {
    throw new Error(`${where}.tts.cloudProvider must be one of: ${TTS_CLOUD_PROVIDERS.join(', ')}`);
  }
  let voice = String(t.voice ?? '').trim();
  if (t.engine === 'kokoro') {
    if (!KOKORO_VOICE_RE.test(voice)) {
      throw new Error(`${where}.tts.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella`);
    }
  } else if (t.engine === 'cloud') {
    if (voice.length < 1 || voice.length > 100) {
      throw new Error(`${where}.tts.voice must be 1-100 chars`);
    }
  } else {
    // piper voice is fixed at runtime; tolerate empty.
    if (!voice) voice = 'bf_isabella';
    if (voice.length > 100) throw new Error(`${where}.tts.voice must be 0-100 chars`);
  }
  return { engine: t.engine, cloudProvider: t.cloudProvider, voice };
}

function validatePersonasStrict(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > PERSONA_LIMIT) {
    throw new Error(`personas must be an array of 1-${PERSONA_LIMIT} entries`);
  }
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`personas[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 40) throw new Error(`personas[${i}].name must be 1-40 chars`);
    const soul = String(item.soul ?? '').trim();
    if (soul.length < 1 || soul.length > 400) throw new Error(`personas[${i}].soul must be 1-400 chars`);
    const tagline = String(item.tagline ?? '').trim();
    if (tagline.length > 80) throw new Error(`personas[${i}].tagline must be 0-80 chars`);
    if (!FREQUENCIES.includes(item.frequency)) {
      throw new Error(`personas[${i}].frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    const tts = validateTtsBlock(item.tts, `personas[${i}]`);
    let id = (typeof item.id === 'string' && ID_RE.test(item.id)) ? item.id : mintId('p_');
    if (seen.has(id)) id = mintId('p_');
    seen.add(id);
    return { id, name, tagline, frequency: item.frequency, soul, tts };
  });
}

function validateShowsStrict(raw, personas) {
  if (!Array.isArray(raw)) throw new Error('shows must be an array');
  if (raw.length > SHOWS_LIMIT) throw new Error(`shows must be at most ${SHOWS_LIMIT} entries`);
  const personaIds = personas.map(p => p.id);
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`shows[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 60) throw new Error(`shows[${i}].name must be 1-60 chars`);
    const topic = String(item.topic ?? '').trim();
    if (topic.length > 500) throw new Error(`shows[${i}].topic must be 0-500 chars`);
    if (!personaIds.includes(item.personaId)) {
      throw new Error(`shows[${i}].personaId must reference an existing persona`);
    }
    if (!SHOW_MOODS.includes(item.mood)) {
      throw new Error(`shows[${i}].mood must be one of: ${SHOW_MOODS.join(', ')}`);
    }
    let id = (typeof item.id === 'string' && ID_RE.test(item.id)) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    return { id, name, topic, personaId: item.personaId, mood: item.mood };
  });
}

function validateScheduleStrict(raw, shows) {
  if (!raw || typeof raw !== 'object') throw new Error('schedule must be an object keyed 0-6');
  const showIds = shows.map(s => s.id);
  const week = emptyWeek();
  for (let d = 0; d < 7; d++) {
    const day = raw[d];
    if (day === undefined || day === null) continue;
    if (!Array.isArray(day) || day.length !== 24) {
      throw new Error(`schedule[${d}] must be an array of exactly 24 entries`);
    }
    for (let h = 0; h < 24; h++) {
      const v = day[h];
      if (v === null || v === undefined || v === '') { week[d][h] = null; continue; }
      if (typeof v !== 'string' || !showIds.includes(v)) {
        throw new Error(`schedule[${d}][${h}] references an unknown show`);
      }
      week[d][h] = v;
    }
  }
  return week;
}

// Validate + persist. Returns { saved, requiresRestart } so the UI can react.
export async function update(patch) {
  const cur = await load();
  const next = JSON.parse(JSON.stringify(cur));
  let restart = false;

  if ('jingleRatio' in patch) {
    const v = parseInt(patch.jingleRatio, 10);
    if (!Number.isFinite(v) || v < BOUNDS.jingleRatio.min || v > BOUNDS.jingleRatio.max) {
      throw new Error(`jingleRatio must be int in [${BOUNDS.jingleRatio.min}, ${BOUNDS.jingleRatio.max}]`);
    }
    if (v !== cur.jingleRatio) { next.jingleRatio = v; restart = true; }
  }
  if ('crossfadeDuration' in patch) {
    const v = parseFloat(patch.crossfadeDuration);
    if (!Number.isFinite(v) || v < BOUNDS.crossfadeDuration.min || v > BOUNDS.crossfadeDuration.max) {
      throw new Error(`crossfadeDuration must be number in [${BOUNDS.crossfadeDuration.min}, ${BOUNDS.crossfadeDuration.max}]`);
    }
    if (v !== cur.crossfadeDuration) { next.crossfadeDuration = v; restart = true; }
  }
  if ('weather' in patch) {
    const w = patch.weather || {};
    if (w.lat !== undefined) {
      const v = parseFloat(w.lat);
      if (!Number.isFinite(v) || v < -90 || v > 90) throw new Error('weather.lat out of range');
      next.weather.lat = v;
    }
    if (w.lng !== undefined) {
      const v = parseFloat(w.lng);
      if (!Number.isFinite(v) || v < -180 || v > 180) throw new Error('weather.lng out of range');
      next.weather.lng = v;
    }
    if (typeof w.locationName === 'string' && w.locationName.trim()) {
      next.weather.locationName = w.locationName.trim().slice(0, 80);
    }
  }
  if ('djPrompt' in patch) {
    const v = String(patch.djPrompt ?? '').trim();
    if (v === '') {
      next.djPrompt = '';
    } else {
      if (v.length < 50 || v.length > 4000) {
        throw new Error('djPrompt must be empty (use the default) or 50-4000 chars');
      }
      if (!v.includes('{name}')) {
        throw new Error('djPrompt must contain the {name} placeholder');
      }
      next.djPrompt = v;
    }
  }
  if ('personas' in patch) {
    next.personas = validatePersonasStrict(patch.personas);
  }
  if ('shows' in patch) {
    next.shows = validateShowsStrict(patch.shows, next.personas);
  }
  if ('schedule' in patch) {
    next.schedule = validateScheduleStrict(patch.schedule, next.shows);
  }
  if ('activePersonaId' in patch) {
    if (!next.personas.some(p => p.id === patch.activePersonaId)) {
      throw new Error('activePersonaId must reference an existing persona');
    }
    next.activePersonaId = patch.activePersonaId;
  }
  if ('tts' in patch) {
    const t = patch.tts || {};
    if (t.defaultEngine !== undefined) {
      if (!TTS_ENGINES.includes(t.defaultEngine)) {
        throw new Error(`tts.defaultEngine must be one of: ${TTS_ENGINES.join(', ')}`);
      }
      next.tts.defaultEngine = t.defaultEngine;
    }
    if (t.byKind !== undefined) {
      if (t.byKind === null || typeof t.byKind !== 'object') {
        throw new Error('tts.byKind must be an object');
      }
      for (const [k, v] of Object.entries(t.byKind)) {
        if (!TTS_KINDS.includes(k)) {
          throw new Error(`tts.byKind has unknown kind: ${k}`);
        }
        if (v === null || v === '' || v === undefined) {
          next.tts.byKind[k] = null;
          continue;
        }
        if (!TTS_ENGINES.includes(v)) {
          throw new Error(`tts.byKind.${k} must be null or one of: ${TTS_ENGINES.join(', ')}`);
        }
        next.tts.byKind[k] = v;
      }
    }
    if (t.kokoro !== undefined) {
      const k = t.kokoro || {};
      if (k.voice !== undefined) {
        const v = String(k.voice).trim();
        if (!KOKORO_VOICE_RE.test(v)) {
          throw new Error('tts.kokoro.voice must match <lang><gender>_<name>, e.g. bf_isabella');
        }
        next.tts.kokoro.voice = v;
      }
    }
    if (t.cloud !== undefined) {
      const c = t.cloud || {};
      if (c.provider !== undefined) {
        if (!TTS_CLOUD_PROVIDERS.includes(c.provider)) {
          throw new Error(`tts.cloud.provider must be one of: ${TTS_CLOUD_PROVIDERS.join(', ')}`);
        }
        next.tts.cloud.provider = c.provider;
      }
      if (c.model !== undefined) {
        const v = String(c.model).trim();
        if (v.length < 1 || v.length > 100) throw new Error('tts.cloud.model must be 1-100 chars');
        next.tts.cloud.model = v;
      }
      if (c.voice !== undefined) {
        const v = String(c.voice).trim();
        if (v.length < 1 || v.length > 100) throw new Error('tts.cloud.voice must be 1-100 chars');
        next.tts.cloud.voice = v;
      }
      // 'set' is the redaction sentinel from getRedacted() — ignore it so a
      // round-tripped settings form doesn't overwrite the real key.
      if (c.apiKey !== undefined && c.apiKey !== 'set') {
        next.tts.cloud.apiKey = String(c.apiKey);
      }
    }
  }
  if ('llm' in patch) {
    const l = patch.llm || {};
    if (l.provider !== undefined) {
      if (!LLM_PROVIDERS.includes(l.provider)) {
        throw new Error(`llm.provider must be one of: ${LLM_PROVIDERS.join(', ')}`);
      }
      next.llm.provider = l.provider;
    }
    if (l.model !== undefined) {
      const v = String(l.model).trim();
      if (v.length > 100) throw new Error('llm.model must be 0-100 chars');
      next.llm.model = v;
    }
    if (l.apiKey !== undefined && l.apiKey !== 'set') {
      next.llm.apiKey = String(l.apiKey);
    }
    if (l.pickerAgent !== undefined) {
      next.llm.pickerAgent = !!l.pickerAgent;
    }
  }
  if ('skills' in patch) {
    const sk = patch.skills || {};
    if (sk.enabled !== undefined) {
      if (sk.enabled === null || typeof sk.enabled !== 'object') {
        throw new Error('skills.enabled must be an object of name → boolean');
      }
      for (const [name, on] of Object.entries(sk.enabled)) {
        if (typeof on !== 'boolean') {
          throw new Error(`skills.enabled.${name} must be a boolean`);
        }
        next.skills.enabled[name] = on;
      }
    }
  }

  // Post-patch integrity sweep — a personas/shows change in this patch may
  // have orphaned a show owner, a schedule slot, or the active persona.
  {
    const personaIds = next.personas.map(p => p.id);
    next.shows = next.shows.filter(s => personaIds.includes(s.personaId));
    const showIds = next.shows.map(s => s.id);
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (next.schedule[d][h] && !showIds.includes(next.schedule[d][h])) {
          next.schedule[d][h] = null;
        }
      }
    }
    if (!personaIds.includes(next.activePersonaId)) next.activePersonaId = personaIds[0];
  }

  cache = next;
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  await writeLiquidsoapSettings(next);
  return { saved: next, requiresRestart: restart };
}

// ── persona / show resolution ───────────────────────────────────────────────

// The persona explicitly selected as "on air" in the admin UI.
export function getActivePersona() {
  const s = get();
  return s.personas?.find(p => p.id === s.activePersonaId) || s.personas?.[0] || null;
}

export function resolvePersonaById(id) {
  return get().personas?.find(p => p.id === id) || null;
}

// The show scheduled for `date`'s day-of-week + hour, or null. Self-contained
// (touches only settings data) so context.js can import it without a cycle.
export function resolveActiveShow(date = new Date(), s = get()) {
  const day = date.getDay();
  const hour = date.getHours();
  const showId = s?.schedule?.[day]?.[hour] ?? null;
  if (!showId) return null;
  const show = s.shows?.find(x => x.id === showId);
  if (!show) return null;
  const persona = s.personas?.find(p => p.id === show.personaId) || null;
  return {
    id: show.id,
    name: show.name,
    topic: show.topic,
    mood: show.mood,
    persona: persona ? { id: persona.id, name: persona.name } : null,
  };
}

// The persona that should be on air right now: the current show's owner if a
// show is scheduled, otherwise the admin-selected active persona.
export function getEffectivePersona(date = new Date()) {
  const s = get();
  const show = resolveActiveShow(date, s);
  if (show?.persona?.id) {
    const p = s.personas?.find(x => x.id === show.persona.id);
    if (p) return p;
  }
  return getActivePersona();
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location}. {name}/{soul} come from the supplied persona; the template is
// the global djPrompt (falling back to DEFAULT_DJ_PROMPT_TEMPLATE).
export function renderDjPrompt(persona, ctx = {}) {
  const station = ctx.station || 'SUB/WAVE';
  const location = ctx.location || (cache?.weather?.locationName ?? DEFAULTS.weather.locationName);
  const tpl = (cache?.djPrompt && cache.djPrompt.trim()) ? cache.djPrompt : DEFAULT_DJ_PROMPT_TEMPLATE;
  return tpl
    .replaceAll('{name}', persona?.name || 'your host')
    .replaceAll('{soul}', persona?.soul || DJ_SOULS[0])
    .replaceAll('{station}', station)
    .replaceAll('{location}', location);
}

// Liquidsoap reads two tiny text files instead of JSON.
const LIQ_JINGLE_RATIO_PATH = '/var/sub-wave/liquidsoap_jingle_ratio.txt';
const LIQ_CROSSFADE_PATH = '/var/sub-wave/liquidsoap_crossfade.txt';

export async function writeLiquidsoapSettings(s) {
  await writeFile(LIQ_JINGLE_RATIO_PATH, String(s.jingleRatio));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
}

// Called from server.js startup so the files exist before Liquidsoap reads
// them on its next start. Idempotent.
export async function ensureLiquidsoapSettingsFile() {
  const s = await load();
  if (!existsSync(LIQ_JINGLE_RATIO_PATH) || !existsSync(LIQ_CROSSFADE_PATH)) {
    await writeLiquidsoapSettings(s);
  }
}
