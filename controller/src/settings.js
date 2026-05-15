// Durable settings — overrides for values that have static defaults in code.
// Stored at /var/sub-wave/settings.json. Some apply live (weather location,
// DJ persona); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

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

// Default rotating micro-personas — seeded into settings.dj.souls on first
// run. ollama.djSystem() picks one at random per LLM call so the DJ shifts
// register across segments without losing the named identity. The user can
// add/remove/edit entries in the Settings UI; only the souls in their list
// are used at runtime.
export const DJ_SOULS = [
  'warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific',
  'thoughtful and a little wistful; finds small details in tracks and rooms; favours one well-chosen image over a list',
  'playful and dry; the occasional aside, never sarcastic; treats the studio like a kitchen at midnight',
  'plainspoken and grounded; says less, means more; would rather leave space than fill it',
  'quietly enthusiastic; treats every track like a small recommendation to a friend; specific over poetic',
];

const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];

// TTS engines + voice-kinds. Engine `null` (or missing) for a kind means
// "use defaultEngine". Keeping `null` instead of duplicating defaultEngine
// per kind keeps the UI honest: changing the default applies live to any
// kind the operator hasn't explicitly overridden.
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

// British English Kokoro voices — the ones that fit a BBC 6 Music tone. The
// underlying model ships 54 voices total (American, Spanish, Hindi, Japanese,
// Chinese etc.); we expose only the British subset to keep the UI tidy. Anyone
// who wants a non-British voice can set it via KOKORO_VOICE env or extend this
// list, and they'll still pass validation if they match the {bf,bm,af,am,...}_name
// pattern below.
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

const DEFAULTS = {
  jingleRatio: 30,                    // 1 jingle per N music tracks
  crossfadeDuration: 10.0,            // seconds
  weather: { lat: 52.5862, lng: -2.1288, locationName: 'Wolverhampton' },
  dj: {
    name: 'Frequency',
    souls: [...DJ_SOULS],
    systemPrompt: DEFAULT_DJ_PROMPT_TEMPLATE,
    frequency: 'moderate',
  },
  tts: {
    defaultEngine: 'piper',
    byKind: Object.fromEntries(TTS_KINDS.map(k => [k, null])),
    kokoro: { voice: 'bf_isabella' },
    // Cloud engine config — used when an engine resolves to 'cloud'. `apiKey`
    // empty means "read the provider's env var" (OPENAI_API_KEY etc.).
    cloud: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'alloy', apiKey: '' },
  },
  // LLM provider. `model` empty means "provider default" (config.ollama.model
  // for ollama). `apiKey` empty means "read the provider's env var".
  // `pickerAgent` gates the agentic ToolLoopAgent picker — only worth turning
  // on with a model that handles multi-step tool calls well.
  llm: {
    provider: 'ollama',
    model: '',
    apiKey: '',
    pickerAgent: false,
  },
};

const SOULS_LIMIT = 10;
const SOUL_MIN = 1;
const SOUL_MAX = 400;

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

const BOUNDS = {
  jingleRatio:        { min: 1, max: 1000, type: 'int' },
  crossfadeDuration:  { min: 0, max: 30,   type: 'float' },
};

let cache = null;

export async function load() {
  if (cache) return cache;
  let stored = {};
  if (existsSync(SETTINGS_PATH)) {
    try { stored = JSON.parse(await readFile(SETTINGS_PATH, 'utf8')); } catch {}
  }
  cache = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    weather: {
      lat: stored.weather?.lat ?? DEFAULTS.weather.lat,
      lng: stored.weather?.lng ?? DEFAULTS.weather.lng,
      locationName: stored.weather?.locationName ?? DEFAULTS.weather.locationName,
    },
    dj: {
      name: stored.dj?.name ?? DEFAULTS.dj.name,
      souls: (() => {
        const normalized = normalizeSouls(stored.dj?.souls);
        if (normalized && normalized.length) return normalized;
        // Migrate legacy single-soul field, falling back to defaults.
        if (typeof stored.dj?.soul === 'string' && stored.dj.soul.trim()) {
          return [stored.dj.soul.trim().slice(0, SOUL_MAX)];
        }
        return [...DEFAULTS.dj.souls];
      })(),
      systemPrompt: stored.dj?.systemPrompt ?? DEFAULTS.dj.systemPrompt,
      frequency: FREQUENCIES.includes(stored.dj?.frequency) ? stored.dj.frequency : DEFAULTS.dj.frequency,
    },
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
  };
  return cache;
}

export function get() {
  return cache || DEFAULTS;
}

export function getDefaults() {
  return DEFAULTS;
}

// Settings with secret fields masked — for anything that leaves the process
// (the admin /settings response). A non-empty key becomes "set"; empty stays
// "". The UI shows whether a key is configured without exposing its value;
// sending "set" back in an update() patch is ignored (treated as unchanged).
export function getRedacted() {
  const s = get();
  const clone = JSON.parse(JSON.stringify(s));
  if (clone.llm) clone.llm.apiKey = s.llm?.apiKey ? 'set' : '';
  if (clone.tts?.cloud) clone.tts.cloud.apiKey = s.tts?.cloud?.apiKey ? 'set' : '';
  return clone;
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
  if ('dj' in patch) {
    const d = patch.dj || {};
    if (d.name !== undefined) {
      const v = String(d.name).trim();
      if (v.length < 1 || v.length > 40) throw new Error('dj.name must be 1-40 chars');
      next.dj.name = v;
    }
    if (d.souls !== undefined) {
      if (!Array.isArray(d.souls)) throw new Error('dj.souls must be an array of strings');
      const normalized = normalizeSouls(d.souls);
      if (!normalized || normalized.length === 0) {
        throw new Error(`dj.souls must contain 1-${SOULS_LIMIT} non-empty strings, each ${SOUL_MIN}-${SOUL_MAX} chars`);
      }
      next.dj.souls = normalized;
    }
    if (d.systemPrompt !== undefined) {
      const v = String(d.systemPrompt).trim();
      if (v.length < 50 || v.length > 4000) throw new Error('dj.systemPrompt must be 50-4000 chars');
      if (!v.includes('{name}')) {
        throw new Error('dj.systemPrompt must contain the {name} placeholder');
      }
      next.dj.systemPrompt = v;
    }
    if (d.frequency !== undefined) {
      if (!FREQUENCIES.includes(d.frequency)) {
        throw new Error(`dj.frequency must be one of: ${FREQUENCIES.join(', ')}`);
      }
      next.dj.frequency = d.frequency;
    }
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

  cache = next;
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  await writeLiquidsoapSettings(next);
  return { saved: next, requiresRestart: restart };
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location} into the operator-supplied template. Called fresh per LLM call
// so live edits show up in the next intro/link without a restart.
export function renderDjPrompt(dj, ctx = {}) {
  const station = ctx.station || 'SUB/WAVE';
  const location = ctx.location || (cache?.weather?.locationName ?? DEFAULTS.weather.locationName);
  const soul = dj?.soul || dj?.souls?.[0] || DEFAULTS.dj.souls[0];
  return (dj?.systemPrompt || DEFAULT_DJ_PROMPT_TEMPLATE)
    .replaceAll('{name}', dj?.name || DEFAULTS.dj.name)
    .replaceAll('{soul}', soul)
    .replaceAll('{station}', station)
    .replaceAll('{location}', location);
}

// Liquidsoap reads two tiny text files instead of JSON — Liquidsoap 2.2.5
// JSON parsing is awkward to type and not worth the effort for two values.
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
