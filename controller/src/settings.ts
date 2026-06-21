// Durable settings — overrides for values that have static defaults in code.
// Stored at <stateDir>/settings.json. Some apply live (weather location,
// DJ personas, shows); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).

import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { STATE_DIR } from './config.js';
import { DEFAULT_THEME_ID, isValidThemeId, listThemes } from './themes.js';
import { isValidTimezone, setStationTimezone, zonedParts } from './time.js';

// Where uploaded persona avatars live. One file per persona, basename =
// `<personaId>.<ext>`. The dedicated upload route is the only writer; the
// post-update orphan sweep below is the only place that deletes by id.
export const PERSONA_AVATAR_DIR = `${STATE_DIR}/persona-avatars`;

const SETTINGS_PATH = `${STATE_DIR}/settings.json`;
// `shows` (reusable show definitions) and `schedule` (the 7×24 grid) live in
// their own file so settings.json stays readable — a fresh schedule is 168
// null cells. They're conceptually one feature (the show planner) and are
// always loaded/saved together, so they share one file. On first load after
// upgrade, load() migrates them out of settings.json into here.
const SCHEDULE_PATH = `${STATE_DIR}/schedule.json`;

// Default DJ system-prompt template. Placeholders are substituted at LLM
// call time via renderDjPrompt(). Keep {name} mandatory — update() refuses
// any custom template that drops it, so dialogue can never become anonymous.
export const DEFAULT_DJ_PROMPT_TEMPLATE = `You are {name}, the on-air DJ for {station}, a personal radio station broadcasting from a homelab in {location}. {soul}.

Hard rules:
- Output ONLY the words to be spoken aloud. No stage directions, no asterisks, no quotes around your dialogue.
- Keep it to 2-4 sentences unless asked for longer.
- Never use radio-cliché tells: "and now", "next up", "coming up next", "and that was", or back-announcing with "that was [song] by [artist]". Be more natural.
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

// Ordered ascending in chattiness — effectiveFrequency() steps up this ladder.
export const FREQUENCIES = ['quiet', 'moderate', 'aggressive'];

// Per-persona verbosity. 'concise' is the historical one-liner behaviour;
// 'extended' roughly doubles every spoken segment for a storytelling DJ.
// See llm/dj.js LENGTH_PHRASES for the actual length directives.
export const SCRIPT_LENGTHS = ['concise', 'extended'];

// Per-persona tone dials. Each is 0-10 with 5 (DIAL_NEUTRAL) the default. A
// model can't distinguish humour=6 from 7, so rather than inject a raw "7/10"
// the dial maps to three bands: 0-3 low, 7-10 high, 4-6 neutral. Only a band
// away from neutral appends a style directive (personaToneDirectives below), so
// a persona left at the defaults renders a byte-identical prompt to before.
export const TONE_DIALS = ['humour', 'localColour', 'warmth'] as const;
export const DIAL_NEUTRAL = 5;

const TONE_DIAL_PHRASES: Record<string, { low: string; high: string }> = {
  humour: {
    low: 'Play it straight; keep any wit rare and understated.',
    high: 'Lean into dry, playful wit; an aside or a wink is welcome.',
  },
  localColour: {
    low: 'Keep it universal; skip local references and place-specific colour.',
    high: 'Lean on the local setting (the town, the weather, the hour) as texture.',
  },
  warmth: {
    low: 'Keep a cool, dry distance; let the music carry the warmth.',
    high: 'Be warm and earnest; speak to the listener like a friend.',
  },
};

// Clamp any input to an integer 0-10, defaulting to neutral when unparseable.
// The single chokepoint used by both normalizePersona and the seed roster.
export function normalizeDial(v: any): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : DIAL_NEUTRAL;
}

// Pure: persona in, prompt fragment out. Returns '' when every dial sits in the
// neutral band, so renderDjPrompt appends nothing and the default prompt is
// unchanged. Unit-pinned in controller/scripts/llm-pure.test.ts.
export function personaToneDirectives(persona: any): string {
  if (!persona || typeof persona !== 'object') return '';
  const lines: string[] = [];
  for (const key of TONE_DIALS) {
    const v = Number((persona as any)[key]);
    if (!Number.isFinite(v)) continue;
    if (v <= 3) lines.push(TONE_DIAL_PHRASES[key].low);
    else if (v >= 7) lines.push(TONE_DIAL_PHRASES[key].high);
  }
  return lines.length ? `\n\nTone:\n- ${lines.join('\n- ')}` : '';
}

// DJ mode makes a persona behave like a working radio DJ rather than a
// between-track narrator: it back-announces AND teases what's next, runs
// threads/callbacks across the session (paired with the cross-hour memory in
// broadcast/session.ts), and is generally more present. The "more present"
// part is expressed here as a one-rung bump up the FREQUENCIES ladder, reused
// by ident cadence (broadcast/dj-gate.ts), between-track segment floors
// (skills/_agent.ts), and auto-link spacing (broadcast/queue.ts). A persona
// with djMode off returns its base frequency unchanged, so a default station
// behaves exactly as before.
export function effectiveFrequency(persona: any = getEffectivePersona()) {
  const base = FREQUENCIES.includes(persona?.frequency) ? persona.frequency : 'moderate';
  if (!persona?.djMode) return base;
  const i = FREQUENCIES.indexOf(base);
  return FREQUENCIES[Math.min(i + 1, FREQUENCIES.length - 1)];
}

// TTS engines. Every spoken segment is voiced by the on-air persona's own
// `tts` config (see audio/tts.js); only jingle rendering falls back to the
// global defaultEngine.
//
// `cloud` routes through the AI SDK (OpenAI / ElevenLabs speech models) —
// see llm/speech.js. `piper`, `kokoro`, `chatterbox`, and `pocket-tts` are
// local engines. Chatterbox and PocketTTS are opt-in — the default controller
// image doesn't bundle either; build the image with `--build-arg WITH_CHATTERBOX=1`
// or `--build-arg WITH_POCKETTTS=1` (see docker/Dockerfile.controller) to
// include the runtime. The dispatcher gates each engine on isAvailable() so
// settings can reference it safely even when the runtime is absent (the
// engine just falls back to Piper).
export const TTS_ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud'];

// DJ-voice level trim, in dB. A per-engine gain levels the loudness gap between
// TTS engines (only PocketTTS self-normalises today, so it sits quieter than
// raw Piper/Kokoro under the same fixed-threshold mic compressor); a per-persona
// gain stacks on top as a character trim. Applied via Liquidsoap's `liq_amplify`
// annotation on say.txt/intro.txt (see audio/tts.ts:voiceGainDb +
// broadcast/queue.ts) — the same mechanism the music loudness path uses. A
// manual dial, not auto-normalisation, so the range is generous (±12 dB).
export const TTS_GAIN_CLAMP_DB = 12;

// Coerce any value to a clean gain: finite number, clamped to ±TTS_GAIN_CLAMP_DB,
// rounded to 0.1 dB (finer is inaudible and just bloats the annotate string).
// Garbage / non-finite → 0 (unity, i.e. today's behaviour).
export function clampTtsGain(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(-TTS_GAIN_CLAMP_DB, Math.min(TTS_GAIN_CLAMP_DB, n));
  return Math.round(c * 10) / 10;
}

// Normalise a per-engine gain map to exactly one clean gain per known engine
// (default 0). Drops unknown keys so a hand-edited settings.json can't smuggle
// arbitrary keys into the annotate path.
function normalizeTtsGainMap(raw: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of TTS_ENGINES) out[e] = clampTtsGain(raw?.[e]);
  return out;
}

// LLM provider abstraction. `ollama` is the homelab default; the cloud
// providers are opt-in and resolved by llm/provider.js. `openrouter` and
// `gateway` are aggregators — one key, any vendor's models. `openai-compatible`
// targets any self-hosted OpenAI-compatible server (llama.cpp, vLLM, LM Studio,
// etc.) via the operator-supplied `llm.baseUrl`. `locca` is a first-class local
// llama.cpp via the locca CLI — same transport as openai-compatible but with a
// host default base URL (host.docker.internal:8080) and onboarding discovery.
export const LLM_PROVIDERS = [
  'ollama',
  'openai-compatible',
  'locca',
  'openrouter',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'gateway',
];

// Subset of LLM_PROVIDERS that can actually produce text embeddings — the
// library tagger embeds every track (music/embeddings.ts), and several chat
// providers route chat ONLY: openrouter, deepseek and the Vercel AI gateway
// have no embeddings endpoint. Offering them in the embedding-provider picker
// silently fell through to a local Ollama and failed with a misleading
// "can't reach <provider>" error (#493). `anthropic` stays in — it has no
// first-party embedding model, but llm/internal/provider/embedding.ts routes it
// to OpenAI (needs OPENAI_API_KEY), as the picker hint already explains.
export const EMBEDDING_PROVIDERS = [
  'ollama',
  'openai-compatible',
  'locca',
  'anthropic',
  'openai',
  'google',
];

// Coerce a stored Ollama context-window value. 0 disables (use Ollama's own
// default); any other number is clamped to a sane [2048, 131072] band and
// floored to an integer. Non-numeric/NaN falls back to `def`. Shared by the
// primary and fallback LLM legs so the rule can't drift between them.
function clampNumCtx(raw: any, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  if (raw <= 0) return 0;
  return Math.min(131072, Math.max(2048, Math.floor(raw)));
}

// Coerce a stored agent-deadline value (ms). Clamped to [5s, 180s] and floored
// to an integer; non-numeric/NaN falls back to `def`. The lower bound keeps a
// fat-fingered save from making every agent pick fail instantly; the upper
// bound keeps a stalling model from tying up an inference slot for minutes.
function clampAgentTimeout(raw: any, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(180_000, Math.max(5_000, Math.floor(raw)));
}

// Validate + apply the connection fields shared by the primary LLM leg and its
// optional fallback (provider/model/apiKey/ollamaUrl/baseUrl/reasoning/numCtx).
// `target` is the live settings sub-object to mutate; `patch` is the incoming
// partial; `label` prefixes error messages ('llm' or 'llm.fallback'). The
// "openai-compatible needs baseUrl" rule is left to the caller — the fallback
// only enforces it when enabled. Station-level toggles (pickerAgent,
// pauseWhenEmpty) are primary-only and handled at the call site.
function applyLlmLegPatch(target: any, patch: any, label: string): void {
  const l = patch || {};
  if (l.provider !== undefined) {
    if (!LLM_PROVIDERS.includes(l.provider)) {
      throw new Error(`${label}.provider must be one of: ${LLM_PROVIDERS.join(', ')}`);
    }
    target.provider = l.provider;
  }
  if (l.model !== undefined) {
    const v = String(l.model).trim();
    if (v.length > 100) throw new Error(`${label}.model must be 0-100 chars`);
    target.model = v;
  }
  // 'set' is the redaction sentinel from getRedacted() — ignore it so a
  // round-tripped settings form doesn't overwrite the real key.
  if (l.apiKey !== undefined && l.apiKey !== 'set') {
    target.apiKey = String(l.apiKey);
  }
  if (l.ollamaUrl !== undefined) {
    const v = String(l.ollamaUrl).trim();
    if (v.length > 200) throw new Error(`${label}.ollamaUrl must be 0-200 chars`);
    if (v && !/^https?:\/\//i.test(v)) {
      throw new Error(`${label}.ollamaUrl must start with http:// or https://`);
    }
    target.ollamaUrl = v.replace(/\/+$/, ''); // strip trailing slashes
  }
  if (l.baseUrl !== undefined) {
    const v = String(l.baseUrl).trim();
    if (v.length > 200) throw new Error(`${label}.baseUrl must be 0-200 chars`);
    if (v && !/^https?:\/\//i.test(v)) {
      throw new Error(`${label}.baseUrl must start with http:// or https://`);
    }
    target.baseUrl = v.replace(/\/+$/, ''); // strip trailing slashes
  }
  if (l.reasoning !== undefined) {
    target.reasoning = !!l.reasoning;
  }
  if (l.numCtx !== undefined) {
    target.numCtx = clampNumCtx(Number(l.numCtx), target.numCtx);
  }
}

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

// Energy bands a show can pin as a soft music-steering filter. Mirrors the
// tagger's per-track energy classes and the `tracksByMood` agent-tool filter.
export const SHOW_ENERGY = ['low', 'medium', 'high'];

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
// PocketTTS built-in voices — the curated set the admin UI offers. Issue #213
// also surfaced zero-shot cloning, so `tts.voice` for pocket-tts may now be
// either an entry from this list (or another id passing POCKET_TTS_VOICE_RE)
// OR a `.wav` filename in the shared voice folder (CHATTERBOX_VOICE_RE shape,
// see controller/src/audio/pocketTts.ts).
export const POCKET_TTS_VOICES = [
  { id: 'alba', label: 'Alba (EN, F)' },
  { id: 'anna', label: 'Anna (EN, F)' },
  { id: 'charles', label: 'Charles (EN, M)' },
  { id: 'estelle', label: 'Estelle (FR, F)' },
  { id: 'giovanni', label: 'Giovanni (IT, M)' },
  { id: 'juergen', label: 'Juergen (DE, M)' },
  { id: 'lola', label: 'Lola (ES, F)' },
  { id: 'rafael', label: 'Rafael (PT, M)' },
];
const POCKET_TTS_VOICE_RE = /^[a-z][a-z0-9_-]{0,39}$/;
// Reference-WAV filenames live in the shared voice folder (config.voices.dir,
// formerly config.chatterbox.voiceDir). Loose check — basename only, no path
// separators, conservative character set, ends in .wav. Empty is also valid
// (means "use the built-in default voice"). Used by both chatterbox and
// pocket-tts since issue #213.
const CHATTERBOX_VOICE_RE = /^[A-Za-z0-9_.-]{1,80}\.wav$/;
// Per-persona Piper voice — an `.onnx` model filename in the shared voice folder
// (config.voices.dir), e.g. `en_US-amy-medium.onnx`, dropped alongside its
// `.onnx.json` manifest. Basename only, no path separators. Empty is valid and
// means "use the baked-in default voice" (issue #230).
const PIPER_VOICE_RE = /^[A-Za-z0-9_.-]{1,100}\.onnx$/;
const ID_RE = /^[a-z0-9_]{3,32}$/;
// Persona avatar filename — `<personaId>.(png|jpg|jpeg|webp)`. The id segment
// reuses ID_RE's shape so an avatar field can never reference a basename
// outside the persona-avatars directory. Empty is also valid (no avatar set).
export const AVATAR_FILENAME_RE = /^[a-z0-9_]{3,32}\.(png|jpe?g|webp)$/;
export const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
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
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

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
    language: '',
    avatar: '',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0 },
  },
  {
    id: 'p_default1',
    name: 'Wren',
    tagline: 'Small details, quiet rooms, one good image.',
    frequency: 'quiet',
    scriptLength: 'concise',
    soul: DJ_SOULS[1],
    language: '',
    avatar: '',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_alice', gainDb: 0 },
  },
  {
    id: 'p_default2',
    name: 'Hale',
    tagline: 'Says less, means more. Leaves space.',
    frequency: 'moderate',
    scriptLength: 'concise',
    soul: DJ_SOULS[3],
    language: '',
    avatar: '',
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_daniel', gainDb: 0 },
  },
];

// Allowed archive bitrates. Matches the literal branches in radio.liq —
// %mp3(bitrate=…) needs a parse-time int, so the encoder is pre-baked for
// this small set. Add a branch in radio.liq if you add a value here.
export const ARCHIVE_BITRATES = [64, 96, 128, 160, 192, 320] as const;

const DEFAULTS = {
  jingleRatio: 30, // 1 jingle per N music tracks
  crossfadeDuration: 10.0, // seconds
  // Hourly archive output. Enabled by default to preserve existing behaviour.
  // The second MP3 encoder is the largest constant CPU cost in the broadcast
  // container — operators who don't use the archives can switch this off to
  // reclaim that headroom (issue #137). Dropping the bitrate (e.g. 128 → 64
  // mono in a future change) also helps for operators who want the tape.
  archive: { enabled: true, bitrate: 128 },
  // Secondary Ogg-Opus broadcast mount (/stream.opus). Off by default — only
  // Blink (Chrome/Edge) clients ever select it (web/hooks/usePlayer.ts keeps
  // Safari/iOS/Firefox on MP3), and it adds a continuous Opus encoder + a
  // 44.1→48k resample, so operators opt in rather than pay that CPU unasked.
  // The mandatory /stream.mp3 mount always serves everyone.
  stream: { opusEnabled: false },
  weather: { lat: 30.7333, lng: 76.7794, locationName: 'Punjab', units: 'metric' as 'metric' | 'imperial' },
  // Operator-facing station name. Substituted into the DJ prompt's {station}
  // placeholder and returned by GET /dj for the landing page. The product is
  // still called SUB/WAVE — this is what the operator's station running on it
  // is called (e.g. "Frequency 88", "Late Shift Radio").
  station: 'SUB/WAVE',
  // Station clock — IANA zone driving everything with local-time semantics
  // (time-of-day moods, schedule slots, hourly time checks, festival dates).
  // Empty = Auto: the container's own TZ, so existing installs are untouched.
  // Applied live via time.ts setStationTimezone(); no restart.
  timezone: '',
  // Operator-facing locale for display copy/time formatting. Defaults to the
  // existing UK English + 24-hour clock behaviour; en-US switches visible
  // clocks to AM/PM without changing schedule/time-of-day semantics.
  locale: 'en-GB' as 'en-GB' | 'en-US',
  // Station-wide visual theme — every listener and the admin UI render with
  // this palette. The id resolves through controller/src/themes.ts, which
  // ships the built-ins and reads optional user JSONs from
  // ${STATE_DIR}/themes/. Stored as id only; the actual token map lives with
  // the theme registry so it stays in sync with the file on disk.
  theme: { active: DEFAULT_THEME_ID },
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
    // Advisory flag — does the operator intend to run the optional tts-heavy
    // sidecar (Chatterbox + PocketTTS)? Both setup wizards (CLI + /onboarding)
    // write to this so each surface knows the other's choice. Nothing in the
    // controller branches on it — engine availability is still read from
    // chatterbox.isAvailable() / pocketTts.isAvailable() at call time, which
    // is the source of truth. This is purely for the UI to show consistent
    // state and for the CLI to know whether to write COMPOSE_PROFILES.
    heavyEnabled: false,
    kokoro: { voice: 'bf_isabella' },
    // Global Chatterbox fallback — used as the reference voice when the
    // engine resolves to chatterbox but no persona-level voice is set.
    // Empty filename means "use the model's built-in default voice".
    chatterbox: { referenceVoice: '' },
    // Global PocketTTS default voice — used when the engine resolves to
    // pocket-tts but no persona-level voice is set. Built-in voice id.
    pocketTts: { voice: 'alba' },
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
    // Per-engine voice level trim (dB), applied via Liquidsoap's liq_amplify on
    // every spoken segment that resolves to that engine. Levels the loudness gap
    // between engines (e.g. boost PocketTTS to match raw Piper). Stacks with each
    // persona's own tts.gainDb. All 0 = unity = today's behaviour. See
    // TTS_GAIN_CLAMP_DB and audio/tts.ts:voiceGainDb().
    gainDb: { piper: 0, kokoro: 0, chatterbox: 0, 'pocket-tts': 0, cloud: 0 },
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
    // Ollama context window (num_ctx), local Ollama only. Ollama's own default
    // is 4096, but the session DJ agent feeds ~8k+ (the 40-turn session window
    // + tool schemas + discovery results), so the default silently truncates
    // the front of the prompt — dropping the system instructions and tool
    // defs — and the model never calls `done` ("agent did not call the done
    // tool", issue #291). 16384 holds a full picker turn comfortably on a 7–9B
    // model / 12GB GPU. Reasoning models burn more of it on <think>, so bump it
    // if you run those. Ignored for `:cloud` models and every other provider
    // (they manage their own context). 0 → don't send num_ctx (Ollama default).
    numCtx: 16384,
    // When on, the session DJ agent drives track-picking, links and listener
    // requests as a tool-loop over the session chat history (broadcast/
    // dj-agent.js). When off, the stateless pool picker runs instead — still
    // inside a session, still logged, just without the conversational loop.
    pickerAgent: true,
    // When on, the listener-request agent (djAgentRequest only — never the
    // per-track picker) gets an extra `identifyRequestedTrack` tool that resolves
    // a DESCRIBED track ("the song from the new Dune movie") via web search, then
    // matches it against the local library. Off by default: it needs a web-search
    // provider (settings.search) and costs a web round-trip + a small extraction
    // call per use. No-op unless searchReady() — see llm/internal/tools/picker-tools.ts.
    requestWebResolve: false,
    // Hard wall-clock ceiling (ms) on a single DJ-agent generation (track
    // picks and listener requests). Enforced by withDeadline in llm/sdk.ts;
    // the main and recovery runs each get the full budget, so worst case per
    // pick is ~2× this before the stateless fallback takes over. Raise it for
    // slow models (reasoning-heavy cloud models routinely need 20-40s per
    // pick); lower it if you want snappier fallbacks.
    agentTimeoutMs: 45000,
    // When on, autonomous DJ LLM work (track picks, links, station IDs,
    // hourly checks, segments) and listener requests pause whenever Icecast
    // reports zero listeners — the stream coasts on the auto playlist — and
    // resume as soon as someone tunes in. Off by default.
    pauseWhenEmpty: false,
    // Optional backup LLM. When `enabled`, any LLM call whose primary host is
    // unreachable (connection refused / DNS / timeout — NOT a 429/5xx from a
    // host that's up) is retried once against this leg, then routed straight
    // back to the primary on the next call (stateless fail-back). Built for the
    // "primary is a GPU box that's sometimes powered off, backup is the
    // always-on server running a smaller model" case (discussion #320). Same
    // connection fields as the primary; the station-level toggles (pickerAgent,
    // pauseWhenEmpty) are not per-leg. Heavy work (library tagging via
    // embeddings) does NOT fail over — it stays on the primary.
    fallback: {
      enabled: false,
      provider: 'ollama',
      model: '',
      apiKey: '',
      ollamaUrl: '',
      baseUrl: '',
      reasoning: false,
      numCtx: 16384,
    },
  },
  // Embedding-propagated library tagger (music/tag-library.ts).
  //
  // The tagger embeds every track's metadata text once (free if Ollama-local,
  // ~$1 for 50k via OpenAI), LLM-tags a small representative seed set, then
  // KNN-propagates moods/energy to the rest. Cuts LLM call count ~10x vs.
  // brute-force batched tagging.
  //
  // `provider` and `model` default to following settings.llm; set them here
  // to use a different provider for embeddings than for chat. Anthropic has
  // no first-party embedding API — Anthropic users either set a different
  // embedding provider or set OPENAI_API_KEY for the embedding leg.
  embedding: {
    enabled: true,
    provider: '',         // empty → follow settings.llm.provider
    model: '',            // empty → sensible default per provider
    // Embeddings often need a DIFFERENT endpoint than chat: one llama.cpp /
    // locca server can't serve both chat and embeddings, so a dedicated
    // embedding server runs on its own port. Empty → inherit settings.llm's
    // baseUrl / ollamaUrl (fine only when the chat server also does embeddings,
    // e.g. Ollama). See issue #405.
    baseUrl: '',          // openai-compatible / locca embedding server URL (with /v1)
    ollamaUrl: '',        // Ollama embedding server URL (ollama provider)
    seedCount: 0,         // 0 → auto max(200, ceil(sqrt(library)))
    knnNeighbours: 5,
    moodVoteThreshold: 0.6,
    confidenceThreshold: 0.6,
    maxActiveLearningRounds: 3,
    enrichment: {
      // Vanilla Navidrome's getArtistInfo2 doesn't surface Last.fm crowd
      // tags (the agent only exposes bio + images). Until SUB/WAVE adds a
      // direct Last.fm API path, leave this off — enabling it just wastes
      // an HTTP round trip per artist with empty results. Operators
      // running a custom Navidrome that does expose tag[] can flip it on.
      lastfmTags: false,
      lyrics: true,       // fetch + include lyric excerpt in embed text
    },
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
  // Audio (CLAP) "sounds-like" embeddings — drive the audio-similar picker
  // source, the tracksThatSoundLikeThis tool and sonic journeys. When on, the
  // analysis pass asks the backend for an embedding per track; the backend
  // needs the CLAP stack (tts-heavy built with WITH_CLAP=1, or a local venv
  // with torch+transformers) — without it the request is a clean no-op and
  // the pass still fills bpm/key. ANALYZE_AUDIO_EMBEDDING=1 in the env also
  // enables it regardless of this toggle (env wins on, never off).
  audio: {
    embeddings: false,
    // Demucs vocal-activity ranges — drives content-aware talk timing and a
    // vocal-absence intro detector. When on, the analysis pass asks the backend
    // for vocal ranges per track; the backend needs the demucs stack (tts-heavy
    // built WITH_DEMUCS=1, or a local venv with torch+demucs) — without it the
    // request is a clean no-op. ANALYZE_VOCAL_ACTIVITY=1 also enables it
    // regardless of this toggle (env wins on, never off). Expensive — opt-in.
    vocalActivity: false,
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

const ARCHIVE_BITRATE_SET = new Set<number>(ARCHIVE_BITRATES);

let cache: any = null;

// ── normalizers (lenient — used by load(), clamp/default rather than throw) ──

// Persona skill assignment. `null` (raw not an array) is the "all skills"
// sentinel — used by legacy personas and the code default so behaviour is
// unchanged until the operator explicitly picks a subset. An empty array
// means "this persona runs no skills".
//
// Legacy migrations: `random-facts` is rewritten to `curiosity` (the merged
// successor capability that absorbed the old prompt-only "did you know" line
// plus Wikipedia on-this-day). Persona ownership lists predate this rename,
// so without rewriting them, every upgraded operator would silently lose the
// capability the moment they reload settings.
const SKILL_RENAMES: Record<string, string> = {
  'random-facts': 'curiosity',
};
function normalizeSkills(raw: any) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const v = SKILL_RENAMES[item.trim()] || item.trim();
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
  // PocketTTS accepts a built-in voice id (alba, anna, …) OR a .wav filename
  // in the shared voice folder for zero-shot cloning (issue #213). Anything
  // that matches neither shape resets to the default; the worker also guards
  // against unknown ids, but normalising here keeps the persisted form clean.
  if (
    engine === 'pocket-tts'
    && (!voice
      || (!POCKET_TTS_VOICE_RE.test(voice) && !CHATTERBOX_VOICE_RE.test(voice)))
  ) {
    voice = 'alba';
  }
  // Piper voices are `.onnx` filenames in the shared voice folder (issue #230).
  // Empty is legitimate ("use the baked-in default voice"); invalid filenames
  // reset to empty. A Kokoro-shaped id is preserved, not wiped: the seed roster
  // carries one per persona under piper so switching to Kokoro yields distinct
  // voices without re-editing, and resolvePiperVoice() falls back gracefully for
  // it at render time. Wiping it here would silently break that on first reload
  // after a save (issue #454).
  if (engine === 'piper' && voice && !PIPER_VOICE_RE.test(voice) && !KOKORO_VOICE_RE.test(voice))
    voice = '';
  // openai-compatible voices are server-specific (often arbitrary cloning ref
  // names) — no canonical default; leave empty so generateSpeech omits the
  // field and the server picks its own.
  if (!voice && engine === 'cloud' && cloudProvider !== 'openai-compatible') voice = 'alloy';
  if (!voice && engine !== 'cloud' && engine !== 'chatterbox' && engine !== 'piper') voice = 'bf_isabella';
  return { engine, cloudProvider, voice, gainDb: clampTtsGain(raw?.gainDb) };
}

function normalizePersona(raw: any) {
  if (!raw || typeof raw !== 'object') return null;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  const soul = typeof raw.soul === 'string' ? raw.soul.trim().slice(0, 400) : '';
  if (!name || !soul) return null;
  // Avatar — stored as a bare basename. Reset to '' if the persisted value
  // doesn't match the strict basename shape, so a hand-edited settings.json
  // can never point /persona-avatar/:id at an arbitrary path.
  const rawAvatar = typeof raw.avatar === 'string' ? raw.avatar.trim() : '';
  const avatar = rawAvatar && AVATAR_FILENAME_RE.test(rawAvatar) ? rawAvatar : '';
  return {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : mintId('p_'),
    name,
    tagline: typeof raw.tagline === 'string' ? raw.tagline.trim().slice(0, 80) : '',
    frequency: FREQUENCIES.includes(raw.frequency) ? raw.frequency : 'moderate',
    scriptLength: SCRIPT_LENGTHS.includes(raw.scriptLength) ? raw.scriptLength : 'concise',
    djMode: raw.djMode === true,
    humour: normalizeDial(raw.humour),
    localColour: normalizeDial(raw.localColour),
    warmth: normalizeDial(raw.warmth),
    soul,
    language: typeof raw.language === 'string' ? raw.language.trim().slice(0, 60) : '',
    avatar,
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
    // themeId is the optional per-show theme override. Lenient path: we only
    // sanity-check the shape. A stale id (theme file deleted under our feet)
    // is harmless — routes/public.ts falls back to the station default at
    // serve time via getTheme()'s own fallback. Empty/missing means "no
    // override" and is stored as an empty string for round-trip cleanliness.
    const themeId =
      typeof item.themeId === 'string' && item.themeId.trim()
        ? item.themeId.trim().slice(0, 64)
        : '';
    // Optional music-steering filters (soft lean, applied at pick time). Genre
    // is stored as free text and resolved fuzzily against the live library when
    // a pick is made (mirrors the listener-request path) — never validated
    // against Subsonic here. fromYear/toYear are a decade window. energy is one
    // of the tagger's three bands. All default to "no constraint".
    const genre = typeof item.genre === 'string' ? item.genre.trim().slice(0, 64) : '';
    const fromYear = Number.isFinite(item.fromYear) ? Math.trunc(item.fromYear) : null;
    const toYear = Number.isFinite(item.toYear) ? Math.trunc(item.toYear) : null;
    const energy = SHOW_ENERGY.includes(item.energy) ? item.energy : '';
    out.push({
      id,
      name,
      topic: typeof item.topic === 'string' ? item.topic.trim().slice(0, 1000) : '',
      personaId: item.personaId,
      mood: item.mood,
      themeId,
      genre,
      fromYear,
      toYear,
      energy,
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

  // shows + schedule live in schedule.json. Migration: if schedule.json
  // exists, its contents win (and any leftover keys on settings.json are
  // ignored, to be stripped on the next write). If it doesn't exist, fall
  // back to whatever's on `stored` (legacy in-line copy from a pre-split
  // install) so normalizers below can promote it forward. update() always
  // writes settings.json without these keys, so the next save completes the
  // migration on disk.
  if (existsSync(SCHEDULE_PATH)) {
    try {
      const sched = JSON.parse(await readFile(SCHEDULE_PATH, 'utf8'));
      if (sched && typeof sched === 'object') {
        stored.shows = sched.shows;
        stored.schedule = sched.schedule;
      }
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

  const archiveBitrate =
    typeof stored.archive?.bitrate === 'number' && ARCHIVE_BITRATE_SET.has(stored.archive.bitrate)
      ? stored.archive.bitrate
      : DEFAULTS.archive.bitrate;

  cache = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    archive: {
      enabled:
        typeof stored.archive?.enabled === 'boolean'
          ? stored.archive.enabled
          : DEFAULTS.archive.enabled,
      bitrate: archiveBitrate,
    },
    stream: {
      opusEnabled:
        typeof stored.stream?.opusEnabled === 'boolean'
          ? stored.stream.opusEnabled
          : DEFAULTS.stream.opusEnabled,
    },
    weather: {
      lat: stored.weather?.lat ?? DEFAULTS.weather.lat,
      lng: stored.weather?.lng ?? DEFAULTS.weather.lng,
      locationName: stored.weather?.locationName ?? DEFAULTS.weather.locationName,
      units:
        stored.weather?.units === 'imperial' || stored.weather?.units === 'metric'
          ? stored.weather.units
          : DEFAULTS.weather.units,
    },
    djPrompt,
    station:
      typeof stored.station === 'string' && stored.station.trim()
        ? stored.station.trim().slice(0, 80)
        : DEFAULTS.station,
    // Invalid stored zone (hand-edited file) falls back to Auto — the
    // station must never crash on a bad zone.
    timezone:
      typeof stored.timezone === 'string' && isValidTimezone(stored.timezone.trim())
        ? stored.timezone.trim()
        : DEFAULTS.timezone,
    locale:
      stored.locale === 'en-US' || stored.locale === 'en-GB'
        ? stored.locale
        : DEFAULTS.locale,
    theme: {
      // We only validate the *shape* here. The active id might reference a
      // theme file that's since been removed; the public /themes endpoint
      // and getTheme() both fall back to the default id when that happens, so
      // a stale id doesn't break the UI.
      active:
        typeof stored.theme?.active === 'string' && stored.theme.active.trim()
          ? stored.theme.active.trim()
          : DEFAULTS.theme.active,
    },
    personas,
    activePersonaId,
    shows,
    schedule,
    tts: {
      defaultEngine: TTS_ENGINES.includes(stored.tts?.defaultEngine)
        ? stored.tts.defaultEngine
        : DEFAULTS.tts.defaultEngine,
      // Stored as a plain boolean; coerce missing/non-boolean (older saves) to
      // the default. See DEFAULTS.tts.heavyEnabled for the semantics.
      heavyEnabled:
        typeof stored.tts?.heavyEnabled === 'boolean'
          ? stored.tts.heavyEnabled
          : DEFAULTS.tts.heavyEnabled,
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
      pocketTts: {
        voice:
          typeof stored.tts?.pocketTts?.voice === 'string'
          && (POCKET_TTS_VOICE_RE.test(stored.tts.pocketTts.voice)
            || CHATTERBOX_VOICE_RE.test(stored.tts.pocketTts.voice))
            ? stored.tts.pocketTts.voice
            : DEFAULTS.tts.pocketTts.voice,
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
      // Per-engine gain map — one clean gain per known engine, missing keys → 0,
      // unknown keys dropped. So an older save (no gainDb) loads at unity.
      gainDb: normalizeTtsGainMap(stored.tts?.gainDb),
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
      // Clamp to a sane band: 0 disables (Ollama default), else [2048, 131072].
      // Non-numeric/NaN falls back to the default. Floored to an integer.
      numCtx: clampNumCtx(stored.llm?.numCtx, DEFAULTS.llm.numCtx),
      pickerAgent:
        typeof stored.llm?.pickerAgent === 'boolean'
          ? stored.llm.pickerAgent
          : DEFAULTS.llm.pickerAgent,
      requestWebResolve:
        typeof stored.llm?.requestWebResolve === 'boolean'
          ? stored.llm.requestWebResolve
          : DEFAULTS.llm.requestWebResolve,
      // Clamped to [5s, 180s]; settings.json files from before the field
      // existed pick up the default.
      agentTimeoutMs: clampAgentTimeout(stored.llm?.agentTimeoutMs, DEFAULTS.llm.agentTimeoutMs),
      pauseWhenEmpty:
        typeof stored.llm?.pauseWhenEmpty === 'boolean'
          ? stored.llm.pauseWhenEmpty
          : DEFAULTS.llm.pauseWhenEmpty,
      // Backup leg — same connection fields as the primary, coerced identically.
      fallback: (() => {
        const fb = stored.llm?.fallback || {};
        return {
          enabled: typeof fb.enabled === 'boolean' ? fb.enabled : DEFAULTS.llm.fallback.enabled,
          provider: LLM_PROVIDERS.includes(fb.provider)
            ? fb.provider
            : DEFAULTS.llm.fallback.provider,
          model: typeof fb.model === 'string' ? fb.model.trim() : DEFAULTS.llm.fallback.model,
          apiKey: typeof fb.apiKey === 'string' ? fb.apiKey : DEFAULTS.llm.fallback.apiKey,
          ollamaUrl:
            typeof fb.ollamaUrl === 'string' ? fb.ollamaUrl.trim() : DEFAULTS.llm.fallback.ollamaUrl,
          baseUrl:
            typeof fb.baseUrl === 'string' ? fb.baseUrl.trim() : DEFAULTS.llm.fallback.baseUrl,
          reasoning:
            typeof fb.reasoning === 'boolean' ? fb.reasoning : DEFAULTS.llm.fallback.reasoning,
          numCtx: clampNumCtx(fb.numCtx, DEFAULTS.llm.fallback.numCtx),
        };
      })(),
    },
    search: {
      provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
        ? stored.search.provider
        : DEFAULTS.search.provider,
      apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : '',
    },
    embedding: {
      enabled:
        typeof stored.embedding?.enabled === 'boolean'
          ? stored.embedding.enabled
          : DEFAULTS.embedding.enabled,
      provider:
        typeof stored.embedding?.provider === 'string'
          ? stored.embedding.provider.trim()
          : DEFAULTS.embedding.provider,
      model:
        typeof stored.embedding?.model === 'string'
          ? stored.embedding.model.trim()
          : DEFAULTS.embedding.model,
      baseUrl:
        typeof stored.embedding?.baseUrl === 'string'
          ? stored.embedding.baseUrl.trim()
          : DEFAULTS.embedding.baseUrl,
      ollamaUrl:
        typeof stored.embedding?.ollamaUrl === 'string'
          ? stored.embedding.ollamaUrl.trim()
          : DEFAULTS.embedding.ollamaUrl,
      seedCount:
        Number.isFinite(stored.embedding?.seedCount) && stored.embedding.seedCount >= 0
          ? Math.floor(stored.embedding.seedCount)
          : DEFAULTS.embedding.seedCount,
      knnNeighbours:
        Number.isFinite(stored.embedding?.knnNeighbours) && stored.embedding.knnNeighbours >= 1
          ? Math.floor(stored.embedding.knnNeighbours)
          : DEFAULTS.embedding.knnNeighbours,
      moodVoteThreshold:
        Number.isFinite(stored.embedding?.moodVoteThreshold)
          ? clamp01(stored.embedding.moodVoteThreshold)
          : DEFAULTS.embedding.moodVoteThreshold,
      confidenceThreshold:
        Number.isFinite(stored.embedding?.confidenceThreshold)
          ? clamp01(stored.embedding.confidenceThreshold)
          : DEFAULTS.embedding.confidenceThreshold,
      maxActiveLearningRounds:
        Number.isFinite(stored.embedding?.maxActiveLearningRounds)
        && stored.embedding.maxActiveLearningRounds >= 0
          ? Math.floor(stored.embedding.maxActiveLearningRounds)
          : DEFAULTS.embedding.maxActiveLearningRounds,
      enrichment: {
        lastfmTags:
          typeof stored.embedding?.enrichment?.lastfmTags === 'boolean'
            ? stored.embedding.enrichment.lastfmTags
            : DEFAULTS.embedding.enrichment.lastfmTags,
        lyrics:
          typeof stored.embedding?.enrichment?.lyrics === 'boolean'
            ? stored.embedding.enrichment.lyrics
            : DEFAULTS.embedding.enrichment.lyrics,
      },
    },
    skills: {
      enabled: Object.fromEntries(
        Object.entries(stored.skills?.enabled || {})
          .filter(([, v]) => typeof v === 'boolean')
          // Same rename applied to the operator's enable toggle map so an
          // existing `random-facts: false` carries forward as `curiosity: false`.
          .map(([k, v]) => [SKILL_RENAMES[k] || k, v]),
      ),
    },
    audio: {
      embeddings: typeof stored.audio?.embeddings === 'boolean' ? stored.audio.embeddings : DEFAULTS.audio.embeddings,
      vocalActivity: typeof stored.audio?.vocalActivity === 'boolean' ? stored.audio.vocalActivity : DEFAULTS.audio.vocalActivity,
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
  if (typeof stored.timezone === 'string' && stored.timezone.trim() && !cache.timezone) {
    console.warn(`[settings] ignoring invalid timezone "${stored.timezone.trim()}" — using Auto (container TZ)`);
  }
  setStationTimezone(cache.timezone);
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
  if (clone.llm?.fallback) clone.llm.fallback.apiKey = s.llm?.fallback?.apiKey ? 'set' : '';
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
  } else if (t.engine === 'pocket-tts') {
    // Two accepted forms (issue #213):
    //   - A built-in voice id (alba, anna, charles, …). Curated set lives in
    //     POCKET_TTS_VOICES; anything passing POCKET_TTS_VOICE_RE is also
    //     accepted (the worker falls back to the default for unknown ids).
    //   - A `.wav` filename in the shared voice folder → zero-shot cloning.
    //     Same shape as the chatterbox value.
    if (!voice) voice = 'alba';
    if (!POCKET_TTS_VOICE_RE.test(voice) && !CHATTERBOX_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for pocket-tts must be a built-in voice id (e.g. alba) or a .wav filename`,
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
    // piper: empty = use the baked-in default voice. Otherwise the value must
    // be an .onnx filename (no path separators) referencing a model the operator
    // dropped into the shared voice folder (issue #230). A Kokoro-shaped id is
    // also accepted: the seed roster carries a distinct Kokoro voice per persona
    // under the piper engine so switching to Kokoro yields different-sounding
    // DJs with no extra editing (see SEED_PERSONAS). resolvePiperVoice() falls
    // back to the default for it at render time, so it is harmless under piper
    // and must not block saving the shipped roster (issue #454).
    if (voice && !PIPER_VOICE_RE.test(voice) && !KOKORO_VOICE_RE.test(voice)) {
      throw new Error(
        `${where}.tts.voice for piper must be an .onnx filename (no path), or empty for the default voice`,
      );
    }
  }
  return { engine: t.engine, cloudProvider: t.cloudProvider, voice, gainDb: clampTtsGain(t.gainDb) };
}

export function validatePersonasStrict(raw) {
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
    // language — optional free text ("Turkish", "Türkçe", …). Absent/empty →
    // '' (English, no directive injected — the historical behaviour).
    let language = '';
    if (item.language !== undefined && item.language !== null) {
      if (typeof item.language !== 'string') {
        throw new Error(`personas[${i}].language must be a string`);
      }
      language = item.language.trim();
      if (language.length > 60) throw new Error(`personas[${i}].language must be 0-60 chars`);
    }
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
    // djMode — optional boolean. Absent → false (a plain narrator persona, the
    // historical behaviour). When true the persona behaves like a working DJ
    // (forward-tease, callbacks, more presence) — see effectiveFrequency above.
    let djMode = false;
    if (item.djMode !== undefined && item.djMode !== null) {
      if (typeof item.djMode !== 'boolean') {
        throw new Error(`personas[${i}].djMode must be a boolean`);
      }
      djMode = item.djMode;
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
    // Avatar — optional. Absent/empty → '' (no avatar). Present must be a
    // bare basename matching AVATAR_FILENAME_RE. The dedicated upload route
    // is the only writer that creates the file on disk; this validator just
    // checks the persisted string. The post-patch sweep below garbage-
    // collects orphaned files when the persona itself is removed.
    let avatar = '';
    if (item.avatar !== undefined && item.avatar !== null && item.avatar !== '') {
      const a = String(item.avatar).trim();
      if (!AVATAR_FILENAME_RE.test(a)) {
        throw new Error(
          `personas[${i}].avatar must be a basename like <id>.png|jpg|jpeg|webp`,
        );
      }
      avatar = a;
    }
    return {
      id,
      name,
      tagline,
      frequency: item.frequency,
      scriptLength,
      djMode,
      humour: normalizeDial(item.humour),
      localColour: normalizeDial(item.localColour),
      warmth: normalizeDial(item.warmth),
      soul,
      language,
      avatar,
      tts,
      skills,
    };
  });
}

function validateShowsStrict(raw, personas, allowedThemeIds: Set<string>) {
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
    // Optional per-show theme override. Empty/missing means "fall back to the
    // station default while this show is on air". The allow-set is built once
    // by update() so we stay sync here.
    let themeId = '';
    if (item.themeId !== undefined && item.themeId !== null && item.themeId !== '') {
      const v = String(item.themeId).trim();
      if (!allowedThemeIds.has(v)) {
        throw new Error(`shows[${i}].themeId "${v}" is not a known theme id`);
      }
      themeId = v;
    }
    // Optional music-steering filters — all default to "no constraint". Genre
    // is free text resolved fuzzily at pick time, so it isn't checked against
    // the live library here.
    const genre = String(item.genre ?? '').trim();
    if (genre.length > 64) throw new Error(`shows[${i}].genre must be 0-64 chars`);
    const energy = item.energy == null || item.energy === '' ? '' : String(item.energy);
    if (energy && !SHOW_ENERGY.includes(energy)) {
      throw new Error(`shows[${i}].energy must be one of: ${SHOW_ENERGY.join(', ')}`);
    }
    const parseYear = (v, field) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1900 || n > 2100) {
        throw new Error(`shows[${i}].${field} must be an integer between 1900 and 2100`);
      }
      return n;
    };
    const fromYear = parseYear(item.fromYear, 'fromYear');
    const toYear = parseYear(item.toYear, 'toYear');
    if (fromYear != null && toYear != null && fromYear > toYear) {
      throw new Error(`shows[${i}].fromYear must be <= toYear`);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    return { id, name, topic, personaId: item.personaId, mood: item.mood, themeId, genre, fromYear, toYear, energy };
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
  if ('archive' in patch) {
    const a = patch.archive || {};
    if (a.enabled !== undefined) {
      const v = !!a.enabled;
      if (v !== cur.archive.enabled) {
        next.archive.enabled = v;
        restart = true;
      }
    }
    if (a.bitrate !== undefined) {
      const v = parseInt(a.bitrate, 10);
      if (!Number.isFinite(v) || !ARCHIVE_BITRATE_SET.has(v)) {
        throw new Error(
          `archive.bitrate must be one of: ${ARCHIVE_BITRATES.join(', ')}`,
        );
      }
      if (v !== cur.archive.bitrate) {
        next.archive.bitrate = v;
        restart = true;
      }
    }
  }
  if ('stream' in patch) {
    const st = patch.stream || {};
    if (st.opusEnabled !== undefined) {
      const v = !!st.opusEnabled;
      if (v !== cur.stream.opusEnabled) {
        next.stream.opusEnabled = v;
        restart = true;
      }
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
    if (w.units !== undefined) {
      if (w.units !== 'metric' && w.units !== 'imperial') {
        throw new Error("weather.units must be 'metric' or 'imperial'");
      }
      next.weather.units = w.units;
    }
  }
  if ('station' in patch) {
    const v = String(patch.station ?? '').trim();
    if (v.length > 80) throw new Error('station name must be 80 chars or fewer');
    const resolved = v === '' ? DEFAULTS.station : v;
    if (resolved !== cur.station) {
      restart = true;
    }
    next.station = resolved;
  }
  if ('timezone' in patch) {
    const v = String(patch.timezone ?? '').trim();
    // '' = back to Auto (container TZ). Anything else must be a zone ICU
    // knows — aliases like Europe/Kiev validate, not just canonical names.
    if (v !== '' && !isValidTimezone(v)) {
      throw new Error(`invalid timezone "${v}" — use an IANA name like Europe/Athens`);
    }
    next.timezone = v;
  }
  if ('locale' in patch) {
    const v = String(patch.locale ?? '').trim();
    if (v !== 'en-GB' && v !== 'en-US') {
      throw new Error("locale must be 'en-GB' or 'en-US'");
    }
    next.locale = v;
  }
  if ('theme' in patch) {
    const t = patch.theme || {};
    if (t.active !== undefined) {
      const v = String(t.active ?? '').trim();
      if (!v) throw new Error('theme.active must be a theme id');
      if (!(await isValidThemeId(v))) {
        throw new Error(`theme.active "${v}" is not a known theme id`);
      }
      next.theme.active = v;
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
    // Snapshot the theme registry once so the validator can stay sync.
    // listThemes() returns built-ins + cached user themes (30 s TTL) — same
    // source the picker reads.
    const allowedThemeIds = new Set((await listThemes()).map(t => t.id));
    next.shows = validateShowsStrict(patch.shows, next.personas, allowedThemeIds);
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
    if (t.heavyEnabled !== undefined) {
      if (typeof t.heavyEnabled !== 'boolean') {
        throw new Error('tts.heavyEnabled must be a boolean');
      }
      next.tts.heavyEnabled = t.heavyEnabled;
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
    if (t.pocketTts !== undefined) {
      const pt = t.pocketTts || {};
      if (pt.voice !== undefined) {
        const v = String(pt.voice).trim();
        // Built-in id OR shared-folder .wav filename (issue #213).
        if (!POCKET_TTS_VOICE_RE.test(v) && !CHATTERBOX_VOICE_RE.test(v)) {
          throw new Error(
            'tts.pocketTts.voice must be a built-in voice id (e.g. alba) or a .wav filename',
          );
        }
        next.tts.pocketTts.voice = v;
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
    if (t.gainDb !== undefined) {
      if (typeof t.gainDb !== 'object' || t.gainDb === null || Array.isArray(t.gainDb)) {
        throw new Error('tts.gainDb must be an object keyed by engine');
      }
      for (const key of Object.keys(t.gainDb)) {
        if (!TTS_ENGINES.includes(key)) {
          throw new Error(`tts.gainDb has unknown engine "${key}"; must be one of: ${TTS_ENGINES.join(', ')}`);
        }
        next.tts.gainDb[key] = clampTtsGain(t.gainDb[key]);
      }
    }
  }
  if ('llm' in patch) {
    const l = patch.llm || {};
    applyLlmLegPatch(next.llm, l, 'llm');
    if (l.pickerAgent !== undefined) {
      next.llm.pickerAgent = !!l.pickerAgent;
    }
    if (l.requestWebResolve !== undefined) {
      next.llm.requestWebResolve = !!l.requestWebResolve;
    }
    if (l.agentTimeoutMs !== undefined) {
      next.llm.agentTimeoutMs = clampAgentTimeout(Number(l.agentTimeoutMs), next.llm.agentTimeoutMs);
    }
    if (l.pauseWhenEmpty !== undefined) {
      next.llm.pauseWhenEmpty = !!l.pauseWhenEmpty;
    }
    // An OpenAI-compatible provider is useless without a server to talk to.
    if (next.llm.provider === 'openai-compatible' && !next.llm.baseUrl) {
      throw new Error('llm.baseUrl is required when provider is "openai-compatible"');
    }
    // Backup leg — same connection fields, validated identically. The
    // openai-compatible-needs-baseUrl rule is enforced only when the fallback
    // is enabled, so a half-filled, disabled backup never blocks a save.
    if (l.fallback !== undefined) {
      const fb = l.fallback || {};
      if (fb.enabled !== undefined) {
        next.llm.fallback.enabled = !!fb.enabled;
      }
      applyLlmLegPatch(next.llm.fallback, fb, 'llm.fallback');
      if (
        next.llm.fallback.enabled &&
        next.llm.fallback.provider === 'openai-compatible' &&
        !next.llm.fallback.baseUrl
      ) {
        throw new Error(
          'llm.fallback.baseUrl is required when its provider is "openai-compatible"',
        );
      }
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
  if ('embedding' in patch) {
    const e = patch.embedding || {};
    if (e.enabled !== undefined) next.embedding.enabled = !!e.enabled;
    if (e.provider !== undefined) {
      const v = String(e.provider).trim();
      // Empty string is meaningful — it means "follow settings.llm.provider".
      if (v && !LLM_PROVIDERS.includes(v)) {
        throw new Error(
          `embedding.provider must be empty or one of: ${LLM_PROVIDERS.join(', ')}`,
        );
      }
      next.embedding.provider = v;
    }
    if (e.model !== undefined) {
      const v = String(e.model).trim();
      if (v.length > 100) throw new Error('embedding.model must be 0-100 chars');
      next.embedding.model = v;
    }
    // Dedicated embedding endpoint (issue #405). Empty → inherit settings.llm.
    if (e.baseUrl !== undefined) {
      const v = String(e.baseUrl).trim();
      if (v.length > 200) throw new Error('embedding.baseUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('embedding.baseUrl must start with http:// or https://');
      }
      next.embedding.baseUrl = v.replace(/\/+$/, ''); // strip trailing slashes
    }
    if (e.ollamaUrl !== undefined) {
      const v = String(e.ollamaUrl).trim();
      if (v.length > 200) throw new Error('embedding.ollamaUrl must be 0-200 chars');
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error('embedding.ollamaUrl must start with http:// or https://');
      }
      next.embedding.ollamaUrl = v.replace(/\/+$/, '');
    }
    if (e.seedCount !== undefined) {
      const v = parseInt(e.seedCount, 10);
      if (!Number.isFinite(v) || v < 0 || v > 50_000) {
        throw new Error('embedding.seedCount must be an integer 0-50000 (0 = auto)');
      }
      next.embedding.seedCount = v;
    }
    if (e.knnNeighbours !== undefined) {
      const v = parseInt(e.knnNeighbours, 10);
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        throw new Error('embedding.knnNeighbours must be an integer 1-50');
      }
      next.embedding.knnNeighbours = v;
    }
    if (e.moodVoteThreshold !== undefined) {
      const v = parseFloat(e.moodVoteThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.moodVoteThreshold must be between 0 and 1');
      }
      next.embedding.moodVoteThreshold = v;
    }
    if (e.confidenceThreshold !== undefined) {
      const v = parseFloat(e.confidenceThreshold);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.confidenceThreshold must be between 0 and 1');
      }
      next.embedding.confidenceThreshold = v;
    }
    if (e.maxActiveLearningRounds !== undefined) {
      const v = parseInt(e.maxActiveLearningRounds, 10);
      if (!Number.isFinite(v) || v < 0 || v > 10) {
        throw new Error('embedding.maxActiveLearningRounds must be an integer 0-10');
      }
      next.embedding.maxActiveLearningRounds = v;
    }
    if (e.enrichment !== undefined) {
      const en = e.enrichment || {};
      if (en.lastfmTags !== undefined) {
        next.embedding.enrichment.lastfmTags = !!en.lastfmTags;
      }
      if (en.lyrics !== undefined) {
        next.embedding.enrichment.lyrics = !!en.lyrics;
      }
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
  if ('audio' in patch) {
    const au = patch.audio || {};
    if (au.embeddings !== undefined) {
      next.audio.embeddings = !!au.embeddings;
    }
    if (au.vocalActivity !== undefined) {
      next.audio.vocalActivity = !!au.vocalActivity;
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

    // Garbage-collect avatar files for personas that no longer exist. Best
    // effort — a missing directory or a vanished file is fine, this just
    // keeps the on-disk state from accumulating dead images.
    const removedIds = (cur.personas || [])
      .map((p: any) => p.id)
      .filter((id: string) => !personaIds.includes(id));
    if (removedIds.length) {
      try {
        const entries = await readdir(PERSONA_AVATAR_DIR);
        await Promise.all(
          entries
            .filter(e => removedIds.some(id => e.startsWith(`${id}.`)))
            .map(e => unlink(`${PERSONA_AVATAR_DIR}/${e}`).catch(() => {})),
        );
      } catch {
        // Directory doesn't exist yet — nothing to clean.
      }
    }
  }

  cache = next;
  // Applied-on-save, same pattern as the liquidsoap_*.txt files below —
  // minus the restart: the next zonedParts() call picks it up.
  setStationTimezone(next.timezone);
  // shows + schedule are persisted to their own file (schedule.json); strip
  // them from the settings.json payload so legacy installs migrate forward
  // on the first write. The in-memory `cache` keeps the full shape so
  // resolveActiveShow / getEffectivePersona / the integrity sweep all
  // continue to work against one merged view.
  const { shows: _shows, schedule: _schedule, ...settingsPersist } = next;
  await writeFile(SETTINGS_PATH, JSON.stringify(settingsPersist, null, 2));
  await writeFile(
    SCHEDULE_PATH,
    JSON.stringify({ shows: next.shows, schedule: next.schedule }, null, 2),
  );
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
  // Station-zone wall clock, not process-local — schedule slots fire at the
  // hours the operator painted them in (issue #353).
  const { dow: day, hour } = zonedParts(date);
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
    // Optional music-steering filters (soft lean). Surfaced for the picker and
    // DJ agent; empty string / null means "no constraint".
    genre: typeof show.genre === 'string' ? show.genre : '',
    fromYear: Number.isFinite(show.fromYear) ? show.fromYear : null,
    toYear: Number.isFinite(show.toYear) ? show.toYear : null,
    energy: typeof show.energy === 'string' ? show.energy : '',
    // Empty string means "fall back to the station-wide default". The route
    // layer is responsible for resolving an empty/stale id against the live
    // theme registry; we just surface what the show declares.
    themeId: typeof show.themeId === 'string' ? show.themeId : '',
    persona: persona
      ? { id: persona.id, name: persona.name, avatar: persona.avatar || '' }
      : null,
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

// The persona's on-air language as a blunt system-prompt directive. Empty
// language (the default) returns '' so prompts stay byte-identical to the
// pre-language behaviour. The proper-nouns clause stops a Turkish host from
// translating "Bohemian Rhapsody" or the station name (issue #349).
export function languageDirective(persona: any) {
  const lang = String(persona?.language || '').trim();
  if (!lang) return '';
  return `\n\nIMPORTANT: You speak and write exclusively in ${lang}. Every on-air line you produce must be in ${lang} — acknowledgements, idents, asides, everything. Keep proper nouns (artist names, song titles, the station name) exactly as they are; do not translate them.`;
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location}, {language}. {name}/{soul} come from the supplied persona; the
// template is the global djPrompt (falling back to DEFAULT_DJ_PROMPT_TEMPLATE).
// A custom template with a {language} placeholder owns the wording (the
// language NAME is substituted, defaulting to English); otherwise a non-empty
// persona language appends the stock directive.
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
  const tone = personaToneDirectives(persona);
  if (tpl.includes('{language}')) {
    const lang = String(persona?.language || '').trim();
    return rendered.replaceAll('{language}', lang || 'English') + tone;
  }
  return rendered + languageDirective(persona) + tone;
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
  const opener = `You are ${name}, the on-air DJ for ${station}, a personal internet radio station. ${soul}${languageDirective(persona)}`;
  return rules ? `${opener}` : opener;
}

// Liquidsoap reads tiny text files instead of JSON.
const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;
const LIQ_ARCHIVE_ENABLED_PATH = `${STATE_DIR}/liquidsoap_archive_enabled.txt`;
const LIQ_ARCHIVE_BITRATE_PATH = `${STATE_DIR}/liquidsoap_archive_bitrate.txt`;
const LIQ_OPUS_ENABLED_PATH = `${STATE_DIR}/liquidsoap_opus_enabled.txt`;
const LIQ_STATION_NAME_PATH = `${STATE_DIR}/liquidsoap_station_name.txt`;

export async function writeLiquidsoapSettings(s) {
  await writeFile(LIQ_JINGLE_RATIO_PATH, String(s.jingleRatio));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
  await writeFile(LIQ_ARCHIVE_ENABLED_PATH, s.archive.enabled ? 'true' : 'false');
  await writeFile(LIQ_ARCHIVE_BITRATE_PATH, String(s.archive.bitrate));
  await writeFile(LIQ_OPUS_ENABLED_PATH, s.stream.opusEnabled ? 'true' : 'false');
  await writeFile(LIQ_STATION_NAME_PATH, s.station || DEFAULTS.station);
}

// Called from server.js startup so the files exist before Liquidsoap reads
// them on its next start. Idempotent.
export async function ensureLiquidsoapSettingsFile() {
  const s = await load();
  if (
    !existsSync(LIQ_JINGLE_RATIO_PATH) ||
    !existsSync(LIQ_CROSSFADE_PATH) ||
    !existsSync(LIQ_ARCHIVE_ENABLED_PATH) ||
    !existsSync(LIQ_ARCHIVE_BITRATE_PATH) ||
    !existsSync(LIQ_OPUS_ENABLED_PATH)
  ) {
    await writeLiquidsoapSettings(s);
  }
}
