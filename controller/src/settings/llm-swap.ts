// "Swap with primary": exchange the primary and backup LLM legs in one save.
//
// Pure: given the stored settings, build the ONE patch that settings.update()
// applies, so the swap rides the ordinary save path — the same validation, the
// same persistence, the same post-save hooks — rather than a second writer of
// settings.llm. It runs on the controller and never in the browser because a
// leg's custom headers reach the admin UI redacted ('set'), and a redacted value
// posted onto the OTHER leg would resolve against that leg's headers.
//
// What moves is exactly LLM_LEG_FIELDS. What stays put:
//   - `fallback.enabled` (the swap needs it on, and keeps it on);
//   - API keys: `llm.keys` is keyed by PROVIDER and read by both legs, so a key
//     follows its provider to whichever leg now names it;
//   - every station-wide LLM field (timeouts, budgets, maxOutputTokens, picker
//     routes…).
// Swapping twice therefore restores the starting legs exactly.
//
// The embedding leg can inherit from the PRIMARY (a blank provider, base URL,
// Ollama URL, headers or key all read the chat leg's). A swap must not move the
// library's vectors to another model, so every value the embedding leg was
// inheriting is pinned to what it resolved to before the swap. Anything the
// operator set explicitly in the Library tagger is left alone. A pin is
// written once and stays: swapping back restores the two LLM legs, not the
// embedding leg's inheritance — so the confirm dialog names what will be
// pinned (planLlmSwap's `pinned`, previewed by GET /settings/llm/swap/fit).

import { DEFAULTS } from './defaults.js';
import { EMBEDDING_API_KEY_MAX } from './vocab.js';

/** Every per-leg connection field, i.e. every field applyLlmLegPatch writes on
 *  both legs apart from the derived flat `baseUrl` and the inline `apiKey`
 *  (routed into `llm.keys` by provider). llm-swap.test.ts pins this list
 *  against applyLlmLegPatch so a new per-leg field cannot be left behind. */
export const LLM_LEG_FIELDS = [
  'provider',
  'model',
  'ollamaUrl',
  'providerBaseUrls',
  'headers',
  'compatibleMode',
  'reasoning',
  'toolChoice',
  'discoverySteps',
  'numCtx',
  'repeatPenalty',
  'geminiSafety',
] as const;

type Leg = Record<string, unknown>;

/** What the embedding leg resolved to before the swap (resolveEmbeddingCfg()),
 *  with a blank Ollama/locca URL resolved to the default server it reaches —
 *  the route's planSwap() does that, since a blank pin would follow the new
 *  primary. */
export interface ResolvedEmbedding {
  provider: string;
  baseUrl?: string;
  ollamaUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function legValue(leg: Leg | undefined, key: string, defaults: Leg): unknown {
  const v = leg?.[key];
  return clone(v !== undefined ? v : (defaults[key] ?? (DEFAULTS.llm.fallback as Leg)[key]));
}

/** `applyLlmLegPatch` MERGES providerBaseUrls, so a swapped map must also blank
 *  every provider the incoming map lacks, or the target leg keeps its own. */
function replacingMap(incoming: unknown, existing: unknown): Record<string, string> {
  const inc = (incoming && typeof incoming === 'object' ? incoming : {}) as Record<string, string>;
  const ex = (existing && typeof existing === 'object' ? existing : {}) as Record<string, string>;
  const out: Record<string, string> = {};
  for (const p of Object.keys(ex)) out[p] = '';
  for (const p of Object.keys(inc)) out[p] = inc[p];
  return out;
}

function legPatch(from: Leg | undefined, fromDefaults: Leg, onto: Leg | undefined): Leg {
  const patch: Leg = {};
  for (const key of LLM_LEG_FIELDS) patch[key] = legValue(from, key, fromDefaults);
  patch.providerBaseUrls = replacingMap(patch.providerBaseUrls, onto?.providerBaseUrls);
  return patch;
}

export class LlmSwapError extends Error {}

/** Embedding fields a swap can pin, in the order the dialog names them. */
export type EmbeddingPin = 'provider' | 'providerBaseUrls' | 'ollamaUrl' | 'headers' | 'apiKey';

export interface LlmSwapPlan {
  /** The settings.update() patch. */
  patch: Record<string, unknown>;
  /** Embedding fields the swap pins because they were inheriting the primary's. */
  pinned: EmbeddingPin[];
  /** The embedding leg inherits the primary's inline key, but the key is longer
   *  than `embedding.apiKey` holds (EMBEDDING_API_KEY_MAX), so it is NOT pinned:
   *  pinning it would make update() refuse the whole swap over a field the
   *  operator never touched. Once the primary moves, embeddings may lose that
   *  key — the caller says so. */
  keyNotPinned: boolean;
}

/**
 * The swap, planned. `stored` is settings.get() (raw, not redacted).
 * `embedding` is the embedding leg as resolved BEFORE the swap and
 * `embeddingEnvKey` whether EMBEDDING_API_KEY is set (the env key outranks an
 * inherited chat key, so there is nothing to pin when it is).
 */
export function planLlmSwap(
  stored: { llm?: Leg & { fallback?: Leg; keys?: Record<string, string> }; embedding?: Leg },
  embedding: ResolvedEmbedding,
  embeddingEnvKey = false,
): LlmSwapPlan {
  const llm = stored.llm ?? {};
  const fb = llm.fallback;
  if (!fb?.enabled) throw new LlmSwapError('no backup LLM is enabled, so there is nothing to swap with');

  const primaryDefaults = DEFAULTS.llm as unknown as Leg;
  const fallbackDefaults = DEFAULTS.llm.fallback as unknown as Leg;
  const patch: Record<string, unknown> = {
    llm: {
      ...legPatch(fb, fallbackDefaults, llm),
      fallback: { enabled: true, ...legPatch(llm, primaryDefaults, fb) },
    },
  };

  const { pin, keyNotPinned } = embeddingPins(llm, stored.embedding ?? {}, embedding, embeddingEnvKey);
  if (Object.keys(pin).length) patch.embedding = pin;
  return { patch, pinned: Object.keys(pin) as EmbeddingPin[], keyNotPinned };
}

/** planLlmSwap's patch alone. */
export function buildLlmSwapPatch(
  stored: Parameters<typeof planLlmSwap>[0],
  embedding: ResolvedEmbedding,
  embeddingEnvKey = false,
): Record<string, unknown> {
  return planLlmSwap(stored, embedding, embeddingEnvKey).patch;
}

/** Freeze every value the embedding leg inherits from the primary leg. */
function embeddingPins(
  llm: Leg & { keys?: Record<string, string> },
  own: Leg,
  resolved: ResolvedEmbedding,
  envKey: boolean,
): { pin: Partial<Record<EmbeddingPin, unknown>>; keyNotPinned: boolean } {
  const pin: Partial<Record<EmbeddingPin, unknown>> = {};
  const blank = (v: unknown) => typeof v !== 'string' || !v.trim();
  if (blank(own.provider)) pin.provider = resolved.provider;
  const provider = (pin.provider ?? own.provider) as string;
  const ownUrls = (own.providerBaseUrls ?? {}) as Record<string, string>;
  if (blank(ownUrls[provider]) && blank(own.baseUrl) && resolved.baseUrl) {
    pin.providerBaseUrls = { [provider]: resolved.baseUrl };
  }
  if (blank(own.ollamaUrl) && resolved.ollamaUrl) pin.ollamaUrl = resolved.ollamaUrl;
  const ownHeaders = (own.headers ?? {}) as Record<string, string>;
  if (!Object.keys(ownHeaders).length && Object.keys(resolved.headers ?? {}).length) {
    pin.headers = { ...(resolved.headers ?? {}) };
  }
  // Only the chat leg's INLINE key (llm.keys) moves with the chat provider. A
  // provider's own env var still resolves after the swap, and is never copied
  // into settings.json.
  let keyNotPinned = false;
  const chatInlineKey = llm.keys?.[(llm.provider as string) ?? ''];
  if (blank(own.apiKey) && !envKey && chatInlineKey && resolved.apiKey === chatInlineKey) {
    if (chatInlineKey.trim().length > EMBEDDING_API_KEY_MAX) keyNotPinned = true;
    else pin.apiKey = resolved.apiKey;
  }
  return { pin, keyNotPinned };
}
