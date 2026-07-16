// Durable settings — overrides for values that have static defaults in code.
// Stored at <stateDir>/settings.json. Some apply live (weather location,
// DJ personas, shows); others require a Liquidsoap restart (jingle frequency,
// crossfade duration).

import { readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { STATE_DIR, config } from './config.js';
import { writeFileAtomic } from './util/atomic-file.js';
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
export const DEFAULT_DJ_PROMPT_TEMPLATE = `You are {name}, the on-air DJ for {station}, a personal radio station broadcasting from {location}. {soul}.

Hard rules:
- Output ONLY the words to be spoken aloud. No stage directions, no asterisks, no quotes around your dialogue.
- Keep it brief by default — each task says how long.
- Never use radio-cliché tells: "and now", "next up", "coming up next", "and that was", or back-announcing with "that was [song] by [artist]". Be more natural.
- Don't repeat the artist and title robotically. Reference them in passing if at all.
- Reference the context you're given naturally; never invent facts that aren't in it (the weather, news, events, what's happening outside).
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
// 'silent' is absolute: the persona never talks on its own (no links, idents,
// hourlies, banter or segments) — only manual /dj/segment triggers, listener
// requests and programme beats still speak. 'chatty' sits between the
// historical moderate and aggressive.
export const FREQUENCIES = ['silent', 'quiet', 'moderate', 'chatty', 'aggressive'];

// Per-persona verbosity, ascending. 'concise' is the historical default;
// 'one-liner' cuts every segment to a single quick line, 'extended' roughly
// doubles, 'storyteller' roughly triples for long-form monologues.
// See llm/internal/prompts/system.ts LENGTH_PHRASES for the actual directives.
export const SCRIPT_LENGTHS = ['one-liner', 'concise', 'extended', 'storyteller'];

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
export function normalizeDial(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : DIAL_NEUTRAL;
}

// Pure: persona in, prompt fragment out. Returns '' when every dial sits in the
// neutral band, so renderDjPrompt appends nothing and the default prompt is
// unchanged. Unit-pinned in controller/scripts/llm-pure.test.ts.
export function personaToneDirectives(persona: unknown): string {
  if (!persona || typeof persona !== 'object') return '';
  const lines: string[] = [];
  const p = persona as Record<string, unknown>;
  for (const key of TONE_DIALS) {
    const v = Number(p[key]);
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
export function effectiveFrequency(persona: unknown = getEffectivePersona()) {
  const p = persona as { frequency?: unknown; djMode?: unknown } | null | undefined;
  const base = FREQUENCIES.includes(p?.frequency as string) ? (p?.frequency as string) : 'moderate';
  if (!p?.djMode) return base;
  // 'silent' is an explicit operator promise — DJ mode never bumps out of it.
  if (base === 'silent') return base;
  const i = FREQUENCIES.indexOf(base);
  return FREQUENCIES[Math.min(i + 1, FREQUENCIES.length - 1)];
}

// Single gate for the transition effects (filter sweep + echo washout): they're
// on whenever the on-air persona is in DJ mode — no separate toggle. The picker
// schema/prompt builders use this to decide whether to offer the DJ the
// `transition` choice; when off, the guidance is never shown and nothing is
// applied.
export function effectsActive(persona: unknown = getEffectivePersona()): boolean {
  return !!(persona as { djMode?: unknown } | null | undefined)?.djMode;
}

// TTS engines. Every spoken segment is voiced by the on-air persona's own
// `tts` config (see audio/tts.js); only jingle rendering falls back to the
// global defaultEngine.
//
// `cloud` routes through the AI SDK (OpenAI / ElevenLabs speech models) —
// see llm/speech.js. `piper`, `kokoro`, `chatterbox`, and `pocket-tts` are
// local engines. `remote` is a first-class self-hosted HTTP engine: it POSTs
// to a configurable /speak endpoint and gets the rendered audio back in the
// response body (no shared volume, so the endpoint can live on any host),
// gated on a /health probe. Configure the URL in settings.tts.remote.url.
// Chatterbox and PocketTTS are opt-in — the
// default controller image doesn't bundle either; build the image with
// `--build-arg WITH_CHATTERBOX=1` or `--build-arg WITH_POCKETTTS=1` (see
// docker/Dockerfile.controller) to include the runtime. The dispatcher gates
// each engine on isAvailable() so settings can reference it safely even when
// the runtime is absent (the engine just falls back to Piper).
export const TTS_ENGINES = ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'];

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
export function clampTtsGain(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(-TTS_GAIN_CLAMP_DB, Math.min(TTS_GAIN_CLAMP_DB, n));
  return Math.round(c * 10) / 10;
}

// Normalise a per-engine gain map to exactly one clean gain per known engine
// (default 0). Drops unknown keys so a hand-edited settings.json can't smuggle
// arbitrary keys into the annotate path.
function normalizeTtsGainMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const src = raw as Record<string, unknown> | null | undefined;
  for (const e of TTS_ENGINES) out[e] = clampTtsGain(src?.[e]);
  return out;
}

// DJ-voice speech-rate multiplier. A per-engine speed corrects an engine's
// out-of-the-box pace (Piper/Kokoro/cloud each read at a different default);
// a per-persona speed stacks on top as a character trim (a laid-back host
// slower than a hyper morning one). Both compose multiplicatively with the
// daypart energy already carried in audio/tts.ts, on top of the env base
// (PIPER_SPEED/KOKORO_SPEED/CLOUD_TTS_SPEED) — see audio/tts.ts:speak(). A
// MULTIPLIER where 1.0 = no change (today's behaviour); lower = slower. Only
// Piper/Kokoro/cloud honour it — chatterbox/pocket-tts workers ignore speed,
// so their map entries are inert (kept for symmetry with the gain map).
export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.0;
export const TTS_SPEED_DEFAULT = 1.0;

// Coerce any value to a clean speed multiplier: finite number, clamped to
// [TTS_SPEED_MIN, TTS_SPEED_MAX], rounded to 0.05. Garbage / non-finite →
// 1.0 (unity, i.e. today's behaviour).
export function clampTtsSpeed(v: unknown): number {
  // Treat unset (null/undefined/'') as unity, NOT as 0 — unlike gain, 0 is not
  // this dial's default and would clamp to the 0.5 floor instead of no-change.
  if (v === null || v === undefined || v === '') return TTS_SPEED_DEFAULT;
  const n = Number(v);
  if (!Number.isFinite(n)) return TTS_SPEED_DEFAULT;
  const c = Math.max(TTS_SPEED_MIN, Math.min(TTS_SPEED_MAX, n));
  return Math.round(c * 20) / 20;
}

// Normalise a per-engine speed map to exactly one clean multiplier per known
// engine (default 1.0). Drops unknown keys, mirroring normalizeTtsGainMap.
function normalizeTtsSpeedMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const src = raw as Record<string, unknown> | null | undefined;
  for (const e of TTS_ENGINES) out[e] = clampTtsSpeed(src?.[e]);
  return out;
}

// Operator speech corrections (tts.corrections) — find→replace pairs applied
// to every booth-bound line in audio/speech-text.ts before the engines see it
// (the operator-extensible sibling of the built-in SUB/WAVE → "Subwave" rule).
// `from` is a literal phrase (regex-escaped at apply time), `to` its spoken
// form ('' = drop the phrase entirely).
export const TTS_CORRECTIONS_LIMIT = 100;
const TTS_CORRECTION_FROM_MAX = 80;
const TTS_CORRECTION_TO_MAX = 160;

// Lenient on-load pass: never throws, drops malformed entries so a
// hand-edited settings.json can't wedge boot.
function normalizeTtsCorrections(raw: any): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ from: string; to: string }> = [];
  for (const item of raw) {
    if (out.length >= TTS_CORRECTIONS_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const from = typeof item.from === 'string'
      ? item.from.trim().slice(0, TTS_CORRECTION_FROM_MAX)
      : '';
    if (!from) continue;
    const to = typeof item.to === 'string'
      ? item.to.trim().slice(0, TTS_CORRECTION_TO_MAX)
      : '';
    out.push({ from, to });
  }
  return out;
}

// Strict update() validator — whole-array replace, indexed throws, rebuilt
// objects so unknown keys are stripped (the validateFestivalsStrict shape).
function validateTtsCorrectionsStrict(raw: any): Array<{ from: string; to: string }> {
  if (!Array.isArray(raw)) throw new Error('tts.corrections must be an array');
  if (raw.length > TTS_CORRECTIONS_LIMIT) {
    throw new Error(`tts.corrections must be at most ${TTS_CORRECTIONS_LIMIT} entries`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`tts.corrections[${i}] must be an object`);
    }
    const from = String(item.from ?? '').trim();
    if (from.length < 1 || from.length > TTS_CORRECTION_FROM_MAX) {
      throw new Error(`tts.corrections[${i}].from must be 1-${TTS_CORRECTION_FROM_MAX} chars`);
    }
    const to = String(item.to ?? '').trim();
    if (to.length > TTS_CORRECTION_TO_MAX) {
      throw new Error(`tts.corrections[${i}].to must be at most ${TTS_CORRECTION_TO_MAX} chars`);
    }
    return { from, to };
  });
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
  'requesty',
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'gateway',
];

// Subset of LLM_PROVIDERS that can actually produce text embeddings — the
// library tagger embeds every track (music/embeddings.ts). Two chat providers
// still route chat ONLY: deepseek and the Vercel AI gateway have no embeddings
// endpoint. Offering them in the embedding-provider picker silently fell through
// to a local Ollama and failed with a misleading "can't reach <provider>" error
// (#493). `openrouter` was originally in that chat-only set, but OpenRouter
// shipped an OpenAI-compatible embeddings endpoint, so it's back in (#522) and
// routes through llm/internal/provider/embedding.ts. `anthropic` was dropped —
// it has no first-party embedding model and only worked by transparently routing
// to OpenAI (needs OPENAI_API_KEY), which confused operators; pick OpenAI (or any
// other embedding provider) directly instead.
export const EMBEDDING_PROVIDERS = [
  'ollama',
  'openai-compatible',
  'locca',
  'openrouter',
  'openai',
  'google',
  'requesty',
];

// Coerce a stored Ollama context-window value. 0 disables (use Ollama's own
// default); any other number is clamped to a sane [2048, 131072] band and
// floored to an integer. Non-numeric/NaN falls back to `def`. Shared by the
// primary and fallback LLM legs so the rule can't drift between them.
function clampNumCtx(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  if (raw <= 0) return 0;
  return Math.min(131072, Math.max(2048, Math.floor(raw)));
}

// repeat_penalty for local openai-compatible / locca servers. Clamped to
// [1.0, 2.0]: 1.0 is OFF (a no-op, never injected), and >2.0 mangles output.
// Non-numeric/NaN falls back to `def`. See appliedRepeatPenalty() in
// capabilities.ts — Ollama ignores this field (ai-sdk-ollama v4 has no
// per-call repeat_penalty channel at all; restoration is a tracked follow-up).
function clampRepeatPenalty(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(2.0, Math.max(1.0, raw));
}

// Coerce a stored agent-deadline value (ms). Clamped to [5s, 180s] and floored
// to an integer; non-numeric/NaN falls back to `def`. The lower bound keeps a
// fat-fingered save from making every agent pick fail instantly; the upper
// bound keeps a stalling model from tying up an inference slot for minutes.
function clampAgentTimeout(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(180_000, Math.max(5_000, Math.floor(raw)));
}

// Daily LLM token cap. 0 disables (the default — never cap a free local box);
// otherwise floored to a non-negative integer. No upper bound: a cloud quota
// can legitimately be in the tens of millions of tokens/day. Non-numeric/NaN
// falls back to `def`.
function clampDailyTokenCap(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.max(0, Math.floor(raw));
}

// Soft-tier threshold as a percent of the cap. Clamped to [0, 100]; 0 or 100
// disables the soft tier (straight to hard at the cap). Non-numeric/NaN falls
// back to `def`.
function clampBudgetSoftPct(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(100, Math.max(0, Math.floor(raw)));
}

// Per-call max output tokens (issue #712). 0 is a first-class value meaning
// "off — use each strategy's built-in default", so it passes through unclamped.
// Any other value is floored and clamped to [MAX_OUTPUT_TOKENS_MIN,
// MAX_OUTPUT_TOKENS_MAX]; non-numeric/NaN falls back to `def`.
export const MAX_OUTPUT_TOKENS_MIN = 500;
export const MAX_OUTPUT_TOKENS_MAX = 8000;
export function clampMaxOutputTokens(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  const n = Math.floor(raw);
  if (n <= 0) return 0;
  return Math.min(MAX_OUTPUT_TOKENS_MAX, Math.max(MAX_OUTPUT_TOKENS_MIN, n));
}

// Resolve the effective per-call output-token cap. Returns the operator's
// configured value when set (> 0), else `fallback` — the strategy's own
// built-in default. The single read point for settings.llm.maxOutputTokens;
// strategy/text|object|agent all default their maxOutputTokens param through it.
export function resolveMaxOutputTokens(fallback: number): number {
  const v = get().llm?.maxOutputTokens;
  return typeof v === 'number' && v > 0 ? v : fallback;
}

// Count-based hard no-repeat window (distinct plays). Floored to an integer in
// [0, 290]: 0 disables; the 290 ceiling stays under the 300-entry _recentPlays
// cap so the requested window is never silently truncated by a too-short
// sidecar. Library-size clamping happens separately at use time
// (effectiveNoRepeatWindow). Non-numeric/NaN falls back to `def`.
function clampNoRepeatWindow(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(290, Math.max(0, Math.floor(raw)));
}

// Validate + apply the connection fields shared by the primary LLM leg and its
// optional fallback (provider/model/apiKey/ollamaUrl/baseUrl/reasoning/numCtx).
// `target` is the live settings sub-object to mutate; `patch` is the incoming
// partial; `label` prefixes error messages ('llm' or 'llm.fallback'). The
// "openai-compatible needs baseUrl" rule is left to the caller — the fallback
// only enforces it when enabled. Station-level toggles (pickerAgent,
// pauseWhenEmpty) are primary-only and handled at the call site.
function applyLlmLegPatch(target: Record<string, unknown>, patch: unknown, label: string): void {
  const l = (patch ?? {}) as Record<string, unknown>;
  if (l.provider !== undefined) {
    if (!LLM_PROVIDERS.includes(l.provider as string)) {
      throw new Error(`${label}.provider must be one of: ${LLM_PROVIDERS.join(', ')}`);
    }
    target.provider = l.provider;
  }
  if (l.model !== undefined) {
    const v = String(l.model).trim();
    if (v.length > 100) throw new Error(`${label}.model must be 0-100 chars`);
    target.model = v;
  }
  // NB: the inline API key is NOT handled here — it's routed per-provider into
  // settings.llm.keys by applyInlineKey() at the call site, after the leg's
  // provider has been resolved. Keeping it out of the shared leg patch is what
  // stops one provider's key leaking into another's slot (issue #657).
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
    target.numCtx = clampNumCtx(Number(l.numCtx), target.numCtx as number);
  }
  if (l.repeatPenalty !== undefined) {
    target.repeatPenalty = clampRepeatPenalty(Number(l.repeatPenalty), target.repeatPenalty as number);
  }
  // Forced-tool tool_choice: 'required' (default) or 'auto'. Only those two are
  // legal; anything else is a config error. See forcedToolChoice() / issue #570.
  if (l.toolChoice !== undefined) {
    const v = String(l.toolChoice).trim();
    if (v !== 'required' && v !== 'auto') {
      throw new Error(`${label}.toolChoice must be "required" or "auto"`);
    }
    target.toolChoice = v;
  }
}

// Route an incoming inline API key to its provider's slot in `llmHost.keys`
// (issue #657). `provider` is the leg's already-resolved provider, so the key
// lands under the identity it belongs to and can never shadow another
// provider's key after a switch. '' clears that provider's entry; 'set' (the
// getRedacted() sentinel) and undefined leave it untouched.
function applyInlineKey(llmHost: { keys?: Record<string, string> }, provider: string, rawApiKey: unknown): void {
  if (rawApiKey === undefined || rawApiKey === 'set') return;
  const v = String(rawApiKey);
  if (v.length > 1000) throw new Error('llm.apiKey must be 0-1000 chars');
  if (!llmHost.keys || typeof llmHost.keys !== 'object') llmHost.keys = {};
  if (v) llmHost.keys[provider] = v;
  else delete llmHost.keys[provider];
}

// Build the per-provider inline-key map from a stored settings.llm blob.
// Sanitises any persisted `keys` (string values, known providers only) and
// migrates the two legacy single slots (settings.llm.apiKey /
// settings.llm.fallback.apiKey). Those were only ever written by the
// openai-compatible / locca inline-key path, so a value found while the leg's
// provider is something else is a STALE compat token that leaked into the
// shared slot (issue #657) — attribute it to its true owner (openai-compatible)
// rather than the current provider, which both preserves the real key and keeps
// the env-var provider's slot empty so it resolves from secrets.env again.
function normalizeLlmKeys(storedLlm: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const sl = storedLlm as {
    keys?: unknown;
    apiKey?: unknown;
    provider?: unknown;
    fallback?: { apiKey?: unknown; provider?: unknown };
  } | null | undefined;
  const raw = sl?.keys;
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const p of Object.keys(rec)) {
      if (LLM_PROVIDERS.includes(p) && typeof rec[p] === 'string' && rec[p]) out[p] = rec[p] as string;
    }
  }
  const ownerFor = (prov: unknown): string =>
    prov === 'openai-compatible' || prov === 'locca' ? (prov as string) : 'openai-compatible';
  const legacyPrimary = typeof sl?.apiKey === 'string' ? sl.apiKey : '';
  if (legacyPrimary) {
    const owner = ownerFor(sl?.provider);
    if (!out[owner]) out[owner] = legacyPrimary;
  }
  const legacyFallback = typeof sl?.fallback?.apiKey === 'string' ? sl.fallback.apiKey : '';
  if (legacyFallback) {
    const owner = ownerFor(sl?.fallback?.provider);
    if (!out[owner]) out[owner] = legacyFallback;
  }
  return out;
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
// results; `brave` is Brave's Search API (metered, $5/mo free credits) — both
// read their key from SEARCH_API_KEY. `searxng` is keyless self-hosted
// meta-search via settings.search.baseUrl.
export const SEARCH_PROVIDERS = ['duckduckgo', 'tavily', 'brave', 'searxng'] as const;

// Canonical mood vocabulary. Shared by the library tagger (music/tag-library.js
// imports this as MOOD_VOCAB) and the Shows scheduler — a show's `moods` (lead
// entry) override the autonomous dominantMood, so every entry must come from
// this list. An empty list means "Any": the show pins no mood and the
// autonomous chain (festival > weather > time) applies while it's on air.
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

// Default festival calendar — the seeded set the admin UI shows on first boot.
// After the operator edits the list, persisted festivals replace these.
export const FESTIVAL_DEFAULTS = [
  { month: 1, day: 1, name: "New Year's Day", mood: 'celebratory' },
  { month: 2, day: 14, name: "Valentine's Day", mood: 'romantic' },
  { month: 3, day: 17, name: "St. Patrick's Day", mood: 'celebratory' },
  { month: 4, day: 13, name: 'Vaisakhi', mood: 'festival', windowDays: 1 },
  { month: 5, day: 1, name: 'May Day', mood: 'festival' },
  { month: 6, day: 21, name: 'Summer Solstice', mood: 'celebratory' },
  { month: 10, day: 31, name: 'Halloween', mood: 'festival' },
  { month: 11, day: 1, name: 'Diwali', mood: 'festival', windowDays: 3 },
  { month: 11, day: 5, name: 'Bonfire Night', mood: 'festival' },
  { month: 12, day: 21, name: 'Winter Solstice', mood: 'reflective' },
  { month: 12, day: 25, name: 'Christmas', mood: 'celebratory', windowDays: 1 },
  { month: 12, day: 26, name: 'Boxing Day', mood: 'celebratory' },
  { month: 12, day: 31, name: "New Year's Eve", mood: 'celebratory' },
];

// All 54 official Kokoro voices from kokoro-onnx v1.0. The UI filters by
// language prefix and formats display names from the code (bm_george → "George (M)").
// Any voice matching KOKORO_VOICE_RE passes validation.
export const KOKORO_VOICES = [
  'af_alloy', 'af_aoede', 'af_bella', 'af_heart', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
  'ef_dora', 'em_alex', 'em_santa',
  'ff_siwis',
  'hf_alpha', 'hf_beta', 'hm_omega', 'hm_psi',
  'if_sara', 'im_nicola',
  'jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo',
  'pf_dora', 'pm_alex', 'pm_santa',
  'zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
  'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang',
];

export const KOKORO_VOICE_LANGUAGES: Record<string, string> = {
  'a': 'English (US)',
  'b': 'English (UK)',
  'e': 'Spanish',
  'f': 'French',
  'h': 'Hindi',
  'i': 'Italian',
  'j': 'Japanese',
  'p': 'Portuguese (Brazilian)',
  'z': 'Mandarin Chinese',
};

const KOKORO_VOICE_RE = /^[a-z]{2}_[a-z0-9]+$/;

// Kokoro language override — the set of phonemizer languages the worker accepts.
// The worker builds an espeak.EspeakG2P for the chosen language (see _phonemize
// in kokoro_worker.py). Empty string = auto-detect from the voice-code prefix.
// Synced with the prefix→lang mapping in controller/scripts/kokoro_worker.py.
export const KOKORO_LANGS = ['en-gb', 'en-us', 'es', 'it', 'fr', 'hi', 'pt-br', 'ja', 'cmn'];
const KOKORO_LANG_RE = new RegExp(`^(${KOKORO_LANGS.join('|')})$`);

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
// Skill slugs (e.g. 'weather', 'random-facts'). The skills registry is the
// source of truth for which slugs exist; settings only checks the shape.
const SKILL_SLUG_RE = /^[a-z0-9-]{1,40}$/;

// Exported for the community-persona install route (routes/personas.ts), which
// gives a friendly 409 before settings.update() would throw on an oversize roster.
export const PERSONA_LIMIT = 48;
export const SHOWS_LIMIT = 64;
// Guest co-hosts per show. Small on purpose: each guest is a full persona the
// speaker rotation can hand a segment to, and past ~3 the host stops sounding
// like the host.
const GUESTS_PER_SHOW = 3;
const PLAYLISTS_PER_SHOW = 10;
const EXCLUDED_PLAYLISTS_PER_SHOW = 10;
// Values per multi-select music filter (moods / genres / eras). Within one
// attribute the values OR together at pick time; across attributes they AND —
// so past a handful the filter stops meaning anything.
const SHOW_FILTER_VALUES_MAX = 6;
// Must comfortably exceed a realistic skill library: unticking one skill on an
// "all skills" (null) persona materialises the FULL catalog minus one, so a cap
// near the library size would make that first untick fail (#skill-organization).
const SKILLS_PER_PERSONA_LIMIT = 64;
const WEBHOOKS_LIMIT = 16;
// Prompt-template library (djPrompts). Text bounds match the historical
// single-djPrompt rule — keep them in lockstep with PROMPT_MIN/PROMPT_MAX in
// web/components/admin/personas/constants.ts.
const DJ_PROMPT_LIMIT = 20;
const DJ_PROMPT_NAME_MAX = 60;
const DJ_PROMPT_TEXT_MIN = 50;
const DJ_PROMPT_TEXT_MAX = 4000;

// A show can anchor to one or more Navidrome playlists: the playlist union
// becomes the show's candidate pool. Stored as Subsonic playlist ids; deduped,
// trimmed, capped. Never validated against the live Navidrome here (offline
// validation, same as `genre` free-text) — an id that no longer exists simply
// contributes nothing at pick time (never-starve). Empty = no anchor.
// A show's guest co-hosts: persona ids other than the host, resolved against
// the live persona list. Order preserved (it's the operator's billing order);
// dupes, the host itself, and dangling ids are dropped.
function coerceGuestPersonaIds(raw: unknown, hostId: string, personaIds: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || id === hostId || seen.has(id) || !personaIds.includes(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= GUESTS_PER_SHOW) break;
  }
  return out;
}

function coercePlaylistIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= PLAYLISTS_PER_SHOW) break;
  }
  return out;
}

// ── Multi-value music filters (#929) ────────────────────────────────────────
// A show's Genre Lean / Mood / Energy / Era each hold a LIST of values: OR
// within the attribute, AND across attributes, every value weighted equally.
// Legacy singular fields (`mood`, `genre`, `energy`, `fromYear`/`toYear`) are
// migrated to one-element lists on load — same pattern as dj.soul → dj.souls.
// The lenient coercers below serve normalizeShows (load path); the strict
// validator has its own throwing checks that reuse the same shapes.

// One era window { fromYear, toYear } — at least one bound set; both-null
// entries are meaningless and dropped. Multiple windows let a show span
// non-adjacent decades ("90s + 2010s") — inexpressible as a single range.
export type EraWindow = { fromYear: number | null; toYear: number | null };

// One outbound-webhook entry (settings.webhooks). Shared by the DEFAULTS seed,
// the lenient load-time normalizer, and the strict update() validator.
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  authHeader: string;
}

// One saved DJ prompt-template library entry (settings.djPrompts).
export interface DjPromptEntry {
  id: string;
  name: string;
  text: string;
}

// A show as produced by the lenient load-time normalizer (normalizeShows).
// The plural music-filter lists are canonical; legacy singular fields have
// already been migrated by the coercers below.
export interface NormalizedShow {
  id: string;
  name: string;
  topic: string;
  personaId: string;
  guestPersonaIds: string[];
  banter: boolean;
  programme: boolean;
  segmentSkill: string;
  moods: string[];
  themeId: string;
  genres: string[];
  eras: EraWindow[];
  energies: string[];
  filtersStrict: boolean;
  maxTrackSeconds: number | null;
  playlistIds: string[];
  playlistStrict: boolean;
  excludedPlaylistIds: string[];
}

function coerceEraWindow(raw: unknown): EraWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { fromYear?: unknown; toYear?: unknown };
  const fromYear = Number.isFinite(r.fromYear) ? Math.trunc(r.fromYear as number) : null;
  const toYear = Number.isFinite(r.toYear) ? Math.trunc(r.toYear as number) : null;
  if (fromYear == null && toYear == null) return null;
  if (fromYear != null && toYear != null && fromYear > toYear) return null;
  return { fromYear, toYear };
}

// Plural-first: `item[plural]` wins when it's an array; otherwise the legacy
// singular value (if any) becomes a one-element list. Dedup + cap.
function coerceShowList<T>(
  item: unknown,
  plural: string,
  singular: string,
  coerceOne: (v: unknown) => T | null,
  keyOf: (v: T) => string,
): T[] {
  const rec = item as Record<string, unknown> | null | undefined;
  const raw: unknown[] = Array.isArray(rec?.[plural]) ? (rec?.[plural] as unknown[]) : [rec?.[singular]];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of raw) {
    const one = coerceOne(v);
    if (one == null) continue;
    const k = keyOf(one);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(one);
    if (out.length >= SHOW_FILTER_VALUES_MAX) break;
  }
  return out;
}

function coerceShowMoods(item: unknown): string[] {
  return coerceShowList(item, 'moods', 'mood',
    (v) => (typeof v === 'string' && SHOW_MOODS.includes(v) ? v : null),
    (v) => v);
}

function coerceShowGenres(item: unknown): string[] {
  // Legacy singular `genre` was one free-text field and operators crammed
  // multiple genres into it comma-separated ("funk, soul, jazz-funk") — which
  // never resolved against the library as one tag. Split it on migration so
  // each becomes a real, individually-resolvable entry. Plural-array entries
  // are taken as-is (the UI adds them one at a time).
  const rec = (item ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(rec.genres)
    ? rec.genres
    : typeof rec.genre === 'string' ? rec.genre.split(',') : [];
  return coerceShowList({ genres: raw }, 'genres', 'genre',
    (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null),
    (v) => v.toLowerCase());
}

function coerceShowEnergies(item: unknown): string[] {
  return coerceShowList(item, 'energies', 'energy',
    (v) => (typeof v === 'string' && SHOW_ENERGY.includes(v) ? v : null),
    (v) => v);
}

function coerceShowEras(item: unknown): EraWindow[] {
  // Legacy singular is a pair of top-level keys, not one value — synthesize
  // the window before handing off to the shared list coercer.
  const rec = (item ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(rec.eras)
    ? rec.eras
    : [{ fromYear: rec.fromYear, toYear: rec.toYear }];
  return coerceShowList({ eras: raw }, 'eras', 'era', coerceEraWindow,
    (e) => `${e.fromYear ?? ''}:${e.toYear ?? ''}`);
}

// A show can exclude tracks from one or more Navidrome playlists: any track
// that appears in these playlists is dropped from the candidate pool at pick
// time. Same shape/rules as coercePlaylistIds. Empty = no exclusions.
function coerceExcludedPlaylistIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= EXCLUDED_PLAYLISTS_PER_SHOW) break;
  }
  return out;
}

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

// True when the four ElevenLabs voice_settings knobs (issue #696) all sit at
// their shipped defaults, i.e. the operator never tuned them. cloud-speech uses
// this to OMIT the voice_settings block in that case so ElevenLabs defers to the
// voice's own VoiceLab-saved settings, instead of forcing these literals onto
// every call (issue #915 review). Compared against DEFAULTS so there's a single
// source of truth for the default values.
export function cloudVoiceSettingsAreDefault(c: unknown): boolean {
  const d = DEFAULTS.tts.cloud;
  const cc = c as {
    voiceStability?: unknown;
    voiceStyle?: unknown;
    voiceSimilarityBoost?: unknown;
    voiceUseSpeakerBoost?: unknown;
  } | null | undefined;
  return cc?.voiceStability === d.voiceStability
    && cc?.voiceStyle === d.voiceStyle
    && cc?.voiceSimilarityBoost === d.voiceSimilarityBoost
    && cc?.voiceUseSpeakerBoost === d.voiceUseSpeakerBoost;
}

// Coerce a stored/per-show max-track-length to a clean integer SECOND count.
// `allowNull` distinguishes the two callers: the station default has no "unset"
// state (missing → 0 = off), whereas a per-show value uses null to mean "inherit
// the station default" (vs 0 = "unlimited override"). Out-of-band values clamp
// into [0, max] rather than throw — load() stays lenient.
function coerceMaxTrackSeconds(raw: unknown, allowNull: boolean): number | null {
  if (raw == null || raw === '') return allowNull ? null : 0;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return allowNull ? null : 0;
  return Math.min(BOUNDS.maxTrackSeconds.max, Math.max(0, n));
}

// Back-compat: this cap was stored and sent in MINUTES (`maxTrackMinutes`) before
// it moved to seconds. Prefer the new `maxTrackSeconds` key; fall back to a legacy
// minutes value ×60 so an existing settings.json / show and any stale client keep
// working. Returns the raw seconds value (leaving null/''/undefined untouched) for
// coerceMaxTrackSeconds to clamp.
function rawMaxTrackSec(o: unknown): unknown {
  if (o == null) return o;
  const rec = o as Record<string, unknown>;
  if (rec.maxTrackSeconds != null && rec.maxTrackSeconds !== '') return rec.maxTrackSeconds;
  if (rec.maxTrackMinutes != null && rec.maxTrackMinutes !== '') return Number(rec.maxTrackMinutes) * 60;
  return rec.maxTrackSeconds;
}

// Effective track-length cap in SECONDS for the moment a pick is made, or null
// for "no cap". A scheduled show's maxTrackSeconds (when set) overrides the
// station default; 0 at the winning level means unlimited. This is the single
// resolver both picker paths and the auto-playlist call so the precedence rule
// lives in exactly one place.
export function effectiveMaxTrackSec(
  show: { maxTrackSeconds?: unknown } | null | undefined = resolveActiveShow(),
  s: { maxTrackSeconds?: unknown } | null | undefined = get(),
): number | null {
  const station = coerceMaxTrackSeconds(s?.maxTrackSeconds, false) ?? 0;
  const showSec = show && show.maxTrackSeconds != null
    ? coerceMaxTrackSeconds(show.maxTrackSeconds, false)
    : null;
  const sec = showSec != null ? showSec : station;
  return sec && sec > 0 ? sec : null;
}

// Smallest non-zero max-track-length (seconds) validation accepts and the
// admin/show UI offers. The on-air cut fires a crossfade that BEGINS
// crossfadeDuration before the cut point, so a cap below the crossfade is
// degenerate and below 2× leaves the track no solo airtime. 0 (= unlimited) is
// always allowed — this is only the floor for a POSITIVE cap. Surfaced to the UI
// via /settings.values.minTrackSeconds so client and server share one rule.
export function minTrackSeconds(s: { crossfadeDuration?: unknown } | null | undefined = get()): number {
  const xf = Number(s?.crossfadeDuration);
  const cross = Number.isFinite(xf) && xf > 0 ? xf : DEFAULTS.crossfadeDuration;
  return Math.max(30, Math.ceil(2 * cross));
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
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 },
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
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bf_alice', gainDb: 0, speed: 1 },
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
    tts: { engine: 'piper', cloudProvider: 'openai', voice: 'bm_daniel', gainDb: 0, speed: 1 },
  },
];

// Allowed MP3 bitrates — shared by the hourly archive and the live
// /stream.mp3 mount. Matches the literal branches in radio.liq —
// %mp3(bitrate=…) needs a parse-time int, so the encoder is pre-baked for
// this small set. Add a branch in radio.liq if you add a value here.
export const MP3_BITRATES = [64, 96, 128, 160, 192, 320] as const;
// Opus + AAC encoders share the same parse-time-literal constraint as %mp3, so
// each is pre-baked for a small set in radio.liq. Add a branch there if you add
// a value here.
export const OPUS_BITRATES = [96, 128, 192, 256, 320] as const;
export const AAC_BITRATES = [128, 192, 256] as const;

// Where per-track loudness comes from (queue.applyLoudnessGain, issue #998):
// an embedded ReplayGain tag (Navidrome's OpenSubsonic replayGain field),
// the analyzer's measured LUFS, or tag-with-measured-fallback (the default).
export const LOUDNESS_SOURCES = ['replaygain-then-measured', 'replaygain', 'measured'] as const;
export type LoudnessSource = (typeof LOUDNESS_SOURCES)[number];

const DEFAULTS = {
  jingleRatio: 30, // 1 jingle per N music tracks
  crossfadeDuration: 10.0, // seconds
  // Station-wide cap (seconds) on how long a single autonomously-picked track
  // may be — keeps hour-long album mixes and DJ sets out of normal rotation
  // (issue #447). 0 = no cap (default, unchanged behaviour). A scheduled show
  // can override this with its own `maxTrackSeconds` (0 there = "unlimited",
  // i.e. opt back out of the station cap for a long-form show). Listener
  // requests bypass the cap entirely — an explicit ask always plays.
  maxTrackSeconds: 0,
  // Hourly archive output. Off by default — the second MP3 encoder is the
  // largest constant CPU cost in the broadcast container, and most operators
  // don't use the archives, so they opt in via admin → Settings rather than
  // paying for the tape by default (issue #137). Dropping the bitrate (e.g.
  // 128 → 64 mono in a future change) also helps for operators who want it.
  // retentionDays: hourly recordings older than this many days are deleted by
  // the scheduler's hourly cleanup. 0 = keep forever — the default, because a
  // retention default would silently delete archives operators already have.
  archive: { enabled: false, bitrate: 128, retentionDays: 0 },
  // Secondary Ogg-Opus broadcast mount (/stream.opus). Off by default — only
  // Blink (Chrome/Edge) clients ever select it (web/hooks/usePlayer.ts keeps
  // Safari/iOS/Firefox on MP3), and it adds a continuous Opus encoder + a
  // 44.1→48k resample, so operators opt in rather than pay that CPU unasked.
  // The mandatory /stream.mp3 mount always serves everyone.
  stream: {
    opusEnabled: false,
    opusBitrate: 96,
    flacEnabled: false,
    aacEnabled: false,
    aacBitrate: 192,
    bitrate: 192,
  },
  // Per-track loudness normalisation (music/mix.ts gainForLoudness). targetLufs
  // is what every measured track is pulled toward; maxBoostDb caps the upward
  // direction only — cuts have a fixed wide clamp, and the boost is further
  // limited by the track's own measured peak headroom, so widening this on a
  // dynamic library won't slam the broadcast limiter. Read live per track at
  // annotate time; no mixer restart. `source` picks where the loudness figure
  // comes from (issue #998): embedded ReplayGain tags (whole-file stereo R128,
  // via Navidrome's OpenSubsonic replayGain field) vs the analyzer's measured
  // LUFS (leading window only). The default prefers the tag and falls back to
  // the measurement, so untagged libraries behave exactly as before.
  loudness: {
    targetLufs: -14,
    maxBoostDb: 6,
    source: 'replaygain-then-measured' as LoudnessSource,
  },
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
  // Festival calendar — mood-forming dates the DJ leans into. Persisted here
  // so operators can add/edit/remove entries from the admin UI. Fall back to
  // FESTIVAL_DEFAULTS when empty/absent.
  festivals: FESTIVAL_DEFAULTS,
  // Listener-player UI toggles — purely presentational, station-wide. The web
  // player reads these via GET /state (alongside the theme) and applies them
  // live; no restart. `boothBuddy` gates the DJ-line mascot — OFF by default,
  // so the line shows the classic ♪/◇ marker until an operator opts in.
  // `skin` is the station-wide player-skin id — the web app owns the skin
  // registry and falls back to its default on an unknown id, so the
  // controller only stores a slug, never validates against a list.
  // `tuneInOverlay` gates the full-bleed "Tap to tune in" gate — ON by default;
  // OFF drops the takeover and listeners start via the skin's own play button
  // (browsers still can't autoplay, so a tap is always required somewhere).
  ui: { boothBuddy: false, skin: 'classic', tuneInOverlay: true },
  // Global DJ prompt template. '' means "use DEFAULT_DJ_PROMPT_TEMPLATE".
  // Always the RESOLVED text of the active djPrompts entry — kept so
  // renderDjPrompt() (and an older controller sharing the same settings.json)
  // never has to chase the library.
  djPrompt: '',
  // Saved prompt-template library + which entry is active ('' = built-in
  // default). Switching templates just moves activeDjPromptId.
  djPrompts: [],
  activeDjPromptId: '',
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
    kokoro: { voice: 'bf_isabella', lang: '' },
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
      // ElevenLabs voice_settings. Applied ONLY when provider is 'elevenlabs';
      // ignored (and never sent) for openai / openai-compatible. All four match
      // ElevenLabs' native ranges: stability, style, similarity_boost ∈ [0,1],
      // use_speaker_boost is a bool. Defaults mirror ElevenLabs' UI defaults so
      // an unconfigured install renders exactly like the SDK's own baseline
      // (issue #696).
      voiceStability: 0.5,
      voiceStyle: 0,
      voiceSimilarityBoost: 0.75,
      voiceUseSpeakerBoost: true,
    },
    // Remote engine — a user-configured self-hosted TTS endpoint that renders
    // audio over HTTP (POST /speak → audio body, gated on a /health probe).
    // The TTS equivalent of the LLM's custom base URL. Empty → engine reports
    // unavailable; the dispatcher falls back.
    remote: { url: '' },
    // Per-engine voice level trim (dB), applied via Liquidsoap's liq_amplify on
    // every spoken segment that resolves to that engine. Levels the loudness gap
    // between engines (e.g. boost PocketTTS to match raw Piper). Stacks with each
    // persona's own tts.gainDb. All 0 = unity = today's behaviour. See
    // TTS_GAIN_CLAMP_DB and audio/tts.ts:voiceGainDb().
    gainDb: { piper: 0, kokoro: 0, chatterbox: 0, 'pocket-tts': 0, cloud: 0, remote: 0 },
    // Per-engine speech-rate multiplier (0.5–2.0×, 1.0 = no change), composed
    // on top of the daypart energy and each persona's own tts.speed in
    // audio/tts.ts:speak(). Only Piper/Kokoro/cloud honour it; chatterbox/
    // pocket-tts/remote ignore speed so their entries are inert. See clampTtsSpeed().
    speed: { piper: 1, kokoro: 1, chatterbox: 1, 'pocket-tts': 1, cloud: 1, remote: 1 },
    // Operator speech corrections — find→replace pairs applied to every
    // booth-bound line before any TTS engine sees it (audio/speech-text.ts).
    // Each entry: { from: 'GHz', to: 'gigahertz' }. Empty by default.
    corrections: [],
  },
  llm: {
    provider: 'ollama',
    model: '',
    // Legacy single inline-key slot. Superseded by `keys` (per-provider) — kept
    // only so an old settings.json migrates cleanly. Always '' after load();
    // resolution reads `keys`, never this. See llmKeyFor() / normalizeLlmKeys().
    apiKey: '',
    // Per-provider inline API keys, keyed by provider id (issue #657). Only the
    // inline-key providers (openai-compatible, locca) ever populate this from the
    // UI — env-var providers (openrouter, anthropic, …) keep their key in
    // state/secrets.env. Namespacing by provider means switching providers can
    // never leave one provider's key in the slot another provider then reads.
    keys: {},
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
    // How SUB/WAVE forces a tool call in the structured-output paths (the emit /
    // done-tool harness). 'required' (default) makes the model call the tool —
    // the reliable path for local models that ignore JSON mode. Switch to 'auto'
    // ONLY if your server crashes on tool_choice:"required": recent vLLM
    // implements it via a guided-decoding backend that some images (newer
    // Intel/XPU builds) mishandle, while "auto" never engages it (issue #570).
    // On 'auto' the done-tool path keeps its activeTools pinning + instructions,
    // so a capable model still calls the tool; misses fall back to the pool
    // picker. Leave on 'required' unless you hit that crash.
    toolChoice: 'required',
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
    // Repetition penalty for local openai-compatible / locca servers (llama.cpp,
    // vLLM, LM Studio). llama.cpp's own default is 1.0 = OFF, which lets the
    // tool-loop picker run away repeating a token block until it hits the output
    // cap and never calls `done`. 1.15 is a sane floor; raise toward 1.25 if a
    // model still loops, or set 1.0 to disable (e.g. a vLLM server that rejects
    // the `repeat_penalty` body field). Injected into the request body — the AI
    // SDK's openai provider has no field for it. Ignored by every other provider
    // (incl. Ollama: ai-sdk-ollama v4 has no per-call repeat_penalty channel).
    repeatPenalty: 1.15,
    // When on, the session DJ agent drives track-picking, links and listener
    // requests as a tool-loop over the session chat history (broadcast/
    // dj-agent.js). When off, the stateless pool picker runs instead — still
    // inside a session, still logged, just without the conversational loop.
    pickerAgent: true,
    // Count-based hard no-repeat window: the picker never re-airs any of the
    // last N DISTINCT plays. Non-relaxable (survives the filterPickerCandidates
    // starvation cascade), so it closes the hole where a thin mood cluster let
    // the cascade re-serve a just-played song. Clamped to library size at use
    // (effectiveNoRepeatWindow) so a small catalogue never fully blocks; 0
    // disables. Seeded from config.queue.noRepeatWindow (env NO_REPEAT_WINDOW);
    // listener requests stay exempt. See music/recency.ts + broadcast/queue.ts.
    noRepeatWindow: config.queue.noRepeatWindow,
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
    // Daily LLM token budget — a safety net against bill-shock on a metered
    // provider (the DJ calls the model on essentially every track transition,
    // 24/7). 0 = unlimited (the default — most installs run free local Ollama
    // and must be unaffected). When set, the day's token usage (UTC, summed
    // from the same usage stats as the lifetime ticker) drives a two-tier
    // degradation: at `budgetSoftPct` of the cap the DJ drops to the cheap pool
    // picker and mutes optional segments (links, station IDs, hourly, weather/
    // news/etc.); at the cap it stops calling the model entirely and the stream
    // coasts on the LLM-free auto playlist — music never stops. Enforced in
    // broadcast/dj-budget.ts; see llm/internal/core/pure.ts `budgetMode`.
    dailyTokenCap: 0,
    // When the day's usage crosses this percent of dailyTokenCap, enter the
    // "soft" tier (cheap picker, no optional segments). 0 or 100 disables the
    // soft tier and goes straight from normal to hard at the cap.
    budgetSoftPct: 80,
    // When on (the default), listener requests are still answered by the agent
    // even over the hard cap — a human asked, so honour it. When off, requests
    // over the cap fall through to the stateless matcher cascade like every
    // other LLM path. No effect until dailyTokenCap is set.
    exemptRequests: true,
    // Per-call max OUTPUT tokens — distinct from dailyTokenCap (a cumulative
    // daily budget). This caps the size of each individual model response. The
    // strategy primitives default to generous built-ins (4000 text / 8000
    // object / 8000 agent); 0 = use those defaults. Set a value (clamped
    // 500–8000) to override all three — the lever for a local model on a small
    // context window, where an 8000-token response allowance can crowd out the
    // system prompt / tool listing and risk truncation, and is pure waste with
    // reasoning off. Resolved via resolveMaxOutputTokens(); see issue #712.
    maxOutputTokens: 0,
    // When on (or when LLM_DEBUG_RAW is set in the env), every outbound model
    // request's exact body is captured to ${STATE_DIR}/logs/llm-debug.log (the
    // last 10, newest first) and dumped to stderr — a copy-pasteable view of
    // exactly what SUB/WAVE sends the provider, for debugging odd model
    // behaviour. The admin toggle (admin → Debug) means no-CLI operators can
    // flip it without editing env; the env flag can only force it on. Off by
    // default: zero file writes / overhead when disabled.
    debugRawRequests: false,
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
      toolChoice: 'required',
      numCtx: 16384,
      repeatPenalty: 1.15,
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
    apiKey: '',           // empty -> inherit settings.llm.apiKey
    seedCount: 0,         // 0 → auto (see autoSeedCount in tag-library.ts: ~4% of
                          //   the library, floored 200 / capped 2500)
    // Propagation defaults. These were 5 / 0.6 / 0.6 and propagated almost
    // nothing: confidence is topSim×coverage (a product of two sub-1 terms — see
    // tag-propagator.ts), so a 0.6 gate rejected even strong matches and dumped
    // the library into expensive active-learning. Loosened so KNN propagation
    // actually carries the bulk of tagging. NOTE: only affects NEW installs / a
    // reset — an existing settings.json keeps its saved values (loadWithDefaults
    // below prefers a stored value), so operators are never silently overridden.
    knnNeighbours: 10,        // was 5 — a broader, more stable neighbour vote
    moodVoteThreshold: 0.4,   // was 0.6 — a mood carried by ~a third propagates
    confidenceThreshold: 0.35, // was 0.6 — see the topSim×coverage note above
    maxActiveLearningRounds: 3,
    // CLAP audio fusion in mood propagation: tracks with a "sounds-like"
    // audio vector also pull neighbours from the audio-KNN space, scaled by
    // this weight, before the mood vote (tag-propagator.ts fuseNeighbours).
    // Sound is the stronger mood signal for instrumentals / thin-metadata
    // tracks, and CLAP neighbours don't cluster by album. 0 = text-only
    // (today's behaviour); 1 = trust audio similarity as much as text. Only
    // bites where the acoustic analysis has produced audio vectors.
    audioFusionWeight: 0.5,
    batchSize: 25,
    enrichment: {
      // Last.fm crowd tags. Tri-state: true = always fetch, false = never,
      // null = auto (fetch only when a Last.fm api_key is configured — see
      // music/lastfm.ts + the gate in tag-library.ts phaseEnrich).
      //
      // Tags now come straight from the Last.fm REST API (artist.getTopTags)
      // reusing the scrobbling api_key, which actually returns tag[]. The old
      // path went through Navidrome's getArtistInfo2, where vanilla Navidrome's
      // agent only surfaces bio + images — never tag[] — so tags always came
      // back empty. That Navidrome path stays as the fallback when lastfmTags
      // is forced on (true) but no api_key is set (custom Navidromes that DO
      // expose tag[]). Default `null` avoids the wasted round trip for keyless
      // vanilla-Navidrome installs.
      lastfmTags: null as boolean | null,
      lyrics: true,       // fetch + include lyric excerpt in embed text
    },
  },
  // Web-search backend for the segment director's web-search capability.
  // Default `duckduckgo` works out of the box with no key; `tavily` and
  // `brave` read their key from SEARCH_API_KEY (or the optional override
  // below). `apiKey` is only meaningful for the keyed providers.
  search: {
    provider: 'duckduckgo',
    apiKey: '',
    baseUrl: '',
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
  // call. `track.play` can be listener-gated via webhooksPolicy (off by
  // default — see broadcast/queue.ts). Empty by default — operators add hooks
  // via the admin UI.
  webhooks: [] as Webhook[],
  webhooksPolicy: {
    // When true, track.play POSTs only when listener count > 0 (fail-closed on
    // null/unknown/non-finite, like scrobble). Default false = always send.
    trackPlayListenerGated: false,
  },
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
      // Optional override for self-hosted LB-compatible scrobblers (e.g. Koito).
      // Full submit URL is `${baseUrl}/submit-listens`. Env LISTENBRAINZ_API_URL wins.
      baseUrl: '',
    },
  },

  // Listener likes (#991) — the player heart button. `starInNavidrome` mirrors
  // each first like of a song into Navidrome via Subsonic star (any Subsonic
  // client sees it under Starred). `influenceDj` feeds the most-liked tracks
  // back to BOTH pick paths (agent prompt lean + pool picker source) as a
  // weighted preference signal — never a lock. Window/limit bound that signal.
  likes: {
    enabled: true,
    starInNavidrome: true,
    influenceDj: false,
    maxTracks: 10,
    windowDays: 30, // 0 = all time
  },
};

const BOUNDS = {
  // 0 = jingles off entirely — radio.liq skips the jingle rotate when the
  // ratio file reads 0 (issue #997: no way to disable the station stinger).
  jingleRatio: { min: 0, max: 1000, type: 'int' },
  crossfadeDuration: { min: 0, max: 30, type: 'float' },
  // 0 = off; 36000 s (10h) is a generous ceiling that still leaves room for
  // long-form mix shows without letting a typo set an absurd value.
  maxTrackSeconds: { min: 0, max: 36000, type: 'int' },
  // −23 (EBU R128 broadcast) … −9 (very loud); −14 is the streaming standard.
  loudnessTargetLufs: { min: -23, max: -9, type: 'float' },
  // 0 disables boosting entirely (cut-only levelling); 12 dB is plenty — the
  // per-track peak headroom cap bites long before that on dynamic material.
  loudnessMaxBoostDb: { min: 0, max: 12, type: 'float' },
};

const MP3_BITRATE_SET = new Set<number>(MP3_BITRATES);
const OPUS_BITRATE_SET = new Set<number>(OPUS_BITRATES);
const AAC_BITRATE_SET = new Set<number>(AAC_BITRATES);

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
function normalizeSkills(raw: unknown) {
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

function normalizeTts(raw: unknown) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const engine = TTS_ENGINES.includes(r.engine as string) ? (r.engine as string) : 'piper';
  const cloudProvider = TTS_CLOUD_PROVIDERS.includes(r.cloudProvider as string)
    ? (r.cloudProvider as string)
    : 'openai';
  let voice =
    typeof r.voice === 'string' && r.voice.trim() ? r.voice.trim().slice(0, 100) : '';
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
  // field and the server picks its own. Remote engine voices likewise:
  // server-specific (id, reference-wav filename, or VoiceDesign prompt), no
  // Subwave-side default.
  if (!voice && engine === 'cloud' && cloudProvider !== 'openai-compatible') voice = 'alloy';
  if (!voice && engine !== 'cloud' && engine !== 'chatterbox' && engine !== 'piper' && engine !== 'remote') voice = 'bf_isabella';
  return { engine, cloudProvider, voice, gainDb: clampTtsGain(r.gainDb), speed: clampTtsSpeed(r.speed) };
}

function normalizePersona(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
  const soul = typeof r.soul === 'string' ? r.soul.trim().slice(0, 1000) : '';
  if (!name || !soul) return null;
  // Avatar — stored as a bare basename. Reset to '' if the persisted value
  // doesn't match the strict basename shape, so a hand-edited settings.json
  // can never point /persona-avatar/:id at an arbitrary path.
  const rawAvatar = typeof r.avatar === 'string' ? r.avatar.trim() : '';
  const avatar = rawAvatar && AVATAR_FILENAME_RE.test(rawAvatar) ? rawAvatar : '';
  return {
    id: typeof r.id === 'string' && ID_RE.test(r.id) ? r.id : mintId('p_'),
    name,
    tagline: typeof r.tagline === 'string' ? r.tagline.trim().slice(0, 80) : '',
    frequency: FREQUENCIES.includes(r.frequency as string) ? (r.frequency as string) : 'moderate',
    scriptLength: SCRIPT_LENGTHS.includes(r.scriptLength as string) ? (r.scriptLength as string) : 'concise',
    djMode: r.djMode === true,
    humour: normalizeDial(r.humour),
    localColour: normalizeDial(r.localColour),
    warmth: normalizeDial(r.warmth),
    soul,
    language: typeof r.language === 'string' ? r.language.trim().slice(0, 60) : '',
    avatar,
    tts: normalizeTts(r.tts),
    skills: normalizeSkills(r.skills),
  };
}

function normalizePersonaArray(raw: unknown) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: NonNullable<ReturnType<typeof normalizePersona>>[] = [];
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

// Lenient load-time path for the prompt-template library: drop entries that
// can't render (bad text) rather than failing the whole settings load. A
// missing/duplicate name degrades to "Prompt N" instead of dropping the entry —
// the text is the part the operator can't afford to lose.
function normalizeDjPrompts(raw: unknown): DjPromptEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DjPromptEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (text.length < DJ_PROMPT_TEXT_MIN || text.length > DJ_PROMPT_TEXT_MAX) continue;
    if (!text.includes('{name}')) continue;
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('dp_');
    if (seen.has(id)) id = mintId('dp_');
    seen.add(id);
    const name =
      (typeof item.name === 'string' ? item.name.trim().slice(0, DJ_PROMPT_NAME_MAX) : '') ||
      `Prompt ${out.length + 1}`;
    out.push({ id, name, text });
    if (out.length >= DJ_PROMPT_LIMIT) break;
  }
  return out;
}

function normalizeShows(raw: unknown, personaIds: string[]): NormalizedShow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NormalizedShow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 60) : '';
    if (!name) continue;
    if (!personaIds.includes(item.personaId)) continue; // drop dangling owner
    // Empty moods = "Any" (the autonomous mood applies on air). Unknown mood
    // strings are dropped rather than failing the whole show. Multi-value
    // (#929): plural arrays are canonical; legacy singular fields migrate to
    // one-element lists here (coerceShow* handle both shapes).
    const moods = coerceShowMoods(item);
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
    // Optional music-steering filters (soft lean, applied at pick time). Each
    // is a LIST — OR within the attribute, AND across attributes (#929).
    // Genres are free text resolved fuzzily against the live library when a
    // pick is made (mirrors the listener-request path) — never validated
    // against Subsonic here. Eras are decade/year windows. Energies come from
    // the tagger's three bands. All default to "no constraint" (empty list).
    const genres = coerceShowGenres(item);
    const eras = coerceShowEras(item);
    const energies = coerceShowEnergies(item);
    // Opt-in: hard-filter the pick pool to EVERY set music filter (mood, genre,
    // era, energy) instead of the default soft leans. Only meaningful when at
    // least one filter is set; defaults OFF. The legacy genre-only `genreStrict`
    // is deliberately NOT carried over: the toggle now spans every filter, so
    // auto-migrating an old genre-strict show would silently harden mood/era/
    // energy too. Old shows come back soft; the operator re-opts into strict.
    const filtersStrict = item.filtersStrict === true;
    // Per-show track-length override (seconds). null = inherit the station-wide
    // maxTrackSeconds; 0 = unlimited (opt this show back out of the cap so a
    // long-form mix show can air hour-long sets); >0 = this show's own cap.
    const maxTrackSeconds = coerceMaxTrackSeconds(rawMaxTrackSec(item), true);
    // Optional Navidrome playlist anchor — the union of these playlists becomes
    // the show's candidate pool. playlistStrict (default off) makes the playlist
    // the show's ENTIRE universe; soft just lets it dominate. Both default empty
    // so existing shows are byte-for-byte unchanged.
    const playlistIds = coercePlaylistIds(item.playlistIds);
    const playlistStrict = item.playlistStrict === true;
    // Optional Navidrome playlist blocklist — tracks from these playlists are
    // excluded from the candidate pool. Empty = no exclusions.
    const excludedPlaylistIds = coerceExcludedPlaylistIds(item.excludedPlaylistIds);
    // Optional guest co-hosts. Lenient path: dangling persona ids (persona
    // deleted under our feet) and the host itself are silently dropped so the
    // show survives with whatever roster is still real.
    const guestPersonaIds = coerceGuestPersonaIds(item.guestPersonaIds, item.personaId, personaIds);
    // Scripted banter breaks (multi-voice exchanges). Only meaningful with
    // guests — stored as given, checked against the live roster at air time.
    const banter = item.banter === true;
    // Programme mode: the show airs as a produced episode (intro → feature →
    // outro arc — broadcast/programme.ts). segmentSkill optionally pins the
    // feature beat to one segment capability kind; free text, resolved against
    // the live skill catalog at air time (a stale kind degrades to the
    // producer's choice, same tolerance as playlistIds).
    const programme = item.programme === true;
    const segmentSkill = typeof item.segmentSkill === 'string' ? item.segmentSkill.trim().slice(0, 64) : '';
    out.push({
      id,
      name,
      topic: typeof item.topic === 'string' ? item.topic.trim().slice(0, 1000) : '',
      personaId: item.personaId,
      guestPersonaIds,
      banter,
      programme,
      segmentSkill,
      moods,
      themeId,
      genres,
      eras,
      energies,
      filtersStrict,
      maxTrackSeconds,
      playlistIds,
      playlistStrict,
      excludedPlaylistIds,
    });
    if (out.length >= SHOWS_LIMIT) break;
  }
  return out;
}

function normalizeSchedule(raw: unknown, showIds: string[]) {
  const week = emptyWeek();
  if (!raw || typeof raw !== 'object') return week;
  const r = raw as Record<number, unknown>;
  for (let d = 0; d < 7; d++) {
    const day = r[d];
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

  // Prompt-template library. A pre-library settings.json (single custom
  // djPrompt, no djPrompts array) migrates that custom text into a lone
  // library entry so the operator finds their prompt where the UI now lives.
  let djPrompts = normalizeDjPrompts(stored.djPrompts);
  let activeDjPromptId =
    typeof stored.activeDjPromptId === 'string' ? stored.activeDjPromptId : '';
  if (!djPrompts.length && djPrompt.trim()) {
    djPrompts = [{ id: mintId('dp_'), name: 'Custom prompt', text: djPrompt.trim() }];
    activeDjPromptId = djPrompts[0].id;
  }
  // Dangling active id (hand-edited file) falls back to the built-in default.
  if (activeDjPromptId && !djPrompts.some(p => p.id === activeDjPromptId)) {
    activeDjPromptId = '';
  }
  // djPrompt is always the resolved active text — see DEFAULTS.
  djPrompt = djPrompts.find(p => p.id === activeDjPromptId)?.text ?? '';

  const shows = normalizeShows(stored.shows, personaIds);
  const schedule = normalizeSchedule(
    stored.schedule,
    shows.map(s => s.id),
  );

  const archiveBitrate =
    typeof stored.archive?.bitrate === 'number' && MP3_BITRATE_SET.has(stored.archive.bitrate)
      ? stored.archive.bitrate
      : DEFAULTS.archive.bitrate;

  cache = {
    jingleRatio: stored.jingleRatio ?? DEFAULTS.jingleRatio,
    crossfadeDuration: stored.crossfadeDuration ?? DEFAULTS.crossfadeDuration,
    maxTrackSeconds: coerceMaxTrackSeconds(rawMaxTrackSec(stored), false) ?? DEFAULTS.maxTrackSeconds,
    archive: {
      enabled:
        typeof stored.archive?.enabled === 'boolean'
          ? stored.archive.enabled
          : DEFAULTS.archive.enabled,
      bitrate: archiveBitrate,
      retentionDays:
        Number.isInteger(stored.archive?.retentionDays) && stored.archive.retentionDays >= 0
          ? stored.archive.retentionDays
          : DEFAULTS.archive.retentionDays,
    },
    stream: {
      opusEnabled:
        typeof stored.stream?.opusEnabled === 'boolean'
          ? stored.stream.opusEnabled
          : DEFAULTS.stream.opusEnabled,
      opusBitrate:
        typeof stored.stream?.opusBitrate === 'number' &&
        OPUS_BITRATE_SET.has(stored.stream.opusBitrate)
          ? stored.stream.opusBitrate
          : DEFAULTS.stream.opusBitrate,
      flacEnabled:
        typeof stored.stream?.flacEnabled === 'boolean'
          ? stored.stream.flacEnabled
          : DEFAULTS.stream.flacEnabled,
      aacEnabled:
        typeof stored.stream?.aacEnabled === 'boolean'
          ? stored.stream.aacEnabled
          : DEFAULTS.stream.aacEnabled,
      aacBitrate:
        typeof stored.stream?.aacBitrate === 'number' &&
        AAC_BITRATE_SET.has(stored.stream.aacBitrate)
          ? stored.stream.aacBitrate
          : DEFAULTS.stream.aacBitrate,
      bitrate:
        typeof stored.stream?.bitrate === 'number' && MP3_BITRATE_SET.has(stored.stream.bitrate)
          ? stored.stream.bitrate
          : DEFAULTS.stream.bitrate,
    },
    loudness: {
      targetLufs:
        typeof stored.loudness?.targetLufs === 'number' &&
        stored.loudness.targetLufs >= BOUNDS.loudnessTargetLufs.min &&
        stored.loudness.targetLufs <= BOUNDS.loudnessTargetLufs.max
          ? stored.loudness.targetLufs
          : DEFAULTS.loudness.targetLufs,
      maxBoostDb:
        typeof stored.loudness?.maxBoostDb === 'number' &&
        stored.loudness.maxBoostDb >= BOUNDS.loudnessMaxBoostDb.min &&
        stored.loudness.maxBoostDb <= BOUNDS.loudnessMaxBoostDb.max
          ? stored.loudness.maxBoostDb
          : DEFAULTS.loudness.maxBoostDb,
      source: LOUDNESS_SOURCES.includes(stored.loudness?.source)
        ? (stored.loudness.source as LoudnessSource)
        : DEFAULTS.loudness.source,
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
    djPrompts,
    activeDjPromptId,
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
    // Festivals loaded from settings.json. Seeded from FESTIVAL_DEFAULTS only
    // when the key is absent/invalid — a persisted empty array means the
    // operator deleted every entry and must stay empty (calendar off).
    festivals: Array.isArray(stored.festivals) ? stored.festivals : FESTIVAL_DEFAULTS,
    ui: {
      boothBuddy:
        typeof stored.ui?.boothBuddy === 'boolean'
          ? stored.ui.boothBuddy
          : DEFAULTS.ui.boothBuddy,
      skin:
        typeof stored.ui?.skin === 'string' && stored.ui.skin.trim()
          ? stored.ui.skin.trim()
          : DEFAULTS.ui.skin,
      tuneInOverlay:
        typeof stored.ui?.tuneInOverlay === 'boolean'
          ? stored.ui.tuneInOverlay
          : DEFAULTS.ui.tuneInOverlay,
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
        lang:
          typeof stored.tts?.kokoro?.lang === 'string' &&
          KOKORO_LANG_RE.test(stored.tts.kokoro.lang)
            ? stored.tts.kokoro.lang
            : DEFAULTS.tts.kokoro.lang,
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
        // ElevenLabs voice_settings — clamped to [0,1] on load so a hand-edited
        // settings.json can't ship an out-of-range value to the provider (which
        // would 400 the whole speak call, silently dropping the voice).
        voiceStability:
          typeof stored.tts?.cloud?.voiceStability === 'number'
            ? clamp01(stored.tts.cloud.voiceStability)
            : DEFAULTS.tts.cloud.voiceStability,
        voiceStyle:
          typeof stored.tts?.cloud?.voiceStyle === 'number'
            ? clamp01(stored.tts.cloud.voiceStyle)
            : DEFAULTS.tts.cloud.voiceStyle,
        voiceSimilarityBoost:
          typeof stored.tts?.cloud?.voiceSimilarityBoost === 'number'
            ? clamp01(stored.tts.cloud.voiceSimilarityBoost)
            : DEFAULTS.tts.cloud.voiceSimilarityBoost,
        voiceUseSpeakerBoost:
          typeof stored.tts?.cloud?.voiceUseSpeakerBoost === 'boolean'
            ? stored.tts.cloud.voiceUseSpeakerBoost
            : DEFAULTS.tts.cloud.voiceUseSpeakerBoost,
      },
      remote: {
        url:
          typeof stored.tts?.remote?.url === 'string'
            ? stored.tts.remote.url.trim()
            : DEFAULTS.tts.remote.url,
      },
      // Per-engine gain map — one clean gain per known engine, missing keys → 0,
      // unknown keys dropped. So an older save (no gainDb) loads at unity.
      gainDb: normalizeTtsGainMap(stored.tts?.gainDb),
      // Per-engine speed map — one clean multiplier per known engine, missing
      // keys → 1.0, unknown keys dropped. An older save (no speed) loads at unity.
      speed: normalizeTtsSpeedMap(stored.tts?.speed),
      // Operator speech corrections — malformed entries dropped, list capped.
      // An older save (no corrections) loads as [].
      corrections: normalizeTtsCorrections(stored.tts?.corrections),
    },
    llm: {
      provider: LLM_PROVIDERS.includes(stored.llm?.provider)
        ? stored.llm.provider
        : DEFAULTS.llm.provider,
      model: typeof stored.llm?.model === 'string' ? stored.llm.model.trim() : DEFAULTS.llm.model,
      // Legacy single slot is migrated into `keys` below, then cleared — there
      // is exactly one source of truth for inline keys (issue #657).
      apiKey: '',
      keys: normalizeLlmKeys(stored.llm),
      ollamaUrl:
        typeof stored.llm?.ollamaUrl === 'string'
          ? stored.llm.ollamaUrl.trim()
          : DEFAULTS.llm.ollamaUrl,
      baseUrl:
        typeof stored.llm?.baseUrl === 'string' ? stored.llm.baseUrl.trim() : DEFAULTS.llm.baseUrl,
      reasoning:
        typeof stored.llm?.reasoning === 'boolean' ? stored.llm.reasoning : DEFAULTS.llm.reasoning,
      // Only 'auto' downgrades the forced tool_choice; anything else (incl. a
      // pre-field settings.json) lands on the 'required' default. See issue #570.
      toolChoice: stored.llm?.toolChoice === 'auto' ? 'auto' : DEFAULTS.llm.toolChoice,
      // Clamp to a sane band: 0 disables (Ollama default), else [2048, 131072].
      // Non-numeric/NaN falls back to the default. Floored to an integer.
      numCtx: clampNumCtx(stored.llm?.numCtx, DEFAULTS.llm.numCtx),
      pickerAgent:
        typeof stored.llm?.pickerAgent === 'boolean'
          ? stored.llm.pickerAgent
          : DEFAULTS.llm.pickerAgent,
      // Clamped to [0, 290] (≤ the 300-entry sidecar cap); pre-field
      // settings.json picks up the config/env-seeded default.
      noRepeatWindow: clampNoRepeatWindow(stored.llm?.noRepeatWindow, DEFAULTS.llm.noRepeatWindow),
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
      // Budget cap — settings.json files from before these fields existed pick
      // up the defaults (0 = disabled, so they behave exactly as before).
      dailyTokenCap: clampDailyTokenCap(stored.llm?.dailyTokenCap, DEFAULTS.llm.dailyTokenCap),
      budgetSoftPct: clampBudgetSoftPct(stored.llm?.budgetSoftPct, DEFAULTS.llm.budgetSoftPct),
      // Per-call output cap (issue #712) — pre-existing settings.json lacks the
      // field and picks up the 0 default (= built-in per-strategy defaults).
      maxOutputTokens: clampMaxOutputTokens(stored.llm?.maxOutputTokens, DEFAULTS.llm.maxOutputTokens),
      exemptRequests:
        typeof stored.llm?.exemptRequests === 'boolean'
          ? stored.llm.exemptRequests
          : DEFAULTS.llm.exemptRequests,
      debugRawRequests:
        typeof stored.llm?.debugRawRequests === 'boolean'
          ? stored.llm.debugRawRequests
          : DEFAULTS.llm.debugRawRequests,
      // Backup leg — same connection fields as the primary, coerced identically.
      fallback: (() => {
        const fb = stored.llm?.fallback || {};
        return {
          enabled: typeof fb.enabled === 'boolean' ? fb.enabled : DEFAULTS.llm.fallback.enabled,
          provider: LLM_PROVIDERS.includes(fb.provider)
            ? fb.provider
            : DEFAULTS.llm.fallback.provider,
          model: typeof fb.model === 'string' ? fb.model.trim() : DEFAULTS.llm.fallback.model,
          // Legacy fallback slot migrated into settings.llm.keys above, then
          // cleared. The fallback resolves its key from `keys[fb.provider]`.
          apiKey: '',
          ollamaUrl:
            typeof fb.ollamaUrl === 'string' ? fb.ollamaUrl.trim() : DEFAULTS.llm.fallback.ollamaUrl,
          baseUrl:
            typeof fb.baseUrl === 'string' ? fb.baseUrl.trim() : DEFAULTS.llm.fallback.baseUrl,
          reasoning:
            typeof fb.reasoning === 'boolean' ? fb.reasoning : DEFAULTS.llm.fallback.reasoning,
          toolChoice: fb.toolChoice === 'auto' ? 'auto' : DEFAULTS.llm.fallback.toolChoice,
          numCtx: clampNumCtx(fb.numCtx, DEFAULTS.llm.fallback.numCtx),
        };
      })(),
    },
    search: {
      provider: SEARCH_PROVIDERS.includes(stored.search?.provider)
        ? stored.search.provider
        : DEFAULTS.search.provider,
      apiKey: typeof stored.search?.apiKey === 'string' ? stored.search.apiKey : '',
      baseUrl: typeof stored.search?.baseUrl === 'string' ? stored.search.baseUrl : DEFAULTS.search.baseUrl,
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
      apiKey:
        typeof stored.embedding?.apiKey === 'string'
          ? stored.embedding.apiKey.trim()
          : DEFAULTS.embedding.apiKey,
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
      audioFusionWeight:
        Number.isFinite(stored.embedding?.audioFusionWeight)
          ? clamp01(stored.embedding.audioFusionWeight)
          : DEFAULTS.embedding.audioFusionWeight,
      batchSize:
        Number.isFinite(stored.embedding?.batchSize) && stored.embedding.batchSize >= 1
          ? Math.max(1, Math.min(50, Math.floor(stored.embedding.batchSize)))
          : DEFAULTS.embedding.batchSize,
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
    webhooksPolicy: {
      trackPlayListenerGated:
        typeof stored.webhooksPolicy?.trackPlayListenerGated === 'boolean'
          ? stored.webhooksPolicy.trackPlayListenerGated
          : DEFAULTS.webhooksPolicy.trackPlayListenerGated,
    },
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
        baseUrl:
          typeof stored.scrobble?.listenbrainz?.baseUrl === 'string'
            ? stored.scrobble.listenbrainz.baseUrl.trim().slice(0, 500)
            : '',
      },
    },
    likes: {
      enabled:
        typeof stored.likes?.enabled === 'boolean'
          ? stored.likes.enabled
          : DEFAULTS.likes.enabled,
      starInNavidrome:
        typeof stored.likes?.starInNavidrome === 'boolean'
          ? stored.likes.starInNavidrome
          : DEFAULTS.likes.starInNavidrome,
      influenceDj:
        typeof stored.likes?.influenceDj === 'boolean'
          ? stored.likes.influenceDj
          : DEFAULTS.likes.influenceDj,
      maxTracks: Number.isFinite(Number(stored.likes?.maxTracks))
        ? Math.min(25, Math.max(1, Math.round(Number(stored.likes.maxTracks))))
        : DEFAULTS.likes.maxTracks,
      windowDays: Number.isFinite(Number(stored.likes?.windowDays))
        ? Math.min(365, Math.max(0, Math.round(Number(stored.likes.windowDays))))
        : DEFAULTS.likes.windowDays,
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
function normalizeWebhooks(raw: unknown): Webhook[] {
  if (!Array.isArray(raw)) return [];
  const out: Webhook[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!/^https?:\/\//.test(url) || url.length > 500) continue;
    const events = Array.isArray(item.events)
      ? item.events.filter((e: string) => WEBHOOK_EVENTS.includes(e))
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

// Resolve the operator-entered inline API key for a provider from the
// per-provider map (issue #657). Returns '' when none is stored, in which case
// the registry/embedding layer falls through to the provider's env var
// (OPENROUTER_API_KEY etc.) exactly as before. This is the single resolution
// chokepoint — leg assembly (registry.llmCfg / legs.fallbackLeg) and the
// openai-compatible probe/discovery routes all go through it.
export function llmKeyFor(provider: string): string {
  const keys = get().llm?.keys || {};
  const v = keys[provider];
  return typeof v === 'string' ? v : '';
}

// Settings with secret fields masked — for the admin /settings response.
export function getRedacted() {
  const s = get();
  const clone = JSON.parse(JSON.stringify(s));
  if (clone.llm) {
    clone.llm.apiKey = s.llm?.apiKey ? 'set' : '';
    // Per-provider inline keys masked to 'set' | '' per entry, so the admin UI
    // can show which providers have a key on file without exposing the value.
    clone.llm.keys = {};
    for (const p of Object.keys(s.llm?.keys || {})) {
      clone.llm.keys[p] = s.llm.keys[p] ? 'set' : '';
    }
  }
  if (clone.llm?.fallback) clone.llm.fallback.apiKey = s.llm?.fallback?.apiKey ? 'set' : '';
  if (clone.tts?.cloud) clone.tts.cloud.apiKey = s.tts?.cloud?.apiKey ? 'set' : '';
  if (clone.search) clone.search.apiKey = s.search?.apiKey ? 'set' : '';
  if (clone.embedding) clone.embedding.apiKey = s.embedding?.apiKey ? 'set' : '';
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
  } else if (t.engine === 'remote') {
    // Remote engine voices are server-specific — the sidecar interprets them
    // (built-in id, reference-wav filename, or VoiceDesign prompt). Empty is
    // valid: the sidecar picks its own default.
    if (voice.length > 100) throw new Error(`${where}.tts.voice must be 0-100 chars`);
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
  return { engine: t.engine, cloudProvider: t.cloudProvider, voice, gainDb: clampTtsGain(t.gainDb), speed: clampTtsSpeed(t.speed) };
}

// Strict update-time path for the prompt-template library — any bad entry
// rejects the whole patch so the operator sees the error instead of silently
// losing a prompt.
export function validateDjPromptsStrict(raw) {
  if (!Array.isArray(raw) || raw.length > DJ_PROMPT_LIMIT) {
    throw new Error(`djPrompts must be an array of 0-${DJ_PROMPT_LIMIT} entries`);
  }
  const seen = new Set();
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`djPrompts[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > DJ_PROMPT_NAME_MAX) {
      throw new Error(`djPrompts[${i}].name must be 1-${DJ_PROMPT_NAME_MAX} chars`);
    }
    const text = String(item.text ?? '').trim();
    if (text.length < DJ_PROMPT_TEXT_MIN || text.length > DJ_PROMPT_TEXT_MAX) {
      throw new Error(
        `djPrompts[${i}].text must be ${DJ_PROMPT_TEXT_MIN}-${DJ_PROMPT_TEXT_MAX} chars`,
      );
    }
    if (!text.includes('{name}')) {
      throw new Error(`djPrompts[${i}].text must contain the {name} placeholder`);
    }
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('dp_');
    if (seen.has(id)) id = mintId('dp_');
    seen.add(id);
    return { id, name, text };
  });
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
    if (soul.length < 1 || soul.length > 1000)
      throw new Error(`personas[${i}].soul must be 1-1000 chars`);
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
    // Empty/missing moods means "Any": the show pins no mood and the autonomous
    // dominantMood chain (festival > weather > time) applies while it's on air.
    // Multi-value (#929): the plural array is canonical; a legacy singular
    // `mood` from an older client still validates and becomes a one-element
    // list. Every entry must come from the canonical vocabulary.
    const rawMoods = Array.isArray(item.moods)
      ? item.moods
      : item.mood == null || item.mood === '' ? [] : [item.mood];
    if (rawMoods.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].moods must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    for (const m of rawMoods) {
      if (typeof m !== 'string' || !SHOW_MOODS.includes(m)) {
        throw new Error(`shows[${i}].moods entries must be one of: ${SHOW_MOODS.join(', ')}`);
      }
    }
    const moods = coerceShowMoods({ moods: rawMoods });
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
    // Optional music-steering filters — all default to "no constraint" and all
    // multi-value lists (#929, legacy singular fields still accepted). Genres
    // are free text resolved fuzzily at pick time, so they aren't checked
    // against the live library here.
    // Legacy singular `genre` splits on commas — same rule as the load-path
    // migration (operators crammed "funk, soul" into the one field).
    const rawGenres = Array.isArray(item.genres)
      ? item.genres
      : item.genre == null || String(item.genre).trim() === '' ? [] : String(item.genre).split(',');
    // Cap-check only the explicit plural form; a legacy comma-crammed string
    // is silently capped by the coercer instead of failing an old client.
    if (Array.isArray(item.genres) && item.genres.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].genres must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    for (const g of rawGenres) {
      if (typeof g !== 'string') throw new Error(`shows[${i}].genres entries must be strings`);
      if (g.trim().length > 64) throw new Error(`shows[${i}].genres entries must be 0-64 chars`);
    }
    const genres = coerceShowGenres({ genres: rawGenres });
    const rawEnergies = Array.isArray(item.energies)
      ? item.energies
      : item.energy == null || item.energy === '' ? [] : [item.energy];
    for (const e of rawEnergies) {
      if (typeof e !== 'string' || !SHOW_ENERGY.includes(e)) {
        throw new Error(`shows[${i}].energies entries must be one of: ${SHOW_ENERGY.join(', ')}`);
      }
    }
    const energies = coerceShowEnergies({ energies: rawEnergies });
    // Opt-in hard filter across every set music constraint — mood, genre, era,
    // energy (vs the default soft leans). Boolean, defaults OFF. The legacy
    // genre-only `genreStrict` is deliberately NOT carried over (see the load
    // path): the toggle now spans every filter, so migrating it would silently
    // harden mood/era/energy an old show never opted into.
    const filtersStrict = item.filtersStrict === true;
    const parseYear = (v, field) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1900 || n > 2100) {
        throw new Error(`shows[${i}].${field} must be an integer between 1900 and 2100`);
      }
      return n;
    };
    // Era windows: `eras` is a list of { fromYear, toYear } windows (#929);
    // legacy top-level fromYear/toYear still validate as a one-window list.
    // Each window needs at least one bound; both-null entries are dropped.
    const rawEras = Array.isArray(item.eras)
      ? item.eras
      : item.fromYear == null && item.toYear == null ? [] : [{ fromYear: item.fromYear, toYear: item.toYear }];
    if (rawEras.length > SHOW_FILTER_VALUES_MAX) {
      throw new Error(`shows[${i}].eras must have at most ${SHOW_FILTER_VALUES_MAX} entries`);
    }
    const eras: EraWindow[] = [];
    for (const [j, w] of rawEras.entries()) {
      if (!w || typeof w !== 'object') throw new Error(`shows[${i}].eras[${j}] must be an object`);
      const fromYear = parseYear((w as Record<string, unknown>).fromYear, `eras[${j}].fromYear`);
      const toYear = parseYear((w as Record<string, unknown>).toYear, `eras[${j}].toYear`);
      if (fromYear == null && toYear == null) continue;
      if (fromYear != null && toYear != null && fromYear > toYear) {
        throw new Error(`shows[${i}].eras[${j}].fromYear must be <= toYear`);
      }
      if (!eras.some(e => e.fromYear === fromYear && e.toYear === toYear)) {
        eras.push({ fromYear, toYear });
      }
    }
    // Per-show track-length override (seconds): null = inherit station default,
    // 0 = unlimited, >0 = own cap. Empty/missing → inherit. A legacy minutes
    // value from a stale client is migrated (×60) before bounds-checking.
    let maxTrackSeconds: number | null = null;
    const rawSec = rawMaxTrackSec(item);
    if (rawSec != null && rawSec !== '') {
      const n = Number(rawSec);
      if (!Number.isInteger(n) || n < BOUNDS.maxTrackSeconds.min || n > BOUNDS.maxTrackSeconds.max) {
        throw new Error(
          `shows[${i}].maxTrackSeconds must be an integer between ${BOUNDS.maxTrackSeconds.min} and ${BOUNDS.maxTrackSeconds.max}`,
        );
      }
      // Same crossfade-relative floor as the station cap (0 = inherit/unlimited
      // stays allowed). Shows have no own crossfade, so it's the station value.
      const floor = minTrackSeconds();
      if (n !== 0 && n < floor) {
        throw new Error(
          `shows[${i}].maxTrackSeconds must be 0 (inherit/unlimited) or at least ${floor}s`,
        );
      }
      maxTrackSeconds = n;
    }
    // Optional Navidrome playlist anchor. Shape-checked only (array of strings,
    // capped) — ids are resolved against the live Navidrome at pick time, never
    // here, so a stale id is tolerated. playlistStrict is a plain boolean.
    let playlistIds: string[] = [];
    if (item.playlistIds !== undefined && item.playlistIds !== null) {
      if (!Array.isArray(item.playlistIds)) {
        throw new Error(`shows[${i}].playlistIds must be an array of strings`);
      }
      if (item.playlistIds.length > PLAYLISTS_PER_SHOW) {
        throw new Error(`shows[${i}].playlistIds must have at most ${PLAYLISTS_PER_SHOW} entries`);
      }
      for (const v of item.playlistIds) {
        if (typeof v !== 'string') throw new Error(`shows[${i}].playlistIds entries must be strings`);
      }
      playlistIds = coercePlaylistIds(item.playlistIds);
    }
    const playlistStrict = item.playlistStrict === true;
    // Optional Navidrome playlist blocklist. Shape-checked only — same rules as
    // playlistIds; stale ids contribute nothing at pick time.
    let excludedPlaylistIds: string[] = [];
    if (item.excludedPlaylistIds !== undefined && item.excludedPlaylistIds !== null) {
      if (!Array.isArray(item.excludedPlaylistIds)) {
        throw new Error(`shows[${i}].excludedPlaylistIds must be an array of strings`);
      }
      if (item.excludedPlaylistIds.length > EXCLUDED_PLAYLISTS_PER_SHOW) {
        throw new Error(`shows[${i}].excludedPlaylistIds must have at most ${EXCLUDED_PLAYLISTS_PER_SHOW} entries`);
      }
      for (const v of item.excludedPlaylistIds) {
        if (typeof v !== 'string') throw new Error(`shows[${i}].excludedPlaylistIds entries must be strings`);
      }
      excludedPlaylistIds = coerceExcludedPlaylistIds(item.excludedPlaylistIds);
    }
    // Optional guest co-hosts. Strict path: unknown personas and a guest that
    // duplicates the host are operator mistakes worth surfacing, not dropping.
    let guestPersonaIds: string[] = [];
    if (item.guestPersonaIds !== undefined && item.guestPersonaIds !== null) {
      if (!Array.isArray(item.guestPersonaIds)) {
        throw new Error(`shows[${i}].guestPersonaIds must be an array of persona ids`);
      }
      if (item.guestPersonaIds.length > GUESTS_PER_SHOW) {
        throw new Error(`shows[${i}].guestPersonaIds must have at most ${GUESTS_PER_SHOW} entries`);
      }
      for (const v of item.guestPersonaIds) {
        if (typeof v !== 'string' || !personaIds.includes(v)) {
          throw new Error(`shows[${i}].guestPersonaIds must reference existing personas`);
        }
        if (v === item.personaId) {
          throw new Error(`shows[${i}].guestPersonaIds must not include the show's host persona`);
        }
      }
      guestPersonaIds = coerceGuestPersonaIds(item.guestPersonaIds, item.personaId, personaIds);
    }
    // Banter without guests is inert, not an error — the tick re-checks the
    // live roster anyway, so a stale true can't air a one-person "exchange".
    const banter = item.banter === true;
    // Programme mode + optional feature-beat capability pin. The kind is
    // shape-checked only — resolved against the live skill catalog at air time,
    // so a stale/misspelled kind degrades instead of blocking a settings save.
    const programme = item.programme === true;
    const segmentSkill = String(item.segmentSkill ?? '').trim();
    if (segmentSkill.length > 64) throw new Error(`shows[${i}].segmentSkill must be 0-64 chars`);
    let id = typeof item.id === 'string' && ID_RE.test(item.id) ? item.id : mintId('s_');
    if (seen.has(id)) id = mintId('s_');
    seen.add(id);
    return { id, name, topic, personaId: item.personaId, guestPersonaIds, banter, programme, segmentSkill, moods, themeId, genres, eras, energies, filtersStrict, maxTrackSeconds, playlistIds, playlistStrict, excludedPlaylistIds };
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
function validateWebhooksStrict(raw: unknown, existing: Webhook[] = []) {
  if (!Array.isArray(raw)) throw new Error('webhooks must be an array');
  if (raw.length > WEBHOOKS_LIMIT) {
    throw new Error(`webhooks must be at most ${WEBHOOKS_LIMIT} entries`);
  }
  const byId = new Map(existing.map((h) => [h.id, h] as const));
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

const FESTIVALS_LIMIT = 50;

function validateFestivalsStrict(raw) {
  if (!Array.isArray(raw)) throw new Error('festivals must be an array');
  if (raw.length > FESTIVALS_LIMIT) {
    throw new Error(`festivals must be at most ${FESTIVALS_LIMIT} entries`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`festivals[${i}] must be an object`);
    const name = String(item.name ?? '').trim();
    if (name.length < 1 || name.length > 80) throw new Error(`festivals[${i}].name must be 1-80 chars`);
    const month = Number(item.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error(`festivals[${i}].month must be an integer 1-12`);
    }
    const day = Number(item.day);
    // Feb allows 29 — in common years a leap-day festival fires Mar 1
    // (Date.UTC rolls the date over in getFestivalContext).
    const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
      throw new Error(`festivals[${i}].day must be an integer 1-${daysInMonth} for month ${month}`);
    }
    const mood = String(item.mood ?? '').trim();
    if (!SHOW_MOODS.includes(mood)) {
      throw new Error(`festivals[${i}].mood must be one of: ${SHOW_MOODS.join(', ')}`);
    }
    const description = typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '';
    const windowDays = Number(item.windowDays ?? 0);
    if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 14) {
      throw new Error(`festivals[${i}].windowDays must be an integer 0-14`);
    }
    return { month, day, name, mood, description, windowDays };
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
  if ('maxTrackSeconds' in patch || 'maxTrackMinutes' in patch) {
    const v = parseInt(rawMaxTrackSec(patch) as string, 10);
    if (!Number.isFinite(v) || v < BOUNDS.maxTrackSeconds.min || v > BOUNDS.maxTrackSeconds.max) {
      throw new Error(
        `maxTrackSeconds must be int in [${BOUNDS.maxTrackSeconds.min}, ${BOUNDS.maxTrackSeconds.max}]`,
      );
    }
    // Non-zero caps must clear the crossfade-relative floor (0 = unlimited stays
    // allowed): the track crossfades out starting crossfadeDuration before the
    // cap, so a shorter cap is degenerate / leaves no solo airtime. Uses next's
    // crossfade, already applied above if this same patch changed it.
    const floor = minTrackSeconds(next);
    if (v !== 0 && v < floor) {
      throw new Error(
        `maxTrackSeconds must be 0 (no limit) or at least ${floor}s`,
      );
    }
    // Read live by queue.drainToLiquidsoap + the auto-playlist refresh to stamp
    // liq_cue_out; no Liquidsoap file is written, so no restart.
    next.maxTrackSeconds = v;
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
      if (!Number.isFinite(v) || !MP3_BITRATE_SET.has(v)) {
        throw new Error(
          `archive.bitrate must be one of: ${MP3_BITRATES.join(', ')}`,
        );
      }
      if (v !== cur.archive.bitrate) {
        next.archive.bitrate = v;
        restart = true;
      }
    }
    if (a.retentionDays !== undefined) {
      const v = parseInt(a.retentionDays, 10);
      if (!Number.isInteger(v) || v < 0 || v > 3650) {
        throw new Error('archive.retentionDays must be 0 (keep forever) or 1–3650 days');
      }
      // Enforced controller-side (scheduler cleanup), no Liquidsoap file or
      // restart involved.
      next.archive.retentionDays = v;
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
    if (st.opusBitrate !== undefined) {
      const v = parseInt(st.opusBitrate, 10);
      if (!Number.isFinite(v) || !OPUS_BITRATE_SET.has(v)) {
        throw new Error(
          `stream.opusBitrate must be one of: ${OPUS_BITRATES.join(', ')}`,
        );
      }
      if (v !== cur.stream.opusBitrate) {
        next.stream.opusBitrate = v;
        restart = true;
      }
    }
    if (st.flacEnabled !== undefined) {
      const v = !!st.flacEnabled;
      if (v !== cur.stream.flacEnabled) {
        next.stream.flacEnabled = v;
        restart = true;
      }
    }
    if (st.aacEnabled !== undefined) {
      const v = !!st.aacEnabled;
      if (v !== cur.stream.aacEnabled) {
        next.stream.aacEnabled = v;
        restart = true;
      }
    }
    if (st.aacBitrate !== undefined) {
      const v = parseInt(st.aacBitrate, 10);
      if (!Number.isFinite(v) || !AAC_BITRATE_SET.has(v)) {
        throw new Error(
          `stream.aacBitrate must be one of: ${AAC_BITRATES.join(', ')}`,
        );
      }
      if (v !== cur.stream.aacBitrate) {
        next.stream.aacBitrate = v;
        restart = true;
      }
    }
    if (st.bitrate !== undefined) {
      const v = parseInt(st.bitrate, 10);
      if (!Number.isFinite(v) || !MP3_BITRATE_SET.has(v)) {
        throw new Error(
          `stream.bitrate must be one of: ${MP3_BITRATES.join(', ')}`,
        );
      }
      if (v !== cur.stream.bitrate) {
        next.stream.bitrate = v;
        restart = true;
      }
    }
  }
  if ('loudness' in patch) {
    // Read live by queue.applyLoudnessGain when each track is annotated — no
    // Liquidsoap file, no restart. Applies from the next queued track.
    const lo = patch.loudness || {};
    if (lo.targetLufs !== undefined) {
      const v = parseFloat(lo.targetLufs);
      const b = BOUNDS.loudnessTargetLufs;
      if (!Number.isFinite(v) || v < b.min || v > b.max) {
        throw new Error(`loudness.targetLufs must be number in [${b.min}, ${b.max}]`);
      }
      next.loudness.targetLufs = v;
    }
    if (lo.maxBoostDb !== undefined) {
      const v = parseFloat(lo.maxBoostDb);
      const b = BOUNDS.loudnessMaxBoostDb;
      if (!Number.isFinite(v) || v < b.min || v > b.max) {
        throw new Error(`loudness.maxBoostDb must be number in [${b.min}, ${b.max}]`);
      }
      next.loudness.maxBoostDb = v;
    }
    if (lo.source !== undefined) {
      if (!LOUDNESS_SOURCES.includes(lo.source)) {
        throw new Error(`loudness.source must be one of: ${LOUDNESS_SOURCES.join(', ')}`);
      }
      next.loudness.source = lo.source;
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
  if ('festivals' in patch) {
    next.festivals = validateFestivalsStrict(patch.festivals);
  }
  // Prompt-template library. `djPrompts` replaces the whole library;
  // `activeDjPromptId` switches which entry renders ('' = built-in default).
  // The legacy single-field `djPrompt` (onboarding wizard, older clients)
  // still works by mapping onto the library: '' selects the default, custom
  // text reuses the entry with identical text or appends a "Custom prompt".
  if ('djPrompts' in patch) {
    next.djPrompts = validateDjPromptsStrict(patch.djPrompts);
  }
  if ('activeDjPromptId' in patch) {
    next.activeDjPromptId = String(patch.activeDjPromptId ?? '').trim();
  }
  if ('djPrompt' in patch) {
    const v = String(patch.djPrompt ?? '').trim();
    if (v === '') {
      next.activeDjPromptId = '';
    } else {
      if (v.length < DJ_PROMPT_TEXT_MIN || v.length > DJ_PROMPT_TEXT_MAX) {
        throw new Error(
          `djPrompt must be empty (use the default) or ${DJ_PROMPT_TEXT_MIN}-${DJ_PROMPT_TEXT_MAX} chars`,
        );
      }
      if (!v.includes('{name}')) {
        throw new Error('djPrompt must contain the {name} placeholder');
      }
      let entry = next.djPrompts.find((p: DjPromptEntry) => p.text === v);
      if (!entry) {
        if (next.djPrompts.length >= DJ_PROMPT_LIMIT) {
          throw new Error(`the prompt library is full (${DJ_PROMPT_LIMIT} entries)`);
        }
        entry = { id: mintId('dp_'), name: 'Custom prompt', text: v };
        next.djPrompts.push(entry);
      }
      next.activeDjPromptId = entry.id;
    }
  }
  if ('djPrompts' in patch || 'activeDjPromptId' in patch || 'djPrompt' in patch) {
    if (
      next.activeDjPromptId &&
      !next.djPrompts.some((p: DjPromptEntry) => p.id === next.activeDjPromptId)
    ) {
      if ('activeDjPromptId' in patch || 'djPrompt' in patch) {
        throw new Error('activeDjPromptId must be "" or the id of a djPrompts entry');
      }
      // A library-only patch removed the entry that was active — fall back to
      // the built-in default rather than failing the save.
      next.activeDjPromptId = '';
    }
    // djPrompt stays the resolved active text — the single field readers use.
    next.djPrompt =
      next.djPrompts.find((p: DjPromptEntry) => p.id === next.activeDjPromptId)?.text ?? '';
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
      if (k.lang !== undefined) {
        const v = String(k.lang).trim();
        if (v && !KOKORO_LANG_RE.test(v)) {
          throw new Error(`tts.kokoro.lang must be one of: ${KOKORO_LANGS.join(', ')}`);
        }
        next.tts.kokoro.lang = v;
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
      // ElevenLabs voice_settings — clamped, not rejected. The UI sliders can't
      // produce out-of-range values, so a strict throw would only fire for a
      // hand-crafted payload; clamp so the DJ never goes silent on a typo.
      // Applied for every provider on save so switching provider later
      // preserves the operator's tuning, but only spread into providerOptions
      // in cloud-speech.ts when provider === 'elevenlabs' (see there).
      if (c.voiceStability !== undefined) {
        const n = Number(c.voiceStability);
        next.tts.cloud.voiceStability = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceStability;
      }
      if (c.voiceStyle !== undefined) {
        const n = Number(c.voiceStyle);
        next.tts.cloud.voiceStyle = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceStyle;
      }
      if (c.voiceSimilarityBoost !== undefined) {
        const n = Number(c.voiceSimilarityBoost);
        next.tts.cloud.voiceSimilarityBoost = Number.isFinite(n) ? clamp01(n) : DEFAULTS.tts.cloud.voiceSimilarityBoost;
      }
      if (c.voiceUseSpeakerBoost !== undefined) {
        next.tts.cloud.voiceUseSpeakerBoost = !!c.voiceUseSpeakerBoost;
      }
      // An OpenAI-compatible TTS server has no canonical endpoint — refuse to
      // save the provider without one. Mirrors the LLM-side check below.
      if (next.tts.cloud.provider === 'openai-compatible' && !next.tts.cloud.baseUrl) {
        throw new Error('tts.cloud.baseUrl is required when provider is "openai-compatible"');
      }
    }
    if (t.remote !== undefined) {
      const r = t.remote || {};
      if (r.url !== undefined) {
        const v = String(r.url).trim();
        if (v.length > 200) throw new Error('tts.remote.url must be 0-200 chars');
        if (v) {
          // Full parse (not just a prefix test) so a malformed host/port —
          // e.g. http://host:notaport or http://host:99999 — is rejected at
          // save time instead of silently failing the /health probe later.
          let parsed: URL;
          try {
            parsed = new URL(v);
          } catch {
            throw new Error('tts.remote.url must be a valid http:// or https:// URL');
          }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('tts.remote.url must start with http:// or https://');
          }
        }
        next.tts.remote.url = v.replace(/\/+$/, ''); // strip trailing slashes
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
    if (t.speed !== undefined) {
      if (typeof t.speed !== 'object' || t.speed === null || Array.isArray(t.speed)) {
        throw new Error('tts.speed must be an object keyed by engine');
      }
      for (const key of Object.keys(t.speed)) {
        if (!TTS_ENGINES.includes(key)) {
          throw new Error(`tts.speed has unknown engine "${key}"; must be one of: ${TTS_ENGINES.join(', ')}`);
        }
        next.tts.speed[key] = clampTtsSpeed(t.speed[key]);
      }
    }
    // Whole-array replace, like festivals — the admin UI always sends the
    // full edited list. No restart: read live on every speak() call.
    if (t.corrections !== undefined) {
      next.tts.corrections = validateTtsCorrectionsStrict(t.corrections);
    }
  }
  if ('llm' in patch) {
    const l = patch.llm || {};
    applyLlmLegPatch(next.llm, l, 'llm');
    // Route the primary inline key into keys[provider] AFTER the provider is
    // resolved, so it's stored under the identity it belongs to (issue #657).
    applyInlineKey(next.llm, next.llm.provider, l.apiKey);
    if (l.pickerAgent !== undefined) {
      next.llm.pickerAgent = !!l.pickerAgent;
    }
    if (l.noRepeatWindow !== undefined) {
      next.llm.noRepeatWindow = clampNoRepeatWindow(Number(l.noRepeatWindow), next.llm.noRepeatWindow);
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
    if (l.dailyTokenCap !== undefined) {
      next.llm.dailyTokenCap = clampDailyTokenCap(Number(l.dailyTokenCap), next.llm.dailyTokenCap);
    }
    if (l.budgetSoftPct !== undefined) {
      next.llm.budgetSoftPct = clampBudgetSoftPct(Number(l.budgetSoftPct), next.llm.budgetSoftPct);
    }
    if (l.maxOutputTokens !== undefined) {
      next.llm.maxOutputTokens = clampMaxOutputTokens(Number(l.maxOutputTokens), next.llm.maxOutputTokens);
    }
    if (l.exemptRequests !== undefined) {
      next.llm.exemptRequests = !!l.exemptRequests;
    }
    if (l.debugRawRequests !== undefined) {
      next.llm.debugRawRequests = !!l.debugRawRequests;
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
      // Fallback inline key shares the same per-provider map (keys live at
      // next.llm.keys, not under the fallback) — routed by the fallback's
      // resolved provider.
      applyInlineKey(next.llm, next.llm.fallback.provider, fb.apiKey);
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
    if (sr.baseUrl !== undefined) {
      if (typeof sr.baseUrl !== 'string') throw new Error('search.baseUrl must be a string');
      const trimmed = sr.baseUrl.trim();
      if (trimmed.length > 500) throw new Error('search.baseUrl too long');
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        throw new Error('search.baseUrl must start with http:// or https://');
      }
      next.search.baseUrl = trimmed;
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
    if (e.apiKey !== undefined && e.apiKey !== 'set') {
      const v = String(e.apiKey).trim();
      if (v.length > 200) throw new Error('embedding.apiKey must be 0-200 chars');
      next.embedding.apiKey = v;
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
    if (e.audioFusionWeight !== undefined) {
      const v = parseFloat(e.audioFusionWeight);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error('embedding.audioFusionWeight must be between 0 and 1');
      }
      next.embedding.audioFusionWeight = v;
    }
    // LLM tag batch size — how many tracks per tagging call. Weaker models
    // truncate/error on large batches, so operators can drop this. Clamp kept in
    // sync with the CLI --batch flag + load() normalisation (music/tag-library.ts).
    if (e.batchSize !== undefined) {
      const v = parseInt(e.batchSize, 10);
      if (!Number.isFinite(v) || v < 1 || v > 50) {
        throw new Error('embedding.batchSize must be an integer 1-50');
      }
      next.embedding.batchSize = v;
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
  if ('ui' in patch) {
    const ui = patch.ui || {};
    if (ui.boothBuddy !== undefined) {
      next.ui.boothBuddy = !!ui.boothBuddy;
    }
    if (ui.skin !== undefined) {
      // Slug only — the web registry resolves it and falls back on unknowns,
      // so an invalid value is dropped rather than erroring the whole patch.
      const slug = String(ui.skin).trim().toLowerCase();
      if (/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
        next.ui.skin = slug;
      }
    }
    if (ui.tuneInOverlay !== undefined) {
      next.ui.tuneInOverlay = !!ui.tuneInOverlay;
    }
  }
  if ('webhooks' in patch) {
    next.webhooks = validateWebhooksStrict(patch.webhooks, next.webhooks || []);
  }
  if ('webhooksPolicy' in patch) {
    const wp = patch.webhooksPolicy || {};
    if (wp.trackPlayListenerGated !== undefined) {
      next.webhooksPolicy.trackPlayListenerGated = !!wp.trackPlayListenerGated;
    }
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
      if (lb.baseUrl !== undefined) {
        const trimmed = String(lb.baseUrl ?? '').trim();
        if (trimmed.length > 500) throw new Error('scrobble.listenbrainz.baseUrl too long');
        if (trimmed && !/^https?:\/\//i.test(trimmed)) {
          throw new Error('scrobble.listenbrainz.baseUrl must start with http:// or https://');
        }
        next.scrobble.listenbrainz.baseUrl = trimmed;
      }
    }
  }
  if ('likes' in patch) {
    const lk = patch.likes || {};
    if (lk.enabled !== undefined) next.likes.enabled = !!lk.enabled;
    if (lk.starInNavidrome !== undefined) next.likes.starInNavidrome = !!lk.starInNavidrome;
    if (lk.influenceDj !== undefined) next.likes.influenceDj = !!lk.influenceDj;
    if (lk.maxTracks !== undefined) {
      const n = Math.round(Number(lk.maxTracks));
      if (!Number.isFinite(n) || n < 1 || n > 25) throw new Error('likes.maxTracks must be 1-25');
      next.likes.maxTracks = n;
    }
    if (lk.windowDays !== undefined) {
      const n = Math.round(Number(lk.windowDays));
      if (!Number.isFinite(n) || n < 0 || n > 365) {
        throw new Error('likes.windowDays must be 0-365 (0 = all time)');
      }
      next.likes.windowDays = n;
    }
  }

  // Post-patch integrity sweep — a personas/shows change in this patch may
  // have orphaned a show owner, a schedule slot, or the active persona.
  {
    const personaIds = next.personas.map(p => p.id);
    next.shows = next.shows.filter(s => personaIds.includes(s.personaId));
    // A deleted persona also vanishes from every guest roster (the show itself
    // survives — losing a guest is not losing the show).
    for (const s of next.shows) {
      s.guestPersonaIds = coerceGuestPersonaIds(s.guestPersonaIds, s.personaId, personaIds);
    }
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
      .map((p: { id: string }) => p.id)
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
  // Atomic replace — a crash mid-write must not take the operator's whole
  // config (or show schedule) with it.
  await writeFileAtomic(SETTINGS_PATH, JSON.stringify(settingsPersist, null, 2));
  await writeFileAtomic(
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
    // Optional music-steering filters (soft lean), each a multi-value list
    // (#929): OR within the attribute, AND across attributes. Surfaced for the
    // picker and DJ agent; empty list means "no constraint". The stored shows
    // are already migrated to plural arrays by normalizeShows, but re-coerce
    // here so a stale in-memory shape can never leak singular fields out.
    moods: coerceShowMoods(show),
    genres: coerceShowGenres(show),
    eras: coerceShowEras(show),
    energies: coerceShowEnergies(show),
    // When true, every set music filter (mood, genre, era, energy) is a hard
    // filter on the pick pool instead of a soft lean; off-filter tracks only
    // survive as a never-starve fallback. Defaults off.
    filtersStrict: show.filtersStrict === true,
    // Per-show track-length cap override (seconds). null = inherit the station
    // default; 0 = unlimited; >0 = own cap. See effectiveMaxTrackSec().
    maxTrackSeconds: show.maxTrackSeconds != null ? show.maxTrackSeconds : null,
    // Navidrome playlist anchor: the union of these playlists becomes the show's
    // candidate pool (music/show-playlist.ts). playlistStrict makes it the show's
    // entire universe; soft just lets it dominate. Empty array = no anchor.
    playlistIds: Array.isArray(show.playlistIds) ? show.playlistIds.filter((v: unknown) => typeof v === 'string') : [],
    playlistStrict: show.playlistStrict === true,
    // Navidrome playlist blocklist: tracks in these playlists are hard-dropped
    // from the show's candidate pool (resolveExcludedPlaylistIds reads this off
    // the RESOLVED show, so omitting it here silently disabled the whole
    // feature on every pick path — the #779 blocklist no-op).
    excludedPlaylistIds: Array.isArray(show.excludedPlaylistIds) ? show.excludedPlaylistIds.filter((v: unknown) => typeof v === 'string') : [],
    // Empty string means "fall back to the station-wide default". The route
    // layer is responsible for resolving an empty/stale id against the live
    // theme registry; we just surface what the show declares.
    themeId: typeof show.themeId === 'string' ? show.themeId : '',
    persona: persona
      ? { id: persona.id, name: persona.name, avatar: persona.avatar || '' }
      : null,
    // Guest co-hosts, resolved to live personas (a guest deleted after the
    // show was saved simply vanishes from the roster). Empty = solo show.
    guests: (Array.isArray(show.guestPersonaIds) ? show.guestPersonaIds : [])
      .map(gid => s.personas?.find(p => p.id === gid))
      .filter(Boolean)
      .map(p => ({ id: p.id, name: p.name, avatar: p.avatar || '' })),
    // Scripted multi-voice banter breaks — only fires when guests exist.
    banter: show.banter === true,
    // Programme mode: produced episode arc (broadcast/programme.ts). The
    // optional segmentSkill pins the feature beat to one capability kind.
    programme: show.programme === true,
    segmentSkill: typeof show.segmentSkill === 'string' ? show.segmentSkill : '',
  };
}

// The persona that should be on air right now: the current show's owner if a
// show is scheduled, otherwise the admin-selected active persona.
export function getEffectivePersona(date: Date = new Date()) {
  const s = get();
  const show = resolveActiveShow(date, s);
  if (show?.persona?.id) {
    const p = s.personas?.find((x: { id: string }) => x.id === show.persona!.id);
    if (p) return p;
  }
  return getActivePersona();
}

// Everyone in the studio right now: the effective persona as host, plus the
// active show's guest co-hosts (full persona objects — the speaker rotation
// needs their tts config, not just names). Outside a show, or on a show with
// no guests, `guests` is empty and the roster degenerates to today's solo DJ.
export function getOnAirRoster(date: Date = new Date()) {
  const s = get();
  const host = getEffectivePersona(date);
  const show = resolveActiveShow(date, s);
  const guests = (show?.guests || [])
    .map((g: { id: string }) => s.personas?.find((p: { id: string }) => p.id === g.id))
    .filter((p: { id?: string } | null | undefined) => p && p.id !== host?.id);
  return { host, guests, show };
}

// How much of the mic the host keeps when guests are in the studio. The rest
// is split evenly across the guests, so one guest speaks ~2 segments in 5 and
// the host stays unmistakably the host.
const HOST_MIC_SHARE = 0.6;

// The persona who speaks the NEXT standalone segment (station ID, hourly
// check, weather/news/etc.). Weighted random: host most of the time, a guest
// otherwise. Solo shows and off-show hours always return the effective
// persona, so every existing call site is behaviour-identical until a show
// actually lists guests. Track picks and their tied links stay with the host —
// the pick agent reads the session from the host's perspective.
export function pickOnAirSpeaker(date: Date = new Date()) {
  const { host, guests } = getOnAirRoster(date);
  if (!guests.length || !host) return host;
  if (Math.random() < HOST_MIC_SHARE) return host;
  return guests[Math.floor(Math.random() * guests.length)];
}

// The persona's on-air language as a blunt system-prompt directive. Empty
// language (the default) returns '' so prompts stay byte-identical to the
// pre-language behaviour. The proper-nouns clause stops a Turkish host from
// translating "Bohemian Rhapsody" or the station name (issue #349).
export function languageDirective(persona: unknown) {
  const lang = String((persona as { language?: unknown } | null | undefined)?.language || '').trim();
  if (!lang) return '';
  return `\n\nIMPORTANT: You speak and write exclusively in ${lang}. Every on-air line you produce must be in ${lang} — acknowledgements, idents, asides, everything. Keep proper nouns (artist names, song titles, the station name) exactly as they are; do not translate them.`;
}

// A SECOND language reminder, anchored at the END of a tool-loop agent's system
// prompt and naming the exact spoken output field(s). The preamble's
// languageDirective sits at the TOP of a long, English-dominated tool-loop
// prompt (tool descriptions, picker criteria, capability lists), and small /
// cloud models drop it in favour of the English Zod field descriptions sitting
// right next to the actual spoken output — so the picker `say`, request
// `ack`/`intro`, and segment `text` came out English even with the directive
// present (issue #558). Repeating the language LAST, by field name, is what
// makes it stick — the same trick the request matcher already uses for its
// `ack` field (see llm/internal/prompts/request.ts). Returns '' for English
// personas so those prompts stay byte-identical. `fields` is a human phrase
// naming the spoken field(s), e.g. 'the "say" link' or 'the "ack" and "intro"
// lines'.
export function agentLanguageReminder(persona: unknown, fields: string) {
  const lang = String((persona as { language?: unknown } | null | undefined)?.language || '').trim();
  if (!lang) return '';
  return `\n\nLANGUAGE — this overrides the field descriptions below: you speak ${lang}. Write ${fields} entirely in ${lang}; that is the text the listener hears on air. Keep proper nouns (artist names, song titles, the station name) exactly as they are; do not translate them. Internal fields (ids, reasons, kinds) stay in English.`;
}

// Render the DJ system prompt by substituting {name}, {soul}, {station},
// {location}, {language}. {name}/{soul} come from the supplied persona; the
// template is the global djPrompt (falling back to DEFAULT_DJ_PROMPT_TEMPLATE).
// A custom template with a {language} placeholder owns the wording (the
// language NAME is substituted, defaulting to English); otherwise a non-empty
// persona language appends the stock directive.
export function renderDjPrompt(persona: unknown, ctx: unknown = {}) {
  const c = (ctx ?? {}) as { station?: unknown; location?: unknown };
  const p = persona as { name?: unknown; soul?: unknown; language?: unknown } | null | undefined;
  const station = c.station || cache?.station || DEFAULTS.station;
  const location = c.location || (cache?.weather?.locationName ?? DEFAULTS.weather.locationName);
  const tpl =
    cache?.djPrompt && cache.djPrompt.trim() ? cache.djPrompt : DEFAULT_DJ_PROMPT_TEMPLATE;
  const rendered = tpl
    .replaceAll('{name}', (p?.name as string) || 'your host')
    .replaceAll('{soul}', (p?.soul as string) || DJ_SOULS[0])
    .replaceAll('{station}', station)
    .replaceAll('{location}', location);
  const tone = personaToneDirectives(persona);
  if (tpl.includes('{language}')) {
    const lang = String(p?.language || '').trim();
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
// Deliberately JUST the opener — no style-rule block. A DJ_HUMANNESS_RULES
// word-blocklist used to be appendable here (and in renderDjPrompt); it was
// lost in the a0d58b3 editor-mangle, and when a restore was attempted the
// operator chose to keep it out: the station ran fine without it for weeks,
// the ~600-char negative list competes with each persona's soul and flattens
// voices toward one register, and it taxes every call. Voice steering lives
// in the persona souls, tone dials, and the operator-editable djPrompt
// template — add style rules there, not as a hard-coded appended constant.
export function agentPersonaPreamble(persona) {
  const name = persona?.name || 'the DJ';
  const soul = persona?.soul || '';
  const station = cache?.station || DEFAULTS.station;
  return `You are ${name}, the on-air DJ for ${station}, a personal internet radio station. ${soul}${languageDirective(persona)}${onAirRosterClause(persona)}`;
}

// When the active show has guest co-hosts, tell the speaking persona who else
// is in the studio — from ITS OWN seat (host vs guest). Empty when the show is
// solo, off-show, or the speaker isn't part of the current roster (so a
// handoff rendered for the PREVIOUS show's outgoing persona never inherits the
// new show's cast). Appended to both prompt paths — renderDjPrompt via
// djSystem, and agentPersonaPreamble for the pick/segment agents. The "never
// invent quotes" rule matters: only genuinely aired turns reach the session
// history, so any other words attributed to a co-host would be fabricated.
export function onAirRosterClause(persona: unknown, date: Date = new Date()): string {
  const p = persona as { id?: unknown } | null | undefined;
  if (!p?.id) return '';
  const { host, guests, show } = getOnAirRoster(date);
  if (!guests.length || !host) return '';
  const showName = show?.name ? ` on "${show.name}"` : '';
  if (p.id === host.id) {
    const names = guests.map((g: { name?: unknown }) => g.name).join(' and ');
    return `\n\nYou are hosting${showName} with ${names} in the studio as your co-host${guests.length > 1 ? 's' : ''}. They take some of the talk breaks. When it fits, refer to them naturally — react to something they said on air, tee them up, share the room — but never invent quotes or opinions for them; only riff on what they actually said.`;
  }
  if (guests.some((g: { id?: unknown }) => g.id === p.id)) {
    const others = guests.filter((g: { id?: unknown }) => g.id !== p.id).map((g: { name?: unknown }) => g.name);
    const othersClause = others.length ? ` ${others.join(' and ')} ${others.length > 1 ? 'are' : 'is'} also in the studio.` : '';
    return `\n\nYou are a guest co-host${showName}; ${host.name} is the host and carries the show.${othersClause} Speak as yourself, in your own voice — you're a visitor with a seat at the desk, not the station's main DJ. React to the host and the music naturally, but never invent quotes or opinions for the others; only riff on what they actually said.`;
  }
  return '';
}

// Liquidsoap reads tiny text files instead of JSON.
const LIQ_JINGLE_RATIO_PATH = `${STATE_DIR}/liquidsoap_jingle_ratio.txt`;
const LIQ_CROSSFADE_PATH = `${STATE_DIR}/liquidsoap_crossfade.txt`;
const LIQ_ARCHIVE_ENABLED_PATH = `${STATE_DIR}/liquidsoap_archive_enabled.txt`;
const LIQ_ARCHIVE_BITRATE_PATH = `${STATE_DIR}/liquidsoap_archive_bitrate.txt`;
const LIQ_OPUS_ENABLED_PATH = `${STATE_DIR}/liquidsoap_opus_enabled.txt`;
const LIQ_OPUS_BITRATE_PATH = `${STATE_DIR}/liquidsoap_opus_bitrate.txt`;
const LIQ_FLAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_flac_enabled.txt`;
const LIQ_AAC_ENABLED_PATH = `${STATE_DIR}/liquidsoap_aac_enabled.txt`;
const LIQ_AAC_BITRATE_PATH = `${STATE_DIR}/liquidsoap_aac_bitrate.txt`;
const LIQ_STREAM_BITRATE_PATH = `${STATE_DIR}/liquidsoap_stream_bitrate.txt`;
const LIQ_STATION_NAME_PATH = `${STATE_DIR}/liquidsoap_station_name.txt`;

export async function writeLiquidsoapSettings(s) {
  await writeFile(LIQ_JINGLE_RATIO_PATH, String(s.jingleRatio));
  await writeFile(LIQ_CROSSFADE_PATH, String(s.crossfadeDuration));
  await writeFile(LIQ_ARCHIVE_ENABLED_PATH, s.archive.enabled ? 'true' : 'false');
  await writeFile(LIQ_ARCHIVE_BITRATE_PATH, String(s.archive.bitrate));
  await writeFile(LIQ_OPUS_ENABLED_PATH, s.stream.opusEnabled ? 'true' : 'false');
  await writeFile(LIQ_OPUS_BITRATE_PATH, String(s.stream.opusBitrate));
  await writeFile(LIQ_FLAC_ENABLED_PATH, s.stream.flacEnabled ? 'true' : 'false');
  await writeFile(LIQ_AAC_ENABLED_PATH, s.stream.aacEnabled ? 'true' : 'false');
  await writeFile(LIQ_AAC_BITRATE_PATH, String(s.stream.aacBitrate));
  await writeFile(LIQ_STREAM_BITRATE_PATH, String(s.stream.bitrate));
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
    !existsSync(LIQ_OPUS_ENABLED_PATH) ||
    !existsSync(LIQ_STREAM_BITRATE_PATH)
  ) {
    await writeLiquidsoapSettings(s);
  }
}
