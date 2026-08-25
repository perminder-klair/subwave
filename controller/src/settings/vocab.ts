// Settings vocabulary: the fixed value sets, shapes, bounds and seed data the
// rest of the settings layer validates against, plus the pure coercers that
// only depend on them. Deliberately free of any dependency on the loaded
// settings cache, so every other settings module can import it.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { randomBytes } from 'node:crypto';
import { DISCOVERY_STEPS_MIN, DISCOVERY_STEPS_MAX } from '../llm/internal/provider/capabilities.js';
// The show shape's rules now live in the shared schema the admin form runs too.
// Re-exported from this barrel (below) so its many importers don't move.
import {
  EXCLUDED_PLAYLISTS_PER_SHOW,
  GUESTS_PER_SHOW,
  PLAYLISTS_PER_SHOW,
  SHOW_FILTER_VALUES_MAX,
  SHOW_GENRE_MAX,
  SHOW_ID_RE,
  SHOW_ENERGY as SHOW_ENERGY_VALUES,
  SHOW_VOCALS as SHOW_VOCALS_VALUES,
  migrateLegacyShowFields,
  repairEraWindow,
  type EraWindow,
} from '../schemas/show.js';
import { SKILL_SLUG_RE as SKILL_SLUG_PATTERN } from '../schemas/skill.js';
// The persona shape's rules — and the TTS voice slot's, which the station-wide
// rescue slot shares — now live in the shared schema the admin form runs too.
// Aliased below under the names the controller already used, so no call site
// moved when this landed.
import {
  DJ_PROMPT_LIMIT as DJ_PROMPT_LIMIT_VALUE,
  DJ_PROMPT_NAME_MAX as DJ_PROMPT_NAME_MAX_VALUE,
  DJ_PROMPT_TEXT_MAX as DJ_PROMPT_TEXT_MAX_VALUE,
  DJ_PROMPT_TEXT_MIN as DJ_PROMPT_TEXT_MIN_VALUE,
  PERSONA_AVATAR_FILENAME_RE,
  PERSONA_DIAL_NEUTRAL,
  PERSONA_FREQUENCIES,
  PERSONA_LIMIT as PERSONA_LIMIT_VALUE,
  PERSONA_SCRIPT_LENGTHS,
  PERSONA_SKILLS_LIMIT,
  PERSONA_SOUL_MAX,
  TTS_CHATTERBOX_VOICE_RE,
  TTS_CLOUD_PROVIDERS as TTS_CLOUD_PROVIDER_VALUES,
  TTS_ENGINES as TTS_ENGINE_VALUES,
  TTS_GAIN_CLAMP_DB as TTS_GAIN_CLAMP_DB_VALUE,
  TTS_KOKORO_VOICE_RE,
  TTS_POCKET_VOICE_RE,
  TTS_SPEED_DEFAULT as TTS_SPEED_DEFAULT_VALUE,
  TTS_SPEED_MAX as TTS_SPEED_MAX_VALUE,
  TTS_SPEED_MIN as TTS_SPEED_MIN_VALUE,
  clampPersonaDial,
  clampTtsGain as clampTtsGainFn,
  clampTtsSpeed as clampTtsSpeedFn,
} from '../schemas/persona.js';
import {
  SETTINGS_AAC_BITRATES,
  SETTINGS_LOUDNESS_SOURCES,
  SETTINGS_MP3_BITRATES,
  SETTINGS_OPUS_BITRATES,
  SETTINGS_SEARCH_PROVIDERS,
} from '../schemas/settings.js';

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
export const FREQUENCIES: readonly string[] = PERSONA_FREQUENCIES;

// Per-persona verbosity, ascending. 'concise' is the historical default;
// 'one-liner' cuts every segment to a single quick line, 'extended' roughly
// doubles, 'storyteller' roughly triples for long-form monologues.
// See llm/internal/prompts/system.ts LENGTH_PHRASES for the actual directives.
export const SCRIPT_LENGTHS: readonly string[] = PERSONA_SCRIPT_LENGTHS;

// Per-persona tone dials. Each is 0-10 with 5 (DIAL_NEUTRAL) the default. A
// model can't distinguish humour=6 from 7, so rather than inject a raw "7/10"
// the dial maps to three bands: 0-3 low, 7-10 high, 4-6 neutral. Only a band
// away from neutral appends a style directive (personaToneDirectives below), so
// a persona left at the defaults renders a byte-identical prompt to before.
export const TONE_DIALS = ['humour', 'localColour', 'warmth'] as const;
export const DIAL_NEUTRAL = PERSONA_DIAL_NEUTRAL;

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
// The single chokepoint used by both normalizePersona and the seed roster —
// now defined in the shared schema, so the admin form clamps identically.
export const normalizeDial = clampPersonaDial;

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

// TTS engines. Every spoken segment is voiced by the on-air persona's own `tts`
// config (audio/tts.js); only jingle rendering falls back to defaultEngine.
//
// `cloud` routes through the AI SDK (llm/speech.js). `piper`, `kokoro`,
// `chatterbox` and `pocket-tts` are local. `remote` is a self-hosted HTTP
// engine: it POSTs to a configurable /speak endpoint and gets the audio back in
// the response body — no shared volume, so it can live on any host — gated on a
// /health probe. Chatterbox and PocketTTS are opt-in at image build time
// (`--build-arg WITH_CHATTERBOX=1` / `WITH_POCKETTTS=1`). The dispatcher gates
// every engine on isAvailable(), so settings can name one whose runtime is
// absent and it simply falls back to Piper.
export const TTS_ENGINES: readonly string[] = TTS_ENGINE_VALUES;

// DJ-voice level trim, in dB. A per-engine gain levels the loudness gap between
// TTS engines (only PocketTTS self-normalises today, so it sits quieter than
// raw Piper/Kokoro under the same fixed-threshold mic compressor); a per-persona
// gain stacks on top as a character trim. Applied via Liquidsoap's `liq_amplify`
// annotation on say.txt/intro.txt (see audio/tts.ts:voiceGainDb +
// broadcast/queue.ts) — the same mechanism the music loudness path uses. A
// manual dial, not auto-normalisation, so the range is generous (±12 dB).
export const TTS_GAIN_CLAMP_DB = TTS_GAIN_CLAMP_DB_VALUE;

// Coerce any value to a clean gain: finite number, clamped to ±TTS_GAIN_CLAMP_DB,
// rounded to 0.1 dB (finer is inaudible and just bloats the annotate string).
// Garbage / non-finite → 0 (unity, i.e. today's behaviour).
export const clampTtsGain = clampTtsGainFn;

// Normalise a per-engine gain map to exactly one clean gain per known engine
// (default 0). Drops unknown keys so a hand-edited settings.json can't smuggle
// arbitrary keys into the annotate path.
export function normalizeTtsGainMap(raw: unknown): Record<string, number> {
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
export const TTS_SPEED_MIN = TTS_SPEED_MIN_VALUE;
export const TTS_SPEED_MAX = TTS_SPEED_MAX_VALUE;
export const TTS_SPEED_DEFAULT = TTS_SPEED_DEFAULT_VALUE;

// Coerce any value to a clean speed multiplier: finite number, clamped to
// [TTS_SPEED_MIN, TTS_SPEED_MAX], rounded to 0.05. Garbage / non-finite →
// 1.0 (unity, i.e. today's behaviour).
export const clampTtsSpeed = clampTtsSpeedFn;

// Normalise a per-engine speed map to exactly one clean multiplier per known
// engine (default 1.0). Drops unknown keys, mirroring normalizeTtsGainMap.
export function normalizeTtsSpeedMap(raw: unknown): Record<string, number> {
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
export function normalizeTtsCorrections(raw: any): Array<{ from: string; to: string }> {
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
export function validateTtsCorrectionsStrict(raw: any): Array<{ from: string; to: string }> {
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

// Subset of LLM_PROVIDERS that can actually produce text embeddings. Chat-only
// providers are excluded because offering them in the embedding picker fell
// through to a local Ollama and failed with a misleading "can't reach
// <provider>" (#493): deepseek and the Vercel AI gateway have no embeddings
// endpoint, and `anthropic` has no first-party embedding model (it only worked
// by transparently routing to OpenAI, which confused operators — pick OpenAI
// directly). `openrouter` IS included: it shipped an OpenAI-compatible
// embeddings endpoint (#522), routed through provider/embedding.ts.
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
export function clampNumCtx(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  if (raw <= 0) return 0;
  return Math.min(131072, Math.max(2048, Math.floor(raw)));
}

// repeat_penalty for local openai-compatible / locca servers. Clamped to
// [1.0, 2.0]: 1.0 is OFF (a no-op, never injected), and >2.0 mangles output.
// Non-numeric/NaN falls back to `def`. See appliedRepeatPenalty() in
// capabilities.ts — Ollama ignores this field (ai-sdk-ollama v4 has no
// per-call repeat_penalty channel at all; restoration is a tracked follow-up).
export function clampRepeatPenalty(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(2.0, Math.max(1.0, raw));
}

// Coerce a stored agent-deadline value (ms). Clamped to [5s, 300s] and floored
// to an integer; non-numeric/NaN falls back to `def`. The lower bound keeps a
// fat-fingered save from making every agent pick fail instantly; the upper
// bound keeps a stalling model from tying up an inference slot for minutes.
export function clampAgentTimeout(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(300_000, Math.max(5_000, Math.floor(raw)));
}

// Daily LLM token cap. 0 disables (the default — never cap a free local box);
// otherwise floored to a non-negative integer. No upper bound: a cloud quota
// can legitimately be in the tens of millions of tokens/day. Non-numeric/NaN
// falls back to `def`.
export function clampDailyTokenCap(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.max(0, Math.floor(raw));
}

// Soft-tier threshold as a percent of the cap. Clamped to [0, 100]; 0 or 100
// disables the soft tier (straight to hard at the cap). Non-numeric/NaN falls
// back to `def`.
export function clampBudgetSoftPct(raw: unknown, def: number): number {
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

// Operator override for the DJ agent's discovery-round budget. 0 is a
// first-class value meaning "off — follow the provider capability table", so it
// passes through unclamped; any other value is floored into the harness's own
// band. Non-numeric/NaN falls back to `def`. Same 0-means-auto shape as
// clampMaxOutputTokens above.
//
// The band is imported from the harness rather than restated: it is a property
// of the tool loop (a 0 budget corners the model at step 0 with an empty
// candidate set; an unbounded one eats the shared deadline the recovery legs
// need), and a second copy would be free to drift from discoveryStepsFor()'s
// clamp. This is the one place settings reaches past an `llm/` barrel —
// capabilities.ts imports nothing, while the llm/provider.js barrel pulls in
// registry.ts, which imports settings: a cycle.
export function clampDiscoverySteps(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  const n = Math.floor(raw);
  if (n <= 0) return 0;
  return Math.min(DISCOVERY_STEPS_MAX, Math.max(DISCOVERY_STEPS_MIN, n));
}

// Count-based hard no-repeat window (distinct plays). Floored to an integer in
// [0, 1000]: 0 disables. The ceiling stays under the _recentPlays sidecar cap
// (config.queue.recentPlaysMax) so the requested window is never silently
// truncated by a too-short sidecar — 1000 against a 2500-entry cap. It was 290
// against a 300-entry cap, which is under a day of airtime even maxed out and
// far too short a memory for a 10k–50k library; the sidecar was sized up with
// the ceiling, so it stays honestly suppliable. Library-size clamping happens
// separately at use time (effectiveNoRepeatWindow). Non-numeric/NaN falls back
// to `def`.
export function clampNoRepeatWindow(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(1000, Math.max(0, Math.floor(raw)));
}

// Artist spacing window, in SLOTS (issue #1406). Floored to an integer in
// [0, 25]: 0 turns spacing off and leaves only the back-to-back guard, which is
// not operator-disableable — an artist following itself is a fault, not a taste.
//
// The ceiling is low on purpose and is not the same kind of number as
// noRepeatWindow's 1000. This one is consulted at the POINT OF CHOICE against
// the run's own candidates, and neighbourArtistRoots(n) excludes up to 2n+1
// artists, so a large window on a show-filtered run mostly buys re-pick calls
// that end in a waived window — cost without spacing. 25 is already ~2 hours of
// air. Non-numeric/NaN falls back to `def`.
export function clampArtistVarietyWindow(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(25, Math.max(0, Math.floor(raw)));
}

// Validate + apply the connection fields shared by the primary LLM leg and its
// optional fallback (provider/model/apiKey/ollamaUrl/baseUrl/reasoning/numCtx).
// `target` is the live settings sub-object to mutate; `patch` is the incoming
// partial; `label` prefixes error messages ('llm' or 'llm.fallback'). The
// "openai-compatible needs baseUrl" rule is left to the caller — the fallback
// only enforces it when enabled. Station-level toggles (pickerAgent,
// pauseWhenEmpty) are primary-only and handled at the call site.
export function applyLlmLegPatch(target: Record<string, unknown>, patch: unknown, label: string): void {
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
  if (l.providerBaseUrls !== undefined) {
    if (!l.providerBaseUrls || typeof l.providerBaseUrls !== 'object' || Array.isArray(l.providerBaseUrls)) {
      throw new Error(`${label}.providerBaseUrls must be an object map of provider → URL`);
    }
    const incoming = l.providerBaseUrls as Record<string, unknown>;
    const existing = (target.providerBaseUrls as Record<string, string> | undefined) ?? {};
    const merged: Record<string, string> = { ...existing };
    for (const p of Object.keys(incoming)) {
      if (!LLM_PROVIDERS.includes(p)) continue;
      const v = String(incoming[p] ?? '').trim();
      if (v.length > 200) throw new Error(`${label}.providerBaseUrls.${p} must be 0-200 chars`);
      if (v && !/^https?:\/\//i.test(v)) {
        throw new Error(`${label}.providerBaseUrls.${p} must start with http:// or https://`);
      }
      const clean = v.replace(/\/+$/, '');
      if (clean) merged[p] = clean; else delete merged[p];
    }
    target.providerBaseUrls = merged;
  }
  if (l.baseUrl !== undefined) {
    // Legacy path — a plain baseUrl is written into the current provider's map
    // slot; the flat field itself is re-derived below.
    const v = String(l.baseUrl).trim();
    if (v.length > 200) throw new Error(`${label}.baseUrl must be 0-200 chars`);
    if (v && !/^https?:\/\//i.test(v)) {
      throw new Error(`${label}.baseUrl must start with http:// or https://`);
    }
    const clean = v.replace(/\/+$/, '');
    const prov = (target.provider ?? l.provider) as string | undefined;
    if (prov && LLM_PROVIDERS.includes(prov)) {
      const urls = (target.providerBaseUrls as Record<string, string> | undefined) ?? {};
      if (clean) urls[prov] = clean; else delete urls[prov];
      target.providerBaseUrls = urls;
    }
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
  // Discovery-round budget. 0 = follow the provider capability table.
  if (l.discoverySteps !== undefined) {
    target.discoverySteps = clampDiscoverySteps(Number(l.discoverySteps), target.discoverySteps as number);
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
  // Single writer of the flat legacy `baseUrl`: always re-derive it from the
  // map so a provider-only patch can never leave a stale URL from the
  // previously selected provider (issue #1082). Runtime consumers
  // (registry/legs) keep reading `baseUrl`, so this is what keeps them
  // pointed at the right server after any switch.
  const urls = (target.providerBaseUrls as Record<string, string> | undefined) ?? {};
  const prov = target.provider as string | undefined;
  target.baseUrl = (prov && urls[prov]) ? urls[prov] : '';
}

// Route an incoming inline API key to its provider's slot in `llmHost.keys`
// (issue #657). `provider` is the leg's already-resolved provider, so the key
// lands under the identity it belongs to and can never shadow another
// provider's key after a switch. '' clears that provider's entry; 'set' (the
// getRedacted() sentinel) and undefined leave it untouched.
export function applyInlineKey(llmHost: { keys?: Record<string, string> }, provider: string, rawApiKey: unknown): void {
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
export function normalizeLlmKeys(storedLlm: unknown): Record<string, string> {
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

// Build the per-provider base-URL map from a stored settings.llm blob (issue #1082).
// Sanitises any persisted `providerBaseUrls` and migrates the legacy single `baseUrl`
// into the current provider's slot so no saved URL is lost on upgrade.
export function normalizeLlmProviderBaseUrls(
  storedLeg: unknown,
  providers: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const sl = storedLeg as {
    providerBaseUrls?: unknown;
    baseUrl?: unknown;
    provider?: unknown;
  } | null | undefined;
  const raw = sl?.providerBaseUrls;
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const p of Object.keys(rec)) {
      if (providers.includes(p) && typeof rec[p] === 'string' && rec[p]) {
        out[p] = (rec[p] as string).trim().replace(/\/+$/, '');
      }
    }
  }
  // Migrate legacy single baseUrl into the current provider's slot when no
  // per-provider entry already covers that provider.
  const legacyUrl = typeof sl?.baseUrl === 'string' ? sl.baseUrl.trim().replace(/\/+$/, '') : '';
  const currentProvider = typeof sl?.provider === 'string' ? sl.provider : '';
  if (legacyUrl && currentProvider && !out[currentProvider]) {
    out[currentProvider] = legacyUrl;
  }
  return out;
}

// Cloud TTS vendors usable by the `cloud` engine. `openai-compatible` targets
// any self-hosted OpenAI-compatible speech server (Chatterbox, Qwen3 TTS,
// VibeVoice, etc.) via the operator-supplied `tts.cloud.baseUrl` — mirrors the
// LLM provider of the same name.
export const TTS_CLOUD_PROVIDERS: readonly string[] = TTS_CLOUD_PROVIDER_VALUES;

// Web-search backends for the segment director's `web-search` capability.
// `duckduckgo` is the homelab default — DuckDuckGo's Instant Answer API is free
// and keyless, returns useful results only for entity / definition queries, and
// silence otherwise (which the segment director already treats as a valid
// outcome). `tavily` is the paid option for operators who want richer web
// results; `brave` is Brave's Search API (metered, $5/mo free credits) — both
// read their key from SEARCH_API_KEY. `searxng` is keyless self-hosted
// meta-search via settings.search.baseUrl.
export const SEARCH_PROVIDERS = SETTINGS_SEARCH_PROVIDERS;

// Canonical mood vocabulary + each mood's CLAP sound-prompt. This is the SEED:
// the operator edits the live list from /admin/moods (settings.moods), and every
// consumer reads it through the moodVocab()/moodEntries()/moodPromptFor()
// accessors below — NOT this constant. `clapPrompt` is the zero-shot audio
// sound-description (music/audio-moods.ts); '' falls back to `${name} music`.
// A show's `moods` (lead entry) override the autonomous dominantMood; every
// entry must come from the live vocabulary. Empty show moods means "Any".
export const MOOD_DEFAULTS: Array<{ name: string; clapPrompt: string }> = [
  { name: 'energetic', clapPrompt: 'high-energy, upbeat, powerful music with a strong driving beat' },
  { name: 'calm', clapPrompt: 'calm, peaceful, soft, soothing, gentle music' },
  { name: 'reflective', clapPrompt: 'reflective, introspective, melancholic, emotional music' },
  { name: 'celebratory', clapPrompt: 'joyful, festive, celebratory party music' },
  { name: 'romantic', clapPrompt: 'romantic, intimate, tender, loving music' },
  { name: 'spiritual', clapPrompt: 'spiritual, devotional, sacred, meditative music' },
  { name: 'focus', clapPrompt: 'minimal, unobtrusive, ambient instrumental background music for concentration' },
  { name: 'workout', clapPrompt: 'intense, pounding, adrenaline-pumping workout music' },
  { name: 'driving', clapPrompt: 'steady, groovy, mid-tempo cruising music for a road trip' },
  { name: 'cooking', clapPrompt: 'light, cheerful, breezy, feel-good easy-listening music' },
  { name: 'rainy', clapPrompt: 'mellow, wistful, cozy music for a rainy day' },
  { name: 'sunny', clapPrompt: 'bright, warm, sunny, feel-good summer music' },
  { name: 'night', clapPrompt: 'dark, atmospheric, moody late-night music' },
  { name: 'morning', clapPrompt: 'fresh, gentle, optimistic early-morning music' },
  { name: 'evening', clapPrompt: 'smooth, warm, relaxed evening music' },
  { name: 'festival', clapPrompt: 'big, anthemic, euphoric festival crowd music' },
  { name: 'cultural', clapPrompt: 'traditional folk music with regional acoustic instruments' },
];

// Back-compat: the default mood NAMES. Kept for the community catalog (shared
// configs validate against the canonical set, not a local custom vocab) and as
// the accessor fallback before load(). Live reads go through moodVocab().
export const SHOW_MOODS = MOOD_DEFAULTS.map((m) => m.name);

// The 8 fixed day-periods (context.ts getTimeContext) and their seed moods.
// Operators re-point each period's mood from /admin/moods (settings.moodSchedule);
// the hour ranges + vibe/show labels stay in code.
export const MOOD_PERIODS = [
  'early-morning', 'morning', 'midday', 'afternoon',
  'drive-time', 'evening', 'late-evening', 'after-hours',
] as const;
export const PERIOD_MOOD_DEFAULTS: Record<string, string> = {
  'early-morning': 'morning',
  morning: 'morning',
  midday: 'energetic',
  afternoon: 'focus',
  'drive-time': 'driving',
  evening: 'evening',
  'late-evening': 'night',
  'after-hours': 'reflective',
};

// The 6 fixed weather conditions (context.ts mapWeatherCode) and their seed
// moods. '' = no mood steer for that condition. Editable via settings.weatherMoods.
export const WEATHER_CONDITIONS = [
  'clear', 'cloudy', 'foggy', 'rainy', 'snowy', 'stormy',
] as const;
export const WEATHER_MOOD_DEFAULTS: Record<string, string> = {
  clear: 'sunny',
  cloudy: '',
  foggy: 'rainy',
  rainy: 'rainy',
  snowy: 'reflective',
  stormy: 'rainy',
};

// --- Mood vocabulary validation (the seeded-but-editable pattern) ---
export const MOODS_LIMIT = 40;
export const MOOD_PROMPT_MAX = 200;

// Normalise a raw mood name to the canonical id form (lowercase, [a-z0-9-]).
export function normalizeMoodName(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Lenient on-load pass: never throws, drops malformed/duplicate entries so a
// hand-edited settings.json can't wedge boot. Empty → the seed defaults (an
// empty vocabulary is unusable — shows, festivals, and the tagger all need it).
export function normalizeMoods(raw: any): Array<{ name: string; clapPrompt: string }> {
  if (!Array.isArray(raw)) return MOOD_DEFAULTS;
  const out: Array<{ name: string; clapPrompt: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MOODS_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const name = normalizeMoodName(item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const clapPrompt = typeof item.clapPrompt === 'string'
      ? item.clapPrompt.trim().slice(0, MOOD_PROMPT_MAX)
      : '';
    out.push({ name, clapPrompt });
  }
  return out.length ? out : MOOD_DEFAULTS;
}

// Lenient on-load pass for the fixed-key mood maps: fills every known key from
// the stored value when it's a string, else from the seed default.
export function normalizeMoodMap(
  raw: any,
  keys: readonly string[],
  defaults: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = typeof raw?.[k] === 'string' ? raw[k] : defaults[k];
  }
  return out;
}

// Energy bands a show can pin as a soft music-steering filter. Mirrors the
// tagger's per-track energy classes and the `tracksByMood` agent-tool filter.
//
// Vocal steering a show can pin. Unlike the list filters this is ONE value,
// because the three states are mutually exclusive and "both" is just no
// constraint — which is what '' means, and what every show that predates the
// field carries. Backed by Demucs vocal ranges (music/show-filter.trackInstrumental).
//
// Both now live in the shared show schema, which the admin form runs too
// (controller/src/schemas/show.ts). Re-exported so the many existing importers
// of this barrel don't move. Typed as readonly there; widened here because
// callers do `SHOW_ENERGY.includes(x)` on unknown strings.
export const SHOW_ENERGY: readonly string[] = SHOW_ENERGY_VALUES;
export const SHOW_VOCALS: readonly string[] = SHOW_VOCALS_VALUES;

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

export const KOKORO_VOICE_RE = TTS_KOKORO_VOICE_RE;

// Kokoro language override — the set of phonemizer languages the worker accepts.
// The worker builds an espeak.EspeakG2P for the chosen language (see _phonemize
// in kokoro_worker.py). Empty string = auto-detect from the voice-code prefix.
// Synced with the prefix→lang mapping in controller/scripts/kokoro_worker.py.
//
// Every entry must be an EXACT match for a row in espeak-ng's own voice table
// (`espeak-ng --voices`, Language column) — phonemizer's EspeakBackend validates
// against that list verbatim and throws for anything else. espeak-ng's CLI does
// resolve bare aliases like `fr` to a regional voice, which is what makes a wrong
// entry here look plausible, but the backend never gets that far. Hence `fr-fr`
// and not `fr` (#1213): espeak-ng ships fr-fr/fr-be/fr-ch and no bare `fr`.
export const KOKORO_LANGS = ['en-gb', 'en-us', 'es', 'it', 'fr-fr', 'hi', 'pt-br', 'ja', 'cmn'];
export const KOKORO_LANG_RE = new RegExp(`^(${KOKORO_LANGS.join('|')})$`);

// Codes that were offered before they were checked against espeak-ng, kept
// accepted so a stored settings.json (or an old API client) is rewritten to the
// working equivalent instead of silently reverting to auto-detect. Mirrored by
// `lang_aliases` in controller/scripts/kokoro_worker.py, which covers the same
// value arriving through the KOKORO_LANG env var.
export const KOKORO_LANG_ALIASES: Record<string, string> = { fr: 'fr-fr' };

/** Canonicalise a Kokoro phonemizer language; unknown values pass through for
 *  the caller's own validation to reject. */
export function canonicalKokoroLang(lang: string): string {
  return KOKORO_LANG_ALIASES[lang] || lang;
}

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
export const POCKET_TTS_VOICE_RE = TTS_POCKET_VOICE_RE;
// Reference-WAV filenames live in the shared voice folder (config.voices.dir,
// formerly config.chatterbox.voiceDir). Loose check — basename only, no path
// separators, conservative character set, ends in .wav. Empty is also valid
// (means "use the built-in default voice"). Used by both chatterbox and
// pocket-tts since issue #213.
export const CHATTERBOX_VOICE_RE = TTS_CHATTERBOX_VOICE_RE;
// The entity-id pattern shows, personas and skill assignments all share. Its
// one definition is SHOW_ID_RE in the shared show schema — a mirrored module
// cannot import a common one (gen-schemas.ts rejects every specifier but
// 'zod'), so it is homed in the first feature that needed it. Whoever converts
// personas should decide its permanent home.
export const ID_RE = SHOW_ID_RE;
// Persona avatar filename — `<personaId>.(png|jpg|jpeg|webp)`. The id segment
// reuses ID_RE's shape so an avatar field can never reference a basename
// outside the persona-avatars directory. Empty is also valid (no avatar set).
export const AVATAR_FILENAME_RE = PERSONA_AVATAR_FILENAME_RE;
// Skill slugs (e.g. 'weather', 'random-facts'). The skills registry is the
// source of truth for which slugs exist; settings only checks the shape — and
// now checks the SAME shape, aliasing the pattern in the shared skill schema
// (skills/loader.ts's SLUG_RE is the third name for it). The separate pattern
// this replaces (`/^[a-z0-9-]{1,40}$/`) disagreed in both directions: it
// accepted `-nope`, which no skill can be called, and rejected a real
// 41–49-char slug, so a legitimately-named skill could not be assigned to a
// persona at all.
export const SKILL_SLUG_RE = SKILL_SLUG_PATTERN;

// Exported for the community-persona install route (routes/personas.ts), which
// gives a friendly 409 before settings.update() would throw on an oversize roster.
export const PERSONA_LIMIT = PERSONA_LIMIT_VALUE;
// Persona `soul` — the character sketch injected into EVERY free-text DJ
// generation call, so each char is a recurring per-call token cost. Bounded
// rather than unbounded for that reason alone; nothing structural depends on
// the number. Keep in lockstep with SOUL_MAX in
// web/components/admin/personas/constants.ts and the AI-fill draft schema in
// llm/internal/prompts/generate.ts. Consumers that inline a soul somewhere it
// is NOT the speaking seat (the multi-voice cast blocks, the cloud-TTS
// delivery hint) clamp it further at their own boundary — see soulBrief() in
// llm/internal/core/pure.ts.
export const SOUL_MAX = PERSONA_SOUL_MAX;
export { SHOWS_LIMIT } from '../schemas/show.js';
// Show `topic` — the standing brief the DJ works from while the show is on air.
// Injected into the pick prompts (picker.ts / dj-agent schemas) and the
// programme producer plan, so like SOUL_MAX it is a recurring per-call token
// cost rather than a structural limit. Matched to SOUL_MAX so a show brief can
// carry the same amount of detail as a persona sketch. Keep in lockstep with
// TOPIC_MAX in web/components/admin/shows/types.ts and the AI-fill draft schema
// in llm/internal/prompts/generate.ts.
// Definition lives in the shared schema; the rationale above stays here.
export { SHOW_TOPIC_MAX } from '../schemas/show.js';
// Guest co-hosts per show. Small on purpose: each guest is a full persona the
// speaker rotation can hand a segment to, and past ~3 the host stops sounding
// like the host.
export { GUESTS_PER_SHOW, PLAYLISTS_PER_SHOW, EXCLUDED_PLAYLISTS_PER_SHOW };
// Values per multi-select music filter (moods / genres / eras). Within one
// attribute the values OR at pick time; across attributes they AND.
//
// The cap can be generous because neither cost nor pool size scales with it:
// getGenres() is TTL-cached, the per-genre discovery fetches run through
// mapPool, and the per-genre size budgets divide a FIXED total (randomSize /
// genreSetSize). It needs to be generous because genre matching only REFINES,
// never broadens (trackGenres/genreMatches in music/show-filter.ts), so a strict
// alt/punk show must name every library tag it wants — Punk Rock, Emo, Pop Punk,
// Post-Hardcore, … — or retag the library.
//
// Keep in lockstep with FILTER_VALUES_MAX in web/components/admin/shows/types.ts
// (pinned by scripts/show-filter-cap.test.ts).
export { SHOW_FILTER_VALUES_MAX };
// Must comfortably exceed a realistic skill library: unticking one skill on an
// "all skills" (null) persona materialises the FULL catalog minus one, so a cap
// near the library size would make that first untick fail (#skill-organization).
export const SKILLS_PER_PERSONA_LIMIT = PERSONA_SKILLS_LIMIT;
// Prompt-template library (djPrompts). Text bounds match the historical
// single-djPrompt rule — keep them in lockstep with PROMPT_MIN/PROMPT_MAX in
// web/components/admin/personas/constants.ts.
export const DJ_PROMPT_LIMIT = DJ_PROMPT_LIMIT_VALUE;
export const DJ_PROMPT_NAME_MAX = DJ_PROMPT_NAME_MAX_VALUE;
export const DJ_PROMPT_TEXT_MIN = DJ_PROMPT_TEXT_MIN_VALUE;
export const DJ_PROMPT_TEXT_MAX = DJ_PROMPT_TEXT_MAX_VALUE;
// Station house rules (djHouseRules) — operator rules appended to ALL THREE
// prompt paths (renderDjPrompt, agentPersonaPreamble and castHouseRulesBlock
// for the multi-voice exchanges), unlike the djPrompt template which only the
// scripted-talk path renders (issues #1182, #1420). No minimum: empty means
// off. Keep in lockstep with HOUSE_RULES_MAX in
// web/components/admin/personas/constants.ts.
export const DJ_HOUSE_RULES_MAX = 2000;

// A show can anchor to one or more Navidrome playlists: the playlist union
// becomes the show's candidate pool. Stored as Subsonic playlist ids; deduped,
// trimmed, capped. Never validated against the live Navidrome here (offline
// validation, same as `genre` free-text) — an id that no longer exists simply
// contributes nothing at pick time (never-starve). Empty = no anchor.
// A show's guest co-hosts: persona ids other than the host, resolved against
// the live persona list. Order preserved (it's the operator's billing order);
// dupes, the host itself, and dangling ids are dropped.
export function coerceGuestPersonaIds(raw: unknown, hostId: string, personaIds: string[]): string[] {
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
export type { EraWindow };

// Webhook shape + event list now live in the shared schema, which the web form
// runs too (controller/src/schemas/webhook.ts). Re-exported here so the many
// existing importers of `Webhook` / `WEBHOOK_EVENTS` from vocab keep working.
export {
  WEBHOOK_EVENTS,
  WEBHOOKS_LIMIT,
  type Webhook,
  type WebhookEvent,
} from '../schemas/webhook.js';

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
  /** '' = no constraint. See SHOW_VOCALS. */
  vocals: string;
  filtersStrict: boolean;
  maxTrackSeconds: number | null;
  playlistIds: string[];
  playlistStrict: boolean;
  excludedPlaylistIds: string[];
  /** Operator organisation tags. Filters the admin list; steers nothing on
   *  air, which is why resolveShow() does not carry them through. */
  tags: string[];
}

// Dedup + cap over one already-plural list. Legacy singular fields (`mood`,
// `genre`, `fromYear`/`toYear`, …) are folded into the plural keys by
// migrateLegacyShowFields — the ONE home of the #929 migration, shared with
// the schema's own preprocess and the lenient load path — rather than by a
// second singular-fallback here, which is how the two migrations used to
// drift.
function coerceShowList<T>(
  raw: unknown,
  coerceOne: (v: unknown) => T | null,
  keyOf: (v: T) => string,
): T[] {
  if (!Array.isArray(raw)) return [];
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

export function coerceShowMoods(item: unknown): string[] {
  // Lenient on load: keep any non-empty string (moods are now operator-editable,
  // so the effective vocabulary isn't known while the cache is still being
  // built — filtering against the seed defaults here would strip an operator's
  // custom moods). update()'s validateShowsStrict enforces the live vocabulary
  // on save; a stale mood string just matches nothing at runtime.
  return coerceShowList(migrateLegacyShowFields(item).moods,
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    (v) => v);
}

export function coerceShowGenres(item: unknown): string[] {
  // The comma-split of a legacy singular `genre` ("funk, soul, jazz-funk" —
  // which never resolved against the library as one tag) lives in
  // migrateLegacyShowFields; each piece becomes a real, individually-resolvable
  // entry. Plural-array entries are taken as-is (the UI adds them one at a time).
  return coerceShowList(migrateLegacyShowFields(item).genres,
    (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, SHOW_GENRE_MAX) : null),
    (v) => v.toLowerCase());
}

export function coerceShowEnergies(item: unknown): string[] {
  return coerceShowList(migrateLegacyShowFields(item).energies,
    (v) => (typeof v === 'string' && SHOW_ENERGY.includes(v) ? v : null),
    (v) => v);
}

// Anything unrecognised — absent, null, 'any', a typo — reads as no constraint.
// A show whose vocal steering silently stops applying is a much smaller failure
// than one that stops playing music.
export function coerceShowVocals(item: unknown): string {
  const v = (item as { vocals?: unknown } | null | undefined)?.vocals;
  return typeof v === 'string' && SHOW_VOCALS.includes(v) ? v : '';
}

export function coerceShowEras(item: unknown): EraWindow[] {
  // Window repair (year bounds, from<=to, numeric-string years) is the
  // schema's own repairEraWindow, so this coercer can't disagree with the
  // validator about what a valid window is.
  return coerceShowList(migrateLegacyShowFields(item).eras, repairEraWindow,
    (e) => `${e.fromYear ?? ''}:${e.toYear ?? ''}`);
}

// The playlist-anchor lists have no standalone coercers any more — the lenient
// load path repairs them through schemas/show.ts repairShowForLoad like every
// other list field.

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function mintId(prefix) {
  return prefix + randomBytes(3).toString('hex');
}

// The weekly grid + timed takeover (#930) vocabulary now lives in the shared
// schema (controller/src/schemas/schedule.ts) so the admin UI runs the same
// bounds — TakeoverCard carried a hand-copied OVERRIDE_MIN/MAX_MINUTES pair.
// Re-exported here so no existing import site moved.
export {
  emptyWeek,
  OVERRIDE_MIN_MINUTES,
  OVERRIDE_MAX_MINUTES,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
} from '../schemas/schedule.js';
export type { ScheduleOverride, ScheduleWeek } from '../schemas/schedule.js';

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
// Homed in schemas/settings.ts (#1348) so the mirrored archive/stream schemas
// and the browser can read them; re-exported here so no call site moved.
export const MP3_BITRATES = SETTINGS_MP3_BITRATES;
// Opus + AAC encoders share the same parse-time-literal constraint as %mp3, so
// each is pre-baked for a small set in radio.liq. Add a branch there if you add
// a value here.
export const OPUS_BITRATES = SETTINGS_OPUS_BITRATES;
export const AAC_BITRATES = SETTINGS_AAC_BITRATES;

// Where per-track loudness comes from (queue.applyLoudnessGain, issue #998):
// an embedded ReplayGain tag (Navidrome's OpenSubsonic replayGain field),
// the analyzer's measured LUFS, or tag-with-measured-fallback (the default).
export const LOUDNESS_SOURCES = SETTINGS_LOUDNESS_SOURCES;
export type LoudnessSource = (typeof LOUDNESS_SOURCES)[number];
