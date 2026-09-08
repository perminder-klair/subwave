// Fixed value sets, shapes, bounds and seed data, plus the pure coercers over
// them. Depends on no loaded settings cache, so every settings module may
// import it.

import { randomBytes } from 'node:crypto';
import { DISCOVERY_STEPS_MIN, DISCOVERY_STEPS_MAX } from '../llm/internal/provider/capabilities.js';
// Schema-owned constants, re-exported below under the names call sites use.
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
import {
  DJ_PROMPT_LIMIT as DJ_PROMPT_LIMIT_VALUE,
  DJ_PROMPT_NAME_MAX as DJ_PROMPT_NAME_MAX_VALUE,
  DJ_PROMPT_TEXT_MAX as DJ_PROMPT_TEXT_MAX_VALUE,
  DJ_PROMPT_TEXT_MIN as DJ_PROMPT_TEXT_MIN_VALUE,
  PERSONA_AVATAR_FILENAME_RE,
  PERSONA_DIAL_NEUTRAL,
  PERSONA_FREQUENCIES,
  PERSONA_LIMIT as PERSONA_LIMIT_VALUE,
  PERSONA_LINK_STYLES,
  PERSONA_SCRIPT_LENGTHS,
  PERSONA_SKILLS_LIMIT,
  PERSONA_SOUL_MAX,
  TTS_CHATTERBOX_VOICE_RE,
  TTS_CLOUD_PROVIDERS as TTS_CLOUD_PROVIDER_VALUES,
  TTS_ENGINES as TTS_ENGINE_VALUES,
  PERSONA_TTS_INHERIT,
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
  LLM_HEADER_NAME_RE,
  LLM_HEADER_VALUE_MAX,
  LLM_HEADER_VALUE_RE,
  LLM_HEADERS_MAX,
  SETTINGS_AAC_BITRATES,
  SETTINGS_LOUDNESS_SOURCES,
  SETTINGS_MP3_BITRATES,
  SETTINGS_OPUS_BITRATES,
  SETTINGS_SEARCH_PROVIDERS,
} from '../schemas/settings.js';

// Placeholders are substituted by renderDjPrompt(). {name} is mandatory:
// update() refuses any custom template that drops it.
export const DEFAULT_DJ_PROMPT_TEMPLATE = `You are {name}, the on-air DJ for {station}, a personal radio station broadcasting from {location}. {soul}.

Hard rules:
- Output ONLY the words to be spoken aloud. No stage directions, no asterisks, no quotes around your dialogue.
- Keep it brief by default — each task says how long.
- Never use radio-cliché tells: "and now", "next up", "coming up next", "and that was", or back-announcing with "that was [song] by [artist]". Be more natural.
- Don't repeat the artist and title robotically. Reference them in passing if at all.
- Reference the context you're given naturally; never invent facts that aren't in it (the weather, news, events, what's happening outside).
- Vary your opener and shape every time — never start the same way twice in a row, never use the same metaphor or framing as your last few lines.`;

// renderDjPrompt() falls back to DJ_SOULS[0] for a soulless persona; the agent
// path substitutes '' instead.
export const DJ_SOULS = [
  'warm, slightly understated, never corny — late-night BBC 6 Music presenter; observant, dry humour, specific',
  'thoughtful and a little wistful; finds small details in tracks and rooms; favours one well-chosen image over a list',
  'playful and dry; the occasional aside, never sarcastic; treats the studio like a kitchen at midnight',
  'plainspoken and grounded; says less, means more; would rather leave space than fill it',
  'quietly enthusiastic; treats every track like a small recommendation to a friend; specific over poetic',
];

// Ascending in chattiness; effectiveFrequency() steps up this ladder. 'silent'
// is absolute: only manual triggers, requests and programme beats still speak.
export const FREQUENCIES: readonly string[] = PERSONA_FREQUENCIES;

// Per-persona verbosity, ascending. Directives are LENGTH_PHRASES in
// llm/internal/prompts/system.ts.
export const SCRIPT_LENGTHS: readonly string[] = PERSONA_SCRIPT_LENGTHS;

// 'natural' (default) or 'announce' — see announceLinks().
export const LINK_STYLES: readonly string[] = PERSONA_LINK_STYLES;

export { TRANSITION_EFFECTS, type TransitionEffect } from '../schemas/settings.js';

// Per-persona tone dials, 0-10, default 5. Three bands (0-3 low, 7-10 high,
// 4-6 neutral); only a non-neutral band appends a style directive.
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

// Integer 0-10, neutral when unparseable. One chokepoint for normalizePersona,
// the seed roster and the admin form.
export const normalizeDial = clampPersonaDial;

// Returns '' when every dial sits in the neutral band, so renderDjPrompt
// appends nothing. Pinned in controller/scripts/llm-pure.test.ts.
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

// Every spoken segment is voiced by the on-air persona's own `tts` config; only
// jingle rendering falls back to defaultEngine. The dispatcher gates on
// isAvailable(), so an engine whose runtime is absent falls back to Piper.
export const TTS_ENGINES: readonly string[] = TTS_ENGINE_VALUES;
// The persona-only 'inherit' sentinel. PERSONA_TTS_ENGINES is deliberately not
// re-exported: ttsVoiceSlotSchema's `allowInherit` is the only way in.
export { PERSONA_TTS_INHERIT };

// DJ-voice trim in dB via Liquidsoap's `liq_amplify` annotation. A manual dial,
// not auto-normalisation.
export const TTS_GAIN_CLAMP_DB = TTS_GAIN_CLAMP_DB_VALUE;

// Finite number clamped to ±TTS_GAIN_CLAMP_DB and rounded to 0.1 dB; garbage
// falls to 0 (unity).
export const clampTtsGain = clampTtsGainFn;

// One gain per known engine (default 0); unknown keys dropped so a hand-edited
// file can't smuggle keys into the annotate path.
export function normalizeTtsGainMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const src = raw as Record<string, unknown> | null | undefined;
  for (const e of TTS_ENGINES) out[e] = clampTtsGain(src?.[e]);
  return out;
}

// Speech-rate MULTIPLIER: 1.0 = no change, lower = slower. Per-engine and
// per-persona speeds compose multiplicatively with daypart energy over the env
// base. Only Piper/Kokoro/cloud honour it.
export const TTS_SPEED_MIN = TTS_SPEED_MIN_VALUE;
export const TTS_SPEED_MAX = TTS_SPEED_MAX_VALUE;
export const TTS_SPEED_DEFAULT = TTS_SPEED_DEFAULT_VALUE;

// Finite number clamped to [TTS_SPEED_MIN, TTS_SPEED_MAX], rounded to 0.05;
// garbage falls to 1.0.
export const clampTtsSpeed = clampTtsSpeedFn;

// One clean multiplier per known engine (default 1.0), mirroring the gain map.
export function normalizeTtsSpeedMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const src = raw as Record<string, unknown> | null | undefined;
  for (const e of TTS_ENGINES) out[e] = clampTtsSpeed(src?.[e]);
  return out;
}

// find->replace pairs applied to every booth-bound line before any engine sees
// it. `from` is a literal phrase (regex-escaped at apply time); `to` '' drops
// the phrase.
export const TTS_CORRECTIONS_LIMIT = 100;
const TTS_CORRECTION_FROM_MAX = 80;
const TTS_CORRECTION_TO_MAX = 160;

// Lenient: never throws, drops malformed entries.
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

// Strict: whole-array replace, indexed throws, unknown keys stripped.
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

// Resolved by llm/provider.js. `openai-compatible` targets any self-hosted
// server via `llm.baseUrl`; `locca` is the same transport with a default base
// URL and onboarding discovery.
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

// Subset of LLM_PROVIDERS that can produce text embeddings (#493, #522).
export const EMBEDDING_PROVIDERS = [
  'ollama',
  'openai-compatible',
  'locca',
  'openrouter',
  'openai',
  'google',
  'requesty',
];

// Ollama context window; 0 disables, else floored into [2048, 131072].
// Non-numeric falls back to `def`. Shared by both legs.
export function clampNumCtx(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  if (raw <= 0) return 0;
  return Math.min(131072, Math.max(2048, Math.floor(raw)));
}

// repeat_penalty for openai-compatible / locca, clamped to [1.0, 2.0];
// 1.0 is OFF (never injected). Ollama ignores it.
export function clampRepeatPenalty(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(2.0, Math.max(1.0, raw));
}

// Agent deadline in MS, floored into [5s, 300s]; non-numeric falls back to `def`.
export function clampAgentTimeout(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(300_000, Math.max(5_000, Math.floor(raw)));
}

// Daily LLM token cap; 0 disables. No upper bound. Non-numeric falls back.
export function clampDailyTokenCap(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.max(0, Math.floor(raw));
}

// Percent of the cap; clamped to [0, 100], where 0 or 100 disables the tier.
export function clampBudgetSoftPct(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(100, Math.max(0, Math.floor(raw)));
}

// Per-call max output tokens (#712). 0 = off (each strategy's own default) and
// passes through unclamped; anything else is floored into the band.
export const MAX_OUTPUT_TOKENS_MIN = 500;
export const MAX_OUTPUT_TOKENS_MAX = 8000;
export function clampMaxOutputTokens(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  const n = Math.floor(raw);
  if (n <= 0) return 0;
  return Math.min(MAX_OUTPUT_TOKENS_MAX, Math.max(MAX_OUTPUT_TOKENS_MIN, n));
}

// 0 = follow the provider capability table, passed through unclamped. The band
// is imported from capabilities.ts so it cannot drift from discoveryStepsFor().
// The one place settings reaches past an `llm/` barrel: capabilities.ts imports
// nothing, while llm/provider.js would cycle back through settings.
export function clampDiscoverySteps(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  const n = Math.floor(raw);
  if (n <= 0) return 0;
  return Math.min(DISCOVERY_STEPS_MAX, Math.max(DISCOVERY_STEPS_MIN, n));
}

// Distinct-play no-repeat window, floored into [0, 1000]; 0 disables. The
// ceiling must stay under config.queue.recentPlaysMax (2500) or the window is
// silently truncated. Library-size clamping happens at use time.
export function clampNoRepeatWindow(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(1000, Math.max(0, Math.floor(raw)));
}

// Artist spacing in SLOTS (#1406), floored into [0, 25]; 0 leaves only the
// always-on back-to-back guard. The low ceiling is deliberate: this is consulted
// at the POINT OF CHOICE against the run's own candidates, so a large window
// mostly buys re-pick calls that end in a waived window.
export function clampArtistVarietyWindow(raw: unknown, def: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return def;
  return Math.min(25, Math.max(0, Math.floor(raw)));
}

// Validate + apply the connection fields shared by the primary LLM leg and its
// optional fallback. `label` prefixes error messages. The "openai-compatible
// needs baseUrl" rule is left to the caller (the fallback enforces it only when
// enabled), as are the primary-only station toggles.
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
  // The inline API key is NOT handled here: applyInlineKey() routes it into
  // settings.llm.keys at the call site, after the provider is resolved, so one
  // provider's key can't leak into another's slot (#657).
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
    // A plain baseUrl writes into the current provider's map slot; the flat
    // field is re-derived below.
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
  // Extra request headers for the openai-compatible transport (#1618).
  // Whole-map REPLACE, like tts.corrections and festivals: the editor always
  // sends the full set, so a merge would make a deleted row un-deletable.
  // `'set'` is the getRedacted() sentinel, resolved against the PRE-patch value.
  // Deliberately NOT keyed by provider the way baseUrl is: headers belong to one
  // server, so they follow the leg's inline API key instead.
  if (l.headers !== undefined) {
    if (!l.headers || typeof l.headers !== 'object' || Array.isArray(l.headers)) {
      throw new Error(`${label}.headers must be an object map of header name -> value`);
    }
    const incoming = l.headers as Record<string, unknown>;
    const existing = (target.headers as Record<string, string> | undefined) ?? {};
    const next: Record<string, string> = {};
    for (const rawName of Object.keys(incoming)) {
      const name = rawName.trim();
      if (!LLM_HEADER_NAME_RE.test(name)) {
        throw new Error(`${label}.headers has an invalid header name "${rawName}"`);
      }
      const raw = incoming[rawName];
      if (raw === 'set') {
        // Redacted on the way out: a row the operator did not retype must
        // survive their save.
        if (existing[name]) next[name] = existing[name];
        continue;
      }
      const v = String(raw ?? '').trim();
      if (!v) continue; // an emptied value drops the header, like providerBaseUrls
      if (v.length > LLM_HEADER_VALUE_MAX) {
        throw new Error(`${label}.headers.${name} must be 0-${LLM_HEADER_VALUE_MAX} chars`);
      }
      if (!LLM_HEADER_VALUE_RE.test(v)) {
        throw new Error(`${label}.headers.${name} must be printable ASCII on a single line`);
      }
      next[name] = v;
    }
    if (Object.keys(next).length > LLM_HEADERS_MAX) {
      throw new Error(`${label}.headers must have at most ${LLM_HEADERS_MAX} entries`);
    }
    target.headers = next;
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
  // 'required' (default) or 'auto'; anything else is a config error (#570).
  if (l.toolChoice !== undefined) {
    const v = String(l.toolChoice).trim();
    if (v !== 'required' && v !== 'auto') {
      throw new Error(`${label}.toolChoice must be "required" or "auto"`);
    }
    target.toolChoice = v;
  }
  // Single writer of the flat legacy `baseUrl`: always re-derived from the map
  // so a provider-only patch can't leave a stale URL (#1082). Runtime consumers
  // still read the flat field.
  const urls = (target.providerBaseUrls as Record<string, string> | undefined) ?? {};
  const prov = target.provider as string | undefined;
  target.baseUrl = (prov && urls[prov]) ? urls[prov] : '';
}

// Route an inline API key into `llmHost.keys[provider]` (#657) using the leg's
// already-resolved provider. '' clears that entry; 'set' (the getRedacted()
// sentinel) and undefined leave it untouched.
export function applyInlineKey(llmHost: { keys?: Record<string, string> }, provider: string, rawApiKey: unknown): void {
  if (rawApiKey === undefined || rawApiKey === 'set') return;
  const v = String(rawApiKey);
  if (v.length > 1000) throw new Error('llm.apiKey must be 0-1000 chars');
  if (!llmHost.keys || typeof llmHost.keys !== 'object') llmHost.keys = {};
  if (v) llmHost.keys[provider] = v;
  else delete llmHost.keys[provider];
}

// Lenient load-path read of a leg's stored `headers` map (#1618): repairs or
// drops, never throws. Same grammar and caps as the strict save path, imported
// from schemas/settings.ts rather than restated. Order is preserved.
export function normalizeLlmHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const rawName of Object.keys(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= LLM_HEADERS_MAX) break;
    const name = rawName.trim();
    if (!LLM_HEADER_NAME_RE.test(name)) continue;
    const v = String((raw as Record<string, unknown>)[rawName] ?? '').trim();
    if (!v || v.length > LLM_HEADER_VALUE_MAX || !LLM_HEADER_VALUE_RE.test(v)) continue;
    out[name] = v;
  }
  return out;
}

// Build the per-provider inline-key map from a stored settings.llm blob and
// migrate the two legacy single slots. Those were only ever written by the
// openai-compatible / locca path, so a value found under a different provider is
// a STALE compat token and is attributed to openai-compatible, not the current
// provider (#657).
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

// Build the per-provider base-URL map from a stored settings.llm blob (#1082),
// migrating the legacy single `baseUrl` into the current provider's slot.
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

// Cloud TTS vendors for the `cloud` engine. `openai-compatible` targets any
// self-hosted speech server via `tts.cloud.baseUrl`.
export const TTS_CLOUD_PROVIDERS: readonly string[] = TTS_CLOUD_PROVIDER_VALUES;

// Web-search backends. `duckduckgo` is free and keyless (useful only for
// entity/definition queries); `tavily` and `brave` read SEARCH_API_KEY;
// `searxng` is keyless self-hosted meta-search via settings.search.baseUrl.
export const SEARCH_PROVIDERS = SETTINGS_SEARCH_PROVIDERS;

// SEED mood vocabulary + each mood's CLAP sound-prompt. The operator edits the
// live list (settings.moods) and every consumer reads it through
// moodVocab()/moodEntries()/moodPromptFor(), NOT this constant. `clapPrompt` ''
// falls back to `${name} music`.
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

// Default mood NAMES, kept for the community catalog and as the accessor
// fallback before load(). Live reads go through moodVocab().
export const SHOW_MOODS = MOOD_DEFAULTS.map((m) => m.name);

// The 8 fixed day-periods (context.ts getTimeContext) and their seed moods.
// Operators re-point the mood; hour ranges and labels stay in code.
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

// The 6 fixed weather conditions and their seed moods; '' = no steer.
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

// Lenient: never throws, drops malformed/duplicate entries. Empty falls back to
// the seed defaults, since an empty vocabulary is unusable.
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

// Fills every known key from the stored value when it is a string, else from
// the seed default.
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

// Energy bands and vocal steering a show can pin. Vocals is ONE value, not a
// list: the three states are mutually exclusive and '' means no constraint.
// Both live in the shared show schema; re-exported here (widened from readonly
// because callers do `SHOW_ENERGY.includes(x)` on unknown strings).
export const SHOW_ENERGY: readonly string[] = SHOW_ENERGY_VALUES;
export const SHOW_VOCALS: readonly string[] = SHOW_VOCALS_VALUES;

// Seeded festival calendar; persisted festivals replace it once edited.
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

// The 54 official Kokoro voices from kokoro-onnx v1.0. Any voice matching
// KOKORO_VOICE_RE passes validation.
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

// Phonemizer languages the Kokoro worker accepts; '' = auto-detect from the
// voice-code prefix. Synced with kokoro_worker.py's prefix->lang mapping.
// Every entry must EXACTLY match a row in `espeak-ng --voices` — EspeakBackend
// validates verbatim and throws otherwise, so `fr-fr`, never `fr` (#1213).
export const KOKORO_LANGS = ['en-gb', 'en-us', 'es', 'it', 'fr-fr', 'hi', 'pt-br', 'ja', 'cmn'];
export const KOKORO_LANG_RE = new RegExp(`^(${KOKORO_LANGS.join('|')})$`);

// Codes offered before they were checked against espeak-ng, kept accepted so a
// stored value is rewritten rather than reverting to auto-detect. Mirrored by
// `lang_aliases` in controller/scripts/kokoro_worker.py for the env var.
export const KOKORO_LANG_ALIASES: Record<string, string> = { fr: 'fr-fr' };

/** Canonicalise a Kokoro phonemizer language; unknown values pass through for
 *  the caller's own validation to reject. */
export function canonicalKokoroLang(lang: string): string {
  return KOKORO_LANG_ALIASES[lang] || lang;
}

// PocketTTS built-in voices. `tts.voice` for pocket-tts may be one of these (or
// any id passing POCKET_TTS_VOICE_RE) OR a `.wav` filename in the shared voice
// folder (#213).
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
// Reference-WAV basenames in config.voices.dir: no path separators, .wav suffix.
// Empty is valid (use the built-in default voice). Used by chatterbox and
// pocket-tts (#213).
export const CHATTERBOX_VOICE_RE = TTS_CHATTERBOX_VOICE_RE;
// The entity-id pattern shows, personas and skill assignments share. Defined
// once as SHOW_ID_RE in the shared show schema: a mirrored module may import
// only 'zod', so it is homed in the first feature that needed it.
export const ID_RE = SHOW_ID_RE;
// `<personaId>.(png|jpg|jpeg|webp)`. The id segment reuses ID_RE so an avatar
// field can never name a basename outside persona-avatars. Empty = no avatar.
export const AVATAR_FILENAME_RE = PERSONA_AVATAR_FILENAME_RE;
// Skill slugs. The skills registry owns which slugs exist; settings only checks
// the shape, aliasing the shared skill schema's pattern (skills/loader.ts's
// SLUG_RE is the third name for it) so the three cannot disagree.
export const SKILL_SLUG_RE = SKILL_SLUG_PATTERN;

// Exported for routes/personas.ts, which 409s before update() would throw.
export const PERSONA_LIMIT = PERSONA_LIMIT_VALUE;
// Persona `soul` cap. Injected into EVERY free-text DJ call, so it is a
// recurring per-call token cost; nothing structural depends on the number. Keep
// in lockstep with SOUL_MAX in web/components/admin/personas/constants.ts and
// the AI-fill draft schema. Consumers where a soul is not the speaking seat
// clamp further (soulBrief() in llm/internal/core/pure.ts).
export const SOUL_MAX = PERSONA_SOUL_MAX;
export { SHOWS_LIMIT } from '../schemas/show.js';
// Show `topic` cap. Like SOUL_MAX it is a recurring per-call token cost, not a
// structural limit, and is matched to it. Keep in lockstep with TOPIC_MAX in
// web/components/admin/shows/types.ts. Defined in the shared schema.
export { SHOW_TOPIC_MAX } from '../schemas/show.js';
// Guest co-hosts per show. Small on purpose: each is a full persona the speaker
// rotation can hand a segment to.
export { GUESTS_PER_SHOW, PLAYLISTS_PER_SHOW, EXCLUDED_PLAYLISTS_PER_SHOW };
// Values per multi-select music filter (moods / genres / eras). Within one
// attribute values OR at pick time; across attributes they AND. Generous
// because genre matching only REFINES, never broadens, so a strict show must
// name every library tag it wants. Keep in lockstep with FILTER_VALUES_MAX in
// web/components/admin/shows/types.ts.
export { SHOW_FILTER_VALUES_MAX };
// Must comfortably exceed a realistic skill library: unticking one skill on an
// "all skills" (null) persona materialises the full catalog minus one.
export const SKILLS_PER_PERSONA_LIMIT = PERSONA_SKILLS_LIMIT;
// djPrompts text bounds; keep in lockstep with PROMPT_MIN/PROMPT_MAX in
// web/components/admin/personas/constants.ts.
export const DJ_PROMPT_LIMIT = DJ_PROMPT_LIMIT_VALUE;
export const DJ_PROMPT_NAME_MAX = DJ_PROMPT_NAME_MAX_VALUE;
export const DJ_PROMPT_TEXT_MIN = DJ_PROMPT_TEXT_MIN_VALUE;
export const DJ_PROMPT_TEXT_MAX = DJ_PROMPT_TEXT_MAX_VALUE;
// djHouseRules cap. Appended to all three prompt paths, unlike the djPrompt
// template which only the scripted-talk path renders (#1182, #1420). Empty =
// off. Keep in lockstep with HOUSE_RULES_MAX in
// web/components/admin/personas/constants.ts.
export const DJ_HOUSE_RULES_MAX = 2000;

// Playlist anchors: the union of the named Navidrome playlists becomes the
// show's candidate pool. Never validated against the live server, so a dead id
// contributes nothing at pick time rather than failing. Empty = no anchor.
// Guest co-hosts are persona ids other than the host; order is the operator's
// billing order, and dupes, the host itself and dangling ids are dropped.
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

// Multi-value music filters (#929): OR within an attribute, AND across them.
// Legacy singular fields are migrated to one-element lists on load. The lenient
// coercers below serve normalizeShows; the strict validator reuses the shapes.

// One era window; at least one bound must be set. Multiple windows let a show
// span non-adjacent decades.
export type { EraWindow };

// Webhook shape + event list live in schemas/webhook.ts; re-exported here so
// existing importers keep working.
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

// A show as produced by normalizeShows. The plural filter lists are canonical;
// legacy singular fields are already migrated.
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
  /** Minimum track length in seconds (#1573). null = inherit the station
   *  default, 0 = no floor. See settings/persona.effectiveMinTrackSec. */
  minTrackLengthSeconds: number | null;
  playlistIds: string[];
  playlistStrict: boolean;
  /** Full rotation (#1612): with playlistStrict on, every track in the anchor
   *  airs once before any of them repeats. Inert without it. */
  playlistExhaust: boolean;
  excludedPlaylistIds: string[];
  /** Operator organisation tags. Filters the admin list; steers nothing on
   *  air, which is why resolveShow() does not carry them through. */
  tags: string[];
}

// Dedup + cap over one already-plural list. The legacy singular fold lives ONLY
// in migrateLegacyShowFields (#929), shared by the schema preprocess and the
// lenient load path; never add a second singular fallback here.
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
  // Lenient: keep any non-empty string. The effective vocabulary is unknown
  // while the cache is still being built, so filtering here would strip custom
  // moods; validateShowsStrict enforces the live vocabulary on save.
  return coerceShowList(migrateLegacyShowFields(item).moods,
    (v) => (typeof v === 'string' && v.trim() ? v.trim() : null),
    (v) => v);
}

export function coerceShowGenres(item: unknown): string[] {
  // The comma-split of a legacy singular `genre` lives in
  // migrateLegacyShowFields; plural-array entries are taken as-is.
  return coerceShowList(migrateLegacyShowFields(item).genres,
    (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, SHOW_GENRE_MAX) : null),
    (v) => v.toLowerCase());
}

export function coerceShowEnergies(item: unknown): string[] {
  return coerceShowList(migrateLegacyShowFields(item).energies,
    (v) => (typeof v === 'string' && SHOW_ENERGY.includes(v) ? v : null),
    (v) => v);
}

// Anything unrecognised reads as no constraint: losing the vocal steering is a
// smaller failure than a show that stops playing music.
export function coerceShowVocals(item: unknown): string {
  const v = (item as { vocals?: unknown } | null | undefined)?.vocals;
  return typeof v === 'string' && SHOW_VOCALS.includes(v) ? v : '';
}

export function coerceShowEras(item: unknown): EraWindow[] {
  // Window repair is the schema's repairEraWindow, so this coercer can't
  // disagree with the validator.
  return coerceShowList(migrateLegacyShowFields(item).eras, repairEraWindow,
    (e) => `${e.fromYear ?? ''}:${e.toYear ?? ''}`);
}

// Playlist anchors are repaired by schemas/show.ts repairShowForLoad, like
// every other list field.

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function mintId(prefix) {
  return prefix + randomBytes(3).toString('hex');
}

// The weekly grid + timed takeover (#930) vocabulary lives in
// schemas/schedule.ts so the admin UI runs the same bounds; re-exported here.
export {
  emptyWeek,
  isDefaultTakeover,
  OVERRIDE_MIN_MINUTES,
  OVERRIDE_MAX_MINUTES,
  SCHEDULE_DAYS,
  SCHEDULE_HOURS,
  takeoverShowId,
} from '../schemas/schedule.js';
export type { ScheduleOverride, ScheduleWeek } from '../schemas/schedule.js';

// Seed roster shipped on a fresh install, and the migration fallback when a
// legacy `dj` block carries no real souls. Engine is `piper` (local, no key);
// each stored `voice` is a different Kokoro voice, so switching engine gives
// different-sounding DJs with no further editing.
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
    tts: { engine: PERSONA_TTS_INHERIT, cloudProvider: 'openai', voice: 'bm_george', gainDb: 0, speed: 1 },
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
    tts: { engine: PERSONA_TTS_INHERIT, cloudProvider: 'openai', voice: 'bf_alice', gainDb: 0, speed: 1 },
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
    tts: { engine: PERSONA_TTS_INHERIT, cloudProvider: 'openai', voice: 'bm_daniel', gainDb: 0, speed: 1 },
  },
];

// Allowed MP3 bitrates, shared by the hourly archive and /stream.mp3.
// %mp3(bitrate=…) needs a parse-time int, so radio.liq pre-bakes one encoder
// branch per value: adding a value here needs a branch there too.
// Homed in schemas/settings.ts (#1348); re-exported so no call site moved.
export const MP3_BITRATES = SETTINGS_MP3_BITRATES;
// Same parse-time-literal constraint as %mp3: add a radio.liq branch per value.
export const OPUS_BITRATES = SETTINGS_OPUS_BITRATES;
export const AAC_BITRATES = SETTINGS_AAC_BITRATES;

// Where per-track loudness comes from (#998): an embedded ReplayGain tag, the
// analyzer's measured LUFS, or tag-with-measured-fallback (the default).
export const LOUDNESS_SOURCES = SETTINGS_LOUDNESS_SOURCES;
export type LoudnessSource = (typeof LOUDNESS_SOURCES)[number];
