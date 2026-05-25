// Durable settings — overrides for values that have static defaults in code.
// Stored at <stateDir>/settings.json. Some apply live (weather location,
// DJ personas, shows); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { STATE_DIR } from './config.js';

const SETTINGS_PATH = `${STATE_DIR}/settings.json`;

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

// Seed souls — the SEED_PERSONAS roster picks from these. renderDjPrompt()
// falls back to DJ_SOULS[0] when the substituted persona has no soul of its
// own; the agent path (agentPersonaPreamble) instead substitutes an empty
// string, since its template doesn't require a soul to read cleanly.
export const DJ_SOULS = [
  'warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific',
  'thoughtful and a little wistful; finds small details in tracks and rooms; favours one well-chosen image over a list',
  'playful and dry; the occasional aside, never sarcastic; treats the studio like a kitchen at midnight',
  'plainspoken and grounded; says less, means more; would rather leave space than fill it',
  'quietly enthusiastic; treats every track like a small recommendation to a friend; specific over poetic',
];

export const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];

// Per-persona verbosity. 'concise' is the historical one-liner behaviour;
// 'extended' roughly doubles every spoken segment for a storytelling DJ.
// See llm/dj.js LENGTH_PHRASES for the actual length directives.
export const SCRIPT_LENGTHS = ['concise', 'extended'];

// TTS engines. Every spoken segment is voiced by the on-air persona's own
// `tts` config (see audio/tts.js); only jingle rendering falls back to the
// global defaultEngine.
//
// `cloud` routes through the AI SDK (OpenAI / ElevenLabs speech models) —
// see llm/speech.js. `piper`, `kokoro`, and `chatterbox` are local engines.
// Chatterbox is opt-in — the default controller image doesn't bundle it; build
// the image with `--build-arg WITH_CHATTERBOX=1` (see docker/Dockerfile.controller)
// to include the runtime. The dispatcher gates the engine on isAvailable() so
// settings can reference it safely even when the runtime is absent (the engine
// just falls back to Piper).
export const TTS_ENGINES = ['piper', 'kokoro', 'chatterbox', 'cloud'];

// LLM provider abstraction. `ollama` is the homelab default; the cloud
// providers are opt-in and resolved by llm/provider.js. `openrouter` and
// `gateway` are aggregators — one key, any vendor's models. `openai-compatible`
// targets any self-hosted OpenAI-compatible server (llama.cpp, vLLM, LM Studio,
// etc.) via the operator-supplied `llm.baseUrl`.
export const LLM_PROVIDERS = [
  'ollama',
  'openai-compatible',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'openrouter',
  'gateway',
];

// Cloud TTS vendors usable by the `cloud` engine. `openai-compatible` targets
// any self-hosted OpenAI-compatible speech server (Chatterbox, Qwen3 TTS,
// VibeVoice, etc.) via the operator-supplied `tts.cloud.baseUrl` — mirrors the
// LLM provider of the same name.
export const TTS_CLOUD_PROVIDERS = ['openai', 'elevenlabs', 'openai-compatible'];

// Web-search backends for the segment director's `web-search` capability.
// `duckduckgo` is the homelab default — DuckDuckGo's Instant Answer API is free
// and keyless, returns useful results only for entity / definition queries, and
// silence otherwise (which the segment director already treats as a valid
// outcome). `tavily` is the paid option for operators who want richer web
// results; it reads its key from SEARCH_API_KEY.
export const SEARCH_PROVIDERS = ['duckduckgo', 'tavily'];

// Canonical mood vocabulary. Shared by the library tagger (music/tag-library.js
// imports this as MOOD_VOCAB) and the Shows scheduler — a show's `mood`
// overrides the autonomous dominantMood, so it must come from this list.
export const SHOW_MOODS = [
  'energetic',
  'calm',
  'reflective',
  'celebratory',
  'romantic',
  'spiritual',
  'focus',
  'workout',
  'driving',
  'cooking',
  'rainy',
  'sunny',
  'night',
  'morning',
  'evening',
  'festival',
  'cultural',
];

// British English Kokoro voices — the ones that fit a BBC 6 Music tone. The
// underlying model ships 54 voices total; we expose only the British subset to
// keep the UI tidy. Any voice matching KOKORO_VOICE_RE still passes validation.
export const KOKORO_VOICES_BRITISH = [
  { id: 'bm_george', label: 'George (M)' },
  { id: 'bm_fable', label: 'Fable (M)' },
  { id: 'bm_daniel', label: 'Daniel (M)' },
  { id: 'bm_lewis', label: 'Lewis (M)' },
  { id: 'bf_emma', label: 'Emma (F)' },
  { id: 'bf_isabella', label: 'Isabella (F)' },
  { id: 'bf_alice', label: 'Alice (F)' },
  { id: 'bf_lily', label: 'Lily (F)' },
];

const KOKORO_VOICE_RE = /^[a-z]{2}_[a-z0-9]+$/;
// Chatterbox voices are reference-WAV filenames living in
// config.chatterbox.voiceDir. Loose check — basename only, no path
// separators, conservative character set, ends in .wav. Empty is also
// valid (means "use the built-in default voice").
const CHATTERBOX_VOICE_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/;
const ID_RE = /^[a-z0-9_]{3,32}$/;
// Skill slugs (e.g. 'weather', 'random-facts'). The skills registry is the
// source of truth for which slugs exist; settings only checks the shape.
const SKILL_SLUG_RE = /^[a-z0-9-]{1,40}$/;

const PERSONA_LIMIT = 12;
const SHOWS_LIMIT = 64;
const SKILLS_PER_PERSONA_LIMIT = 20;
const WEBHOOKS_LIMIT = 16;

// Event names the outbound webhook fan-out can subscribe to. Kept in sync
// with broadcast/webhooks.ts WEBHOOK_EVENTS — duplicated here so settings.ts
// has no runtime dependency on the broadcast module.
const WEBHOOK_EVENTS = [
  'track.play',
  'dj.say',
  'dj.link',
  'request.received',
];

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

// Seed roster — three distinct DJs shipped on a fresh install (and used as the
// migration fallback when a legacy `dj` block carries no real souls). Distinct
// names, taglines, souls and talk frequency — a real roster, not clones of one
// DJ. Engine stays `piper` (local, needs no key); each persona's stored `voice`
// is a different British Kokoro voice, so switching to the Kokoro engine yields
// genuinely different-sounding DJs without any further editing.
export const SEED_PERSONAS = [
  {
    id: 'p_default0',
    name: 'Marlowe',
    tagline: 'Late-night company and well-chosen records.',
    frequency: 'moderate',
    scriptLength: 'concise',
    soul: DJ_SOULS[0],
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_george' },
  },
  {
    id: 'p_default1',
    name: 'Wren',
    tagline: 'Small details, quiet rooms, one good image.',
    frequency: 'quiet',
    scriptLength: 'concise',
    soul: DJ_SOULS[1],
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_alice' },
  },
  {
    id: 'p_default2',
    name: 'Hale',
    tagline: 'Says less, means more. Leaves space.',
    frequency: 'moderate',
    scriptLength: 'concise',
    soul: DJ_SOULS[3],
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_daniel' },
  },
];

const DEFAULTS = {
  jingleRatio: 30, // 1 jingle per N music tracks
  crossfadeDuration: 10.0, // seconds
  weather: { lat: 52.5862, lng: -2.1288, locationName: 'Wolverhampton' },
  // Operator-facing station name. Substituted into the DJ prompt's {station}
  // placeholder and returned by GET /dj for the landing page. The product is
  // still called SUB/WAVE — this is what the operator's station running on it
  // is called (e.g. "Frequency 88", "Late Shift Radio").
  station: 'SUB/WAVE',
  // Global DJ prompt template. '' means "use DEFAULT_DJ_PROMPT_TEMPLATE".
  djPrompt: '',
  // The persona roster. One persona is "active" at a time (activePersonaId);
  // a scheduled show can override which persona is on-air for its hour.
  personas: SEED_PERSONAS,
  activePersonaId: SEED_PERSONAS[0].id,
  // Reusable show definitions, placed into the weekly schedule grid.
  shows: [],
  // 7-day x 24-hour grid of showId|null. An empty hour = run autonomously.
  schedule: emptyWeek(),
  tts: {
    defaultEngine: 'piper',
    kokoro: { voice: 'bf_isabella' },
    // Global Chatterbox fallback — used as the reference voice when the
    // engine resolves to chatterbox but no persona-level voice is set.
    // Empty filename means "use the model's built-in default voice".
    chatterbox: { referenceVoice: '' },
    // Cloud engine config — used when an engine resolves to 'cloud'. A persona
    // chooses provider+voice; `model` and `apiKey` stay shared here. `apiKey`
    // empty means "read the provider's env var" (OPENAI_API_KEY etc.).
    // `enabled` is the operator's "Off" switch — when false the cloud engine
    // reports unavailable regardless of key, so the engine pickers grey it out.
    cloud: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      apiKey: '',
      // Base URL for the openai-compatible provider, including the /v1 suffix
      // (e.g. http://192.168.1.101:5000/v1). Required — and only used — when
      // provider === 'openai-compatible'.
      baseUrl: '',
    },
  },
  llm: {
    provider: 'ollama',
    model: '',
    apiKey: '',
    // Ollama server URL. Empty → fall back to config.ollama.url. Only used
    // when provider === 'ollama'.
    ollamaUrl: '',
    // OpenAI-compatible server base URL, including the /v1 suffix
    // (e.g. http://192.168.1.101:8080/v1). Required — and only used —
    // when provider === 'openai-compatible'.
    baseUrl: '',
    // Whether to let reasoning ("thinking") models emit a chain-of-thought
    // before the answer. Off by default: the DJ writes short scripts and
    // structured picks that don't benefit from reasoning, and an uncapped
    // <think> block on a small model balloons every call (see llm/sdk.js
    // token caps + llm/provider.js no-think fetch).
    reasoning: false,
    // When on, the session DJ agent drives track-picking, links and listener
    // requests as a tool-loop over the session chat history (broadcast/
    // dj-agent.js). When off, the stateless pool picker runs instead — still
    // inside a session, still logged, just without the conversational loop.
    pickerAgent: true,
    // When on, autonomous DJ LLM work (track picks, links, station IDs,
    // hourly checks, segments) and listener requests pause whenever Icecast
    // reports zero listeners — the stream coasts on the auto playlist — and
    // resume as soon as someone tunes in. Off by default.
    pauseWhenEmpty: false,
  },
  // Web-search backend for the segment director's web-search capability.
  // Default `duckduckgo` works out of the box with no key; `tavily` reads its
  // key from SEARCH_API_KEY (or the optional override below). `apiKey` is
  // only meaningful for Tavily.
  search: {
    provider: 'duckduckgo',
    apiKey: '',
  },
  skills: {
    enabled: {},
  },
  // Sound-effects library. When disabled, the segment-director agent is never
  // shown the effect catalogue, so it stops garnishing spoken breaks with
  // stingers. The library files themselves stay on disk either way.
  sfx: {
    enabled: true,
  },
  // Outbound webhooks. Each entry POSTs station events (see broadcast/
  // webhooks.ts for the event list) to `url` with a fire-and-forget HTTP
  // call. Empty by default — operators add hooks via the admin UI.
  webhooks: [] as any[],
  // Station-wide scrobbling. Each backend is independent; both are paste-only
  // (no OAuth) and both are gated on listener count > 0 at scrobble time (a
  // null/unknown count is treated as zero — fail closed, see broadcast/
  // scrobble.ts). API keys/secrets/tokens live here OR in state/secrets.env
  // (env wins). `username` is display-only.
  scrobble: {
    lastfm: {
      enabled: false,
      apiKey: '',
      apiSecret: '',
      sessionKey: '',
      username: '',
    },
    listenbrainz: {
      enabled: false,
      userToken: '',
      username: '',
    },
  },
};

const BOUNDS = {
  jingleRatio: { min: 1, max: 1000, type: 'int' },
  crossfadeDuration: { min: 0, max: 30, type: 'float' },
};

let cache: any = null;

// ── normalizers (lenient — used by load(), clamp/default rather than throw) ──

// Persona skill assignment. `null` (raw not an array) is the "all skills"
// sentinel — used by legacy personas and the code default so behaviour is
// unchanged until the operator explicitly picks a subset. An empty array
// means "this persona runs no skills".
function normalizeSkills(raw: any) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!SKILL_SLUG_RE.test(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= SKILLS_PER_PERSONA_LIMIT) break;
  }
  return out;
}

function normalizeTts(raw: any) {
  const engine = TTS_ENGINES.includes(raw?.engine) ? raw.engine : 'piper';
  const cloudProvider = TTS_CLOUD_PROVIDERS.includes(raw?.cloudProvider)
    ? raw.cloudProvider
    : 'openai';
  let voice =
    typeof raw?.voice === 'string' && raw.voice.trim() ? raw.voice.trim().slice(0, 100) : '';
  if (engine === 'kokoro' && !KOKORO_VOICE_RE.test(voice)) voice = 'bf_isabella';
  // Chatterbox voices are reference-WAV filenames in config.chatterbox.voiceDir.
  // Empty is legitimate ("use built-in default"), invalid filenames get reset
  // to empty rather than rewritten to a Kokoro id.
  if (engine === 'chatterbox' && voice && !CHATTERBOX_VOICE_RE.test(voice)) voice = '';
  // openai-compatible voices are server-specific (often arbitrary cloning ref
  // names) — no canonical default; leave empty so generateSpeech omits the
  // field and the server picks its own.
  if (!voice && engine === 'cloud' && cloudProvider !== 'openai-compatible') voice = 'alloy';
  if (!voice && engine !== 'cloud' && engine !== 'chatterbox') voice = 'bf_isabella';
  return { engine, cloudProvider, voice };
}

function normalizePersona(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const soul = typeof raw.soul === 'string' ? raw.soul.trim().slice(0, 400) : '';
  if (!name || !soul) return null;
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : mintId('p_'),
    name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline.trim().slice(0, 80) : '',
    frequency: FREQUENCIES.includes(raw.frequency) ? raw.frequency : 'moderate',
    scriptLength: SCRIPT_LENGTHS.includes(raw.scriptLength) ? raw.scriptLength : 'concise',
    soul,
    tts: normalizeTts(raw.tts),
    skills: normalizeSkills(raw.skills),
  };
}

function normalizePersonaArray(raw: any) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: any[] = [];
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

function normalizeShows(raw: any, personaIds: string[]) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
    if (!name) continue;
    if (!personaIds.includes(item.personaId)) continue; // drop dangling owner
    if (!SHOW_MOODS.includes(item.mood)) continue;
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    out.push({
      id,
      name,
      topic: typeof item.topic === 'string' ? item.topic.trim().slice(0, 1000) : '',
      personaId: item.personaId,
      mood: item.mood,
    });
    if (out.length >= SHOWS_LIMIT) break;
  }
  return out;
}

function normalizeSchedule(raw: any, showIds: string[]) {
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

export async function load() {
  if (cache) return cache;
  let stored: any = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      stored = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    } catch {}
  }

  // ── personas ──────────────────────────────────────────────────────────────
  // No valid persona roster in settings.json (fresh install) → ship the seed
  // roster of three distinct DJs.
  const personas =
    normalizePersonaArray(stored.personas) ||
    DEFAULTS.personas.map(p => ({ ...p, tts: { ...p.tts } }));
  const personaIds = personas.map(p => p.id);

  const activePersonaId = personaIds.includes(stored.activePersonaId)
    ? stored.activePersonaId
    : personaIds[0];

  // djPrompt — prefer the new field, else migrate the legacy dj.systemPrompt.
  let djPrompt =
    typeof stored.djPrompt === 'string'
      ? stored.djPrompt
      : typeof stored.dj?.systemPrompt === 'string'
        ? stored.dj.systemPrompt
        : '';
  if (djPrompt.trim() === DEFAULT_DJ_PROMPT_TEMPLATE.trim()) djPrompt = '';

  const shows = normalizeShows(stored.shows, personaIds);
  const schedule = normalizeSchedule(
    stored.schedule,
    shows.map(s => s.id),
  );

  cache = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    weather: {
      lat: stored.weather?.lat ?? DEFAULTS.weather.lat,
      lng: stored.weather?.lng ?? DEFAULTS.weather.lng,
      locationName: stored.weather?.locationName ?? DEFAULTS.weather.locationName,
    },
    djPrompt,
    station:
      typeof stored.station === 'string' && stored.station.trim()
        ? stored.station.trim().slice(0, 80)
        : DEFAULTS.station,
    personas,
    activePersonaId,
    shows,
    schedule,
    tts: {
      defaultEngine: TTS_ENGINES.includes(stored.tts?.defaultEngine)
        ? stored.tts.defaultEngine
        : DEFAULTS.tts.defaultEngine,
      kokoro: {
        voice:
          typeof stored.tts?.kokoro?.voice === 'string' &&
          KOKORO_VOICE_RE.test(stored.tts.kokoro.voice)
            ? stored.tts.kokoro.voice
            : DEFAULTS.tts.kokoro.voice,
      },
      chatterbox: {
        referenceVoice:
          typeof stored.tts?.chatterbox?.referenceVoice === 'string' &&
          (stored.tts.chatterbox.referenceVoice === '' ||
            CHATTERBOX_VOICE_RE.test(stored.tts.chatterbox.referenceVoice))
            ? stored.tts.chatterbox.referenceVoice
            : DEFAULTS.tts.chatterbox.referenceVoice,
      },
      cloud: {
        // Explicit boolean wins; otherwise an install that already had a saved
        // cloud key keeps cloud on so the upgrade doesn't silently disable it.
        enabled:
          typeof stored.tts?.cloud?.enabled === 'boolean'
            ? stored.tts.cloud.enabled
            : !!stored.tts?.cloud?.apiKey,
        provider: TTS_CLOUD_PROVIDERS.includes(stored.tts?.cloud?.provider)
          ? stored.tts.cloud.provider
          : DEFAULTS.tts.cloud.provider,
        model:
          typeof stored.tts?.cloud?.model === 'string' && stored.tts.cloud.model.trim()
            ? stored.tts.cloud.model.trim()
            : DEFAULTS.tts.cloud.model,
        voice:
          typeof stored.tts?.cloud?.voice === 'string' && stored.tts.cloud.voice.trim()
            ? stored.tts.cloud.voice.trim()
            : DEFAULTS.tts.cloud.voice,
        apiKey: typeof stored.tts?.cloud?.apiKey === 'string' ? stored.tts.cloud.apiKey : '',
        baseUrl:
          typeof stored.tts?.cloud?.baseUrl === 'string'
            ? stored.tts.cloud.baseUrl.trim()
            : DEFAULTS.tts.cloud.baseUrl,
      },
    },
    llm: {
      provider: LLM_PROVIDERS.includes(stored.llm?.provider)
        ? stored.llm.provider
        : DEFAULTS.llm.provider,
      model: typeof stored.llm?.model === 'string' ? stored.llm.model.trim() : DEFAULTS.llm.model,
      apiKey: typeof stored.llm?.apiKey === 'string' ? stored.llm.apiKey : DEFAULTS.llm.apiKey,
      ollamaUrl:
        typeof stored.llm?.ollamaUrl === 'string'
          ? stored.llm.ollamaUrl.trim()
          : DEFAULTS.llm.ollamaUrl,
      baseUrl:
        typeof stored.llm?.baseUrl === 'string' ? stored.llm.baseUrl.trim() : DEFAULTS.llm.baseUrl,
      reasoning:
        typeof stored.llm?.reasoning === 'boolean' ? stored.llm.reasoning : DEFAULTS.llm.reasoning,
      pickerAgent:
        typeof stored.llm?.pickerAgent === 'boolean'
          ? stored.llm.pickerAgent
          : DEFAULTS.llm.pickerAgent,
      pauseWhenEmpty:
        typeof stored.llm?.pauseWhenEmpty === 'boolean'
          ? stored.llm.pauseWhenEmpty
          : DEFAULTS.llm.pauseWhenEmpty,
    },
    search: {
      provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
        ? stored.search.provider
        : DEFAULTS.search.provider,
      apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : '',
    },
    skills: {
      enabled: Object.fromEntries(
        Object.entries(stored.skills?.enabled || {}).filter(([, v]) => typeof v === 'boolean'),
      ),
    },
    sfx: {
      enabled: typeof stored.sfx?.enabled === 'boolean' ? stored.sfx.enabled : DEFAULTS.sfx.enabled,
    },
    webhooks: normalizeWebhooks(stored.webhooks),
    scrobble: {
      lastfm: {
        enabled:
          typeof stored.scrobble?.lastfm?.enabled === 'boolean'
            ? stored.scrobble.lastfm.enabled
            : DEFAULTS.scrobble.lastfm.enabled,
        apiKey:
          typeof stored.scrobble?.lastfm?.apiKey === 'string'
            ? stored.scrobble.lastfm.apiKey
            : '',
        apiSecret:
          typeof stored.scrobble?.lastfm?.apiSecret === 'string'
            ? stored.scrobble.lastfm.apiSecret
            : '',
        sessionKey:
          typeof stored.scrobble?.lastfm?.sessionKey === 'string'
            ? stored.scrobble.lastfm.sessionKey
            : '',
        username:
          typeof stored.scrobble?.lastfm?.username === 'string'
            ? stored.scrobble.lastfm.username.trim().slice(0, 40)
            : '',
      },
      listenbrainz: {
        enabled:
          typeof stored.scrobble?.listenbrainz?.enabled === 'boolean'
            ? stored.scrobble.listenbrainz.enabled
            : DEFAULTS.scrobble.listenbrainz.enabled,
        userToken:
          typeof stored.scrobble?.listenbrainz?.userToken === 'string'
            ? stored.scrobble.listenbrainz.userToken
            : '',
        username:
          typeof stored.scrobble?.listenbrainz?.username === 'string'
            ? stored.scrobble.listenbrainz.username.trim().slice(0, 40)
            : '',
      },
    },
  };
  return cache;
}

// Lenient normalizer — used by load(). Drops invalid entries silently rather
// than failing the whole boot.
function normalizeWebhooks(raw: any) {
  if (!Array.isArray(raw)) return [];
  const out: any[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!/^https?:\/\//.test(url) || url.length > 500) continue;
    const events = Array.isArray(item.events)
      ? item.events.filter((e: any) => WEBHOOK_EVENTS.includes(e))
      : [];
    if (!events.length) continue;
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('wh_');
    if (seen.has(id)) id = mintId('wh_');
    seen.add(id);
    out.push({
      id,
      url,
      events,
      enabled: typeof item.enabled === 'boolean' ? item.enabled : true,
      authHeader:
        typeof item.authHeader === 'string' ? item.authHeader.slice(0, 500) : '',
    });
    if (out.length >= WEBHOOKS_LIMIT) break;
  }
  return out;
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
  if (clone.search) clone.search.apiKey = s.search?.apiKey ? 'set' : '';
  if (Array.isArray(clone.webhooks)) {
    for (let i = 0; i < clone.webhooks.length; i++) {
      clone.webhooks[i].authHeader = s.webhooks?.[i]?.authHeader ? 'set' : '';
    }
  }
  if (clone.scrobble?.lastfm) {
    clone.scrobble.lastfm.apiKey = s.scrobble?.lastfm?.apiKey ? 'set' : '';
    clone.scrobble.lastfm.apiSecret = s.scrobble?.lastfm?.apiSecret ? 'set' : '';
    clone.scrobble.lastfm.sessionKey = s.scrobble?.lastfm?.sessionKey ? 'set' : '';
  }
  if (clone.scrobble?.listenbrainz) {
    clone.scrobble.listenbrainz.userToken = s.scrobble?.listenbrainz?.userToken ? 'set' : '';
  }
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
      throw new Error(
        `${where}.tts.voice must match <lang><gender>_<name> for kokoro, e.g. bf_isabella`,
      );
    }
  } else if (t.engine === 'chatterbox') {
    // Empty = use built-in default voice. Otherwise the value must be a plain
    // .wav filename — no path separators — referencing a file the operator has
    // uploaded into config.chatterbox.voiceDir.
    if (voice && !CHATTERBOX_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for chatterbox must be a .wav filename (no path), or empty for the default voice`,
      );
    }
  } else if (t.engine === 'cloud') {
    // openai-compatible voices are server-specific; an empty voice lets the
    // server use its own default. openai/elevenlabs both require a voice id.
    if (t.cloudProvider === 'openai-compatible') {
      if (voice.length > 100) throw new Error(`${where}.tts.voice must be 0-100 chars`);
    } else if (voice.length < 1 || voice.length > 100) {
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
    if (name.length < 1 || name.length > 40)
      throw new Error(`personas[${i}].name must be 1-40 chars`);
    const soul = String(item.soul ?? '').trim();
    if (soul.length < 1 || soul.length > 400)
      throw new Error(`personas[${i}].soul must be 1-400 chars`);
    const tagline = String(item.tagline ?? '').trim();
    if (tagline.length > 80) throw new Error(`personas[${i}].tagline must be 0-80 chars`);
    if (!FREQUENCIES.includes(item.frequency)) {
      throw new Error(`personas[${i}].frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    // scriptLength — optional. Absent → 'concise' (the default and the
    // historical behaviour); present must be a known value.
    let scriptLength = 'concise';
    if (item.scriptLength !== undefined && item.scriptLength !== null) {
      if (!SCRIPT_LENGTHS.includes(item.scriptLength)) {
        throw new Error(`personas[${i}].scriptLength must be one of: ${SCRIPT_LENGTHS.join(', ')}`);
      }
      scriptLength = item.scriptLength;
    }
    const tts = validateTtsBlock(item.tts, `personas[${i}]`);
    // skills — optional. Absent → null ("all skills", legacy/default). Present
    // → an explicit slug array (the UI always sends one once edited).
    let skills: string[] | null = null;
    if (item.skills !== undefined && item.skills !== null) {
      if (!Array.isArray(item.skills)) {
        throw new Error(`personas[${i}].skills must be an array of skill names`);
      }
      if (item.skills.length > SKILLS_PER_PERSONA_LIMIT) {
        throw new Error(
          `personas[${i}].skills must be at most ${SKILLS_PER_PERSONA_LIMIT} entries`,
        );
      }
      const seenSk = new Set<string>();
      skills = [];
      for (const s of item.skills) {
        const v = String(s ?? '').trim();
        if (!SKILL_SLUG_RE.test(v)) {
          throw new Error(`personas[${i}].skills entries must be slug strings`);
        }
        if (!seenSk.has(v)) {
          seenSk.add(v);
          skills.push(v);
        }
      }
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('p_');
    if (seen.has(id)) id = mintId('p_');
    seen.add(id);
    return {
      id,
      name,
      tagline,
      frequency: item.frequency,
      scriptLength,
      soul,
      tts,
      skills,
    };
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
    if (topic.length > 1000) throw new Error(`shows[${i}].topic must be 0-1000 chars`);
    if (!personaIds.includes(item.personaId)) {
      throw new Error(`shows[${i}].personaId must reference an existing persona`);
    }
    if (!SHOW_MOODS.includes(item.mood)) {
      throw new Error(`shows[${i}].mood must be one of: ${SHOW_MOODS.join(', ')}`);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
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
      if (v === null || v === undefined || v === '') {
        week[d][h] = null;
        continue;
      }
      if (typeof v !== 'string' || !showIds.includes(v)) {
        throw new Error(`schedule[${d}][${h}] references an unknown show`);
      }
      week[d][h] = v;
    }
  }
  return week;
}

// Strict validator — used by update(). `existing` is the current list, so
// the operator can keep a previously-set authHeader by sending the redacted
// sentinel back unchanged.
function validateWebhooksStrict(raw: any, existing: any[] = []) {
  if (!Array.isArray(raw)) throw new Error('webhooks must be an array');
  if (raw.length > WEBHOOKS_LIMIT) {
    throw new Error(`webhooks must be at most ${WEBHOOKS_LIMIT} entries`);
  }
  const byId = new Map(existing.map((h: any) => [h.id, h]));
  const seen = new Set<string>();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`webhooks[${i}] must be an object`);
    const url = String(item.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) {
      throw new Error(`webhooks[${i}].url must start with http:// or https://`);
    }
    if (url.length > 500) throw new Error(`webhooks[${i}].url too long`);
    if (!Array.isArray(item.events) || item.events.length === 0) {
      throw new Error(`webhooks[${i}].events must be a non-empty array`);
    }
    const events: string[] = [];
    for (const e of item.events) {
      if (!WEBHOOK_EVENTS.includes(e)) {
        throw new Error(
          `webhooks[${i}].events entries must be one of: ${WEBHOOK_EVENTS.join(', ')}`,
        );
      }
      if (!events.includes(e)) events.push(e);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('wh_');
    if (seen.has(id)) id = mintId('wh_');
    seen.add(id);
    // authHeader: sentinel 'set' from getRedacted() means "keep the existing
    // value" — the UI never re-sends the actual header. Anything else replaces.
    const prior = byId.get(id);
    let authHeader = '';
    if (item.authHeader === 'set' && prior?.authHeader) {
      authHeader = prior.authHeader;
    } else if (typeof item.authHeader === 'string') {
      authHeader = item.authHeader.slice(0, 500);
    }
    return {
      id,
      url,
      events,
      enabled: item.enabled !== false,
      authHeader,
    };
  });
}

// Validate + persist. Returns { saved, requiresRestart } so the UI can react.
export async function update(patch) {
  const cur = await load();
  const next = JSON.parse(JSON.stringify(cur));
  let restart = false;

  if ('jingleRatio' in patch) {
    const v = parseInt(patch.jingleRatio, 10);
    if (!Number.isFinite(v) || v < BOUNDS.jingleRatio.min || v > BOUNDS.jingleRatio.max) {
      throw new Error(
        `jingleRatio must be int in [${BOUNDS.jingleRatio.min}, ${BOUNDS.jingleRatio.max}]`,
      );
    }
    if (v !== cur.jingleRatio) {
      next.jingleRatio = v;
      restart = true;
    }
  }
  if ('crossfadeDuration' in patch) {
    const v = parseFloat(patch.crossfadeDuration);
    if (
      !Number.isFinite(v) ||
      v < BOUNDS.crossfadeDuration.min ||
      v > BOUNDS.crossfadeDuration.max
    ) {
      throw new Error(
        `crossfadeDuration must be number in [${BOUNDS.crossfadeDuration.min}, ${BOUNDS.crossfadeDuration.max}]`,
      );
    }
    if (v !== cur.crossfadeDuration) {
      next.crossfadeDuration = v;
      restart = true;
    }
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
  if ('station' in patch) {
    const v = String(patch.station ?? '').trim();
    if (v === '') {
      next.station = DEFAULTS.station;
    } else {
      if (v.length > 80) throw new Error('station name must be 80 chars or fewer');
      next.station = v;
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
    if (t.chatterbox !== undefined) {
      const cb = t.chatterbox || {};
      if (cb.referenceVoice !== undefined) {
        const v = String(cb.referenceVoice).trim();
        if (v && !CHATTERBOX_VOICE_RE.test(v)) {
          throw new Error(
            'tts.chatterbox.referenceVoice must be a .wav filename (no path), or empty for the default voice',
          );
        }
        next.tts.chatterbox.referenceVoice = v;
      }
    }
    if (t.cloud !== undefined) {
      const c = t.cloud || {};
      if (c.enabled !== undefined) {
        next.tts.cloud.enabled = !!c.enabled;
      }
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
        // openai-compatible voices are server-specific (often arbitrary
        // cloning ref names) and may legitimately be blank — let the server
        // pick its own default. openai/elevenlabs require a voice id.
        const provider = c.provider !== undefined ? c.provider : next.tts.cloud.provider;
        const allowEmpty = provider === 'openai-compatible';
        if (v.length > 100 || (!allowEmpty && v.length < 1)) {
          throw new Error(
            allowEmpty
              ? 'tts.cloud.voice must be 0-100 chars'
              : 'tts.cloud.voice must be 1-100 chars',
          );
        }
        next.tts.cloud.voice = v;
      }
      // 'set' is the redaction sentinel from getRedacted() — ignore it so a
      // round-tripped settings form doesn't overwrite the real key.
      if (c.apiKey !== undefined && c.apiKey !== 'set') {
        next.tts.cloud.apiKey = String(c.apiKey);
      }
      if (c.baseUrl !== undefined) {
        const v = String(c.baseUrl).trim();
        if (v.length > 200) throw new Error('tts.cloud.baseUrl must be 0-200 chars');
        if (v && !/^https?:\/\//i.test(v)) {
          throw new Error('tts.cloud.baseUrl must start with http:// or https://');
        }
        next.tts.cloud.baseUrl = v.replace(/\/+$/, ''); // strip trailing slashes
      }
      // An OpenAI-compatible TTS server has no canonical endpoint — refuse to
      // save the provider without one. Mirrors the LLM-side check below.
      if (next.tts.cloud.provider === 'openai-compatible' && !next.tts.cloud.baseUrl) {
        throw new Error('tts.cloud.baseUrl is required when provider is "openai-compatible"');
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
    if (l.ollamaUrl !== undefined) {
      const v = String(l.ollamaUrl).trim();
      if (v.length > 200) throw new Error('llm.ollamaUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('llm.ollamaUrl must start with http:// or https://');
      }
      next.llm.ollamaUrl = v.replace(/\/+$/, ''); // strip trailing slashes
    }
    if (l.baseUrl !== undefined) {
      const v = String(l.baseUrl).trim();
      if (v.length > 200) throw new Error('llm.baseUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('llm.baseUrl must start with http:// or https://');
      }
      next.llm.baseUrl = v.replace(/\/+$/, ''); // strip trailing slashes
    }
    if (l.reasoning !== undefined) {
      next.llm.reasoning = !!l.reasoning;
    }
    if (l.pickerAgent !== undefined) {
      next.llm.pickerAgent = !!l.pickerAgent;
    }
    if (l.pauseWhenEmpty !== undefined) {
      next.llm.pauseWhenEmpty = !!l.pauseWhenEmpty;
    }
    // An OpenAI-compatible provider is useless without a server to talk to.
    if (next.llm.provider === 'openai-compatible' && !next.llm.baseUrl) {
      throw new Error('llm.baseUrl is required when provider is "openai-compatible"');
    }
  }
  if ('search' in patch) {
    const sr = patch.search || {};
    if (sr.provider !== undefined) {
      if (!SEARCH_PROVIDERS.includes(sr.provider)) {
        throw new Error(`search.provider must be one of: ${SEARCH_PROVIDERS.join(', ')}`);
      }
      next.search.provider = sr.provider;
    }
    // 'set' is the redaction sentinel from getRedacted() — ignore it so a
    // round-tripped form doesn't overwrite the real key.
    if (sr.apiKey !== undefined && sr.apiKey !== 'set') {
      const v = String(sr.apiKey);
      if (v.length > 200) throw new Error('search.apiKey must be 0-200 chars');
      next.search.apiKey = v;
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
  if ('sfx' in patch) {
    const sx = patch.sfx || {};
    if (sx.enabled !== undefined) {
      next.sfx.enabled = !!sx.enabled;
    }
  }
  if ('webhooks' in patch) {
    next.webhooks = validateWebhooksStrict(patch.webhooks, next.webhooks || []);
  }
  if ('scrobble' in patch) {
    const sb = patch.scrobble || {};
    if (sb.lastfm !== undefined) {
      const lf = sb.lastfm || {};
      if (lf.enabled !== undefined) next.scrobble.lastfm.enabled = !!lf.enabled;
      if (lf.username !== undefined) {
        const v = String(lf.username ?? '').trim();
        if (v.length > 40) throw new Error('scrobble.lastfm.username must be 0-40 chars');
        next.scrobble.lastfm.username = v;
      }
      // 'set' is the redaction sentinel from getRedacted() — ignore it so a
      // round-tripped form doesn't overwrite the stored secret.
      for (const k of ['apiKey', 'apiSecret', 'sessionKey'] as const) {
        if (lf[k] !== undefined && lf[k] !== 'set') {
          const v = String(lf[k] ?? '').trim();
          if (v.length > 200) throw new Error(`scrobble.lastfm.${k} must be 0-200 chars`);
          next.scrobble.lastfm[k] = v;
        }
      }
    }
    if (sb.listenbrainz !== undefined) {
      const lb = sb.listenbrainz || {};
      if (lb.enabled !== undefined) next.scrobble.listenbrainz.enabled = !!lb.enabled;
      if (lb.username !== undefined) {
        const v = String(lb.username ?? '').trim();
        if (v.length > 40) throw new Error('scrobble.listenbrainz.username must be 0-40 chars');
        next.scrobble.listenbrainz.username = v;
      }
      if (lb.userToken !== undefined && lb.userToken !== 'set') {
        const v = String(lb.userToken ?? '').trim();
        if (v.length > 200) throw new Error('scrobble.listenbrainz.userToken must be 0-200 chars');
        next.scrobble.listenbrainz.userToken = v;
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
export function getEffectivePersona(date: Date = new Date()) {
  const s: any = get();
  const show: any = resolveActiveShow(date, s);
  if (show?.persona?.id) {
    const p = s.personas?.find((x: any) => x.id === show.persona!.id);
    if (p) return p;
  }
  return getActivePersona();
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location}. {name}/{soul} come from the supplied persona; the template is
// the global djPrompt (falling back to DEFAULT_DJ_PROMPT_TEMPLATE).
export function renderDjPrompt(persona: any, ctx: any = {}) {
  const station = ctx.station || cache?.station || DEFAULTS.station;
  const location = ctx.location || (cache?.weather?.locationName ?? DEFAULTS.weather.locationName);
  const tpl =
    cache?.djPrompt && cache.djPrompt.trim() ? cache.djPrompt : DEFAULT_DJ_PROMPT_TEMPLATE;
  const rendered = tpl
    .replaceAll('{name}', persona?.name || 'your host')
    .replaceAll('{soul}', persona?.soul || DJ_SOULS[0])
    .replaceAll('{station}', station)
    .replaceAll('{location}', location);
  return `${rendered}`;
}

// Persona prelude shared by every tool-loop agent system prompt — the picker
// and request agents in broadcast/dj-agent.js, and the segment director in
// skills/_agent.js. These agents build task-specific templates (with tools,
// schemas, and JSON shapes the legacy generateXxx prompts don't need), so they
// can't go through renderDjPrompt — but they still need the same persona
// opener everywhere. Paste this at the top of any new agent system prompt;
// never hand-roll the opener.
//
// `rules` is OPT-IN, defaulting to true. Pass `false` for tool-loop agents
// whose primary task is structured exploration + strict JSON output (the
// track picker and the request agent): the ~600-char humanness block at the
// top of the prompt competes for the model's attention with the tool-loop
// instructions and reliably derails small cloud models — they read "sound
// like a person talking" and emit conversational prose instead of executing
// the tool loop. The rules belong on agents whose primary task IS spoken
// output (the segment director), not on agents whose primary task is
// orchestration with an incidental spoken side-channel.
export function agentPersonaPreamble(persona, { rules = true } = {}) {
  const name = persona?.name || 'the DJ';
  const soul = persona?.soul || '';
  const station = cache?.station || DEFAULTS.station;
  const opener = `You are ${name}, the on-air DJ for ${station}, a personal internet radio station. ${soul}`;
  return rules ? `${opener}` : opener;
}

// Liquidsoap reads two tiny text files instead of JSON.
const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;

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
