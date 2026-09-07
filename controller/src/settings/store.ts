// The loaded-settings cache and the accessors that read it. This is the seam
// that keeps the rest of the settings/ modules free of an import cycle back to
// settings.ts: load()/update() own writing the cache, everyone else reads it
// through get()/peek() here.
//
// Part of the settings/ split — see ../settings.ts for the public barrel.

import { MOOD_DEFAULTS, PERIOD_MOOD_DEFAULTS, WEATHER_MOOD_DEFAULTS } from './vocab.js';
import { DEFAULTS } from './defaults.js';

// The loaded settings. Null until load() has run. Only settings.ts writes it,
// and only through setCache() — everything else reads via get()/peek().
let cache: any = null;

// The raw cache, null included. Callers that must distinguish "not loaded yet"
// from "loaded" want this; everyone else wants get(), which substitutes the
// shipped defaults so a pre-load read still answers sensibly.
export function peek(): any {
  return cache;
}

// The single writer, called by load() and update() in settings.ts.
export function setCache(next: any): any {
  cache = next;
  return cache;
}

export function get() {
  return cache || DEFAULTS;
}

export function getDefaults() {
  return DEFAULTS;
}

// --- Live mood accessors — the single seam every consumer reads through, so an
// operator edit takes effect with no restart. Pre-load, get() returns DEFAULTS,
// so these still answer with the seed vocabulary (keeps the standalone
// audio-moods unit test working without a settings.load()). ---
export function moodEntries(): Array<{ name: string; clapPrompt: string }> {
  const m = get().moods;
  return Array.isArray(m) && m.length ? m : MOOD_DEFAULTS;
}
export function moodVocab(): string[] {
  return moodEntries().map((m) => m.name);
}
export function moodPromptFor(name: string): string {
  const e = moodEntries().find((m) => m.name === name);
  return e?.clapPrompt ? e.clapPrompt : `${name} music`;
}
export function moodScheduleFor(period: string): string {
  const s = get().moodSchedule || {};
  return s[period] ?? PERIOD_MOOD_DEFAULTS[period] ?? '';
}
export function weatherMoodFor(condition: string): string {
  const w = get().weatherMoods || {};
  return (w[condition] ?? WEATHER_MOOD_DEFAULTS[condition] ?? '') || '';
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

// One header map with every VALUE masked to the 'set' sentinel, names intact.
function maskHeaderValues(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const name of Object.keys(raw as Record<string, unknown>)) {
    out[name] = (raw as Record<string, unknown>)[name] ? 'set' : '';
  }
  return out;
}

// Settings with secret fields masked — for the admin /settings response.
export function getRedacted() {
  const s = get();
  const clone = JSON.parse(JSON.stringify(s));
  if (clone.llm) {
    // Masked against the leg's RESOLVED key — keys[provider] — never against
    // the field itself. `llm.apiKey` is a legacy WRITE-ONLY channel: load()
    // hardcodes it to '' because the real store is the per-provider map
    // (#657), so `s.llm.apiKey ? …` could only ever emit ''. And '' is not
    // neutral here — applyInlineKey() reads it as "clear this provider's key".
    // The backup path replays this whole object through update()
    // (routes/backup.ts), so an unconditional '' deleted the stored key for
    // whichever provider was the primary leg and for whichever was the
    // fallback, leaving the station pointed at a provider whose credential had
    // just been dropped (#1351). Every other provider's key was untouched,
    // which is why it read as "backups are fine".
    clone.llm.apiKey = llmKeyFor(s.llm?.provider ?? '') ? 'set' : '';
    // Per-provider inline keys masked to 'set' | '' per entry, so the admin UI
    // can show which providers have a key on file without exposing the value.
    clone.llm.keys = {};
    for (const p of Object.keys(s.llm?.keys || {})) {
      clone.llm.keys[p] = s.llm.keys[p] ? 'set' : '';
    }
    // Custom request headers (#1618): NAMES stay visible — the operator has to
    // see which headers a gateway is being sent — while every VALUE is masked
    // to the same 'set' sentinel, because a routing header and a credential
    // header are the same field and only the operator knows which they typed.
    // This is `webhooks[].authHeader` in the other direction. applyLlmLegPatch
    // reads 'set' back as "keep the stored value", so the redacted map
    // round-trips through a save untouched.
    clone.llm.headers = maskHeaderValues(s.llm?.headers);
  }
  // Same channel, same map — the fallback leg's key also lives in llm.keys,
  // under ITS provider (update() routes it there via applyInlineKey).
  if (clone.llm?.fallback) {
    clone.llm.fallback.apiKey = llmKeyFor(s.llm?.fallback?.provider ?? '') ? 'set' : '';
    clone.llm.fallback.headers = maskHeaderValues(s.llm?.fallback?.headers);
  }
  if (clone.tts?.cloud) {
    clone.tts.cloud.apiKey = s.tts?.cloud?.apiKey ? 'set' : '';
    clone.tts.cloud.compatApiKey = s.tts?.cloud?.compatApiKey ? 'set' : '';
  }
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
  if (clone.privacy) {
    clone.privacy.password = s.privacy?.password ? 'set' : '';
  }
  return clone;
}

// Resolve the effective per-call output-token cap. Returns the operator's
// configured value when set (> 0), else `fallback` — the strategy's own
// built-in default. The single read point for settings.llm.maxOutputTokens;
// strategy/text|object|agent all default their maxOutputTokens param through it.
export function resolveMaxOutputTokens(fallback: number): number {
  const v = get().llm?.maxOutputTokens;
  return typeof v === 'number' && v > 0 ? v : fallback;
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

