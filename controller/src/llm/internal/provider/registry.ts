// Provider registry: resolves and caches the LanguageModel for `settings.llm`.
// Every model call goes through here; call sites never name a provider.
// `ollama` is the default and needs no key; cloud providers are opt-in.

import { createGateway } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';
import {
  currentKey,
  currentKeyOrHead,
  fingerprint,
  getLastFailure,
  GOOGLE_KEY_ENV,
  poolConfigured,
  poolEpoch,
  recordLastFailure,
  reportKeyFailure,
  reportKeySuccess,
} from '../../../util/google-key-pool.js';
import { recordRawRequest, rawDebugEnabled } from '../telemetry/raw-debug.js';
import { capabilitiesFor, appliedRepeatPenalty, appliedNumCtx, thinkingMandatoryModel } from './capabilities.js';

// Built clients, keyed by a signature covering every field captured at
// construction, so a settings edit is picked up with no explicit invalidation.
const clientCache = new Map();

export function llmCfg() {
  const llm = settings.get().llm
    || { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
  // The stored `apiKey` slot is legacy (always '' after settings.load()); the
  // active key is resolved per-provider from settings.llm.keys (#657). Empty →
  // the provider cases below fall through to their env var.
  return { ...llm, apiKey: settings.llmKeyFor(llm.provider) };
}

// Single raw-request capture point, wired into every provider's `fetch` option
// in languageModel(). Gated at call time; records method + URL + body only,
// never headers.
export function debugFetch(url: any, init: any) {
  if (rawDebugEnabled()) {
    try {
      const body = init?.body;
      if (typeof body === 'string') {
        const method = init?.method || 'POST';
        const target = typeof url === 'string' ? url : (url?.url ?? String(url));
        recordRawRequest(method, target, body);
      }
    } catch { /* capture must never break a model call */ }
  }
  return fetch(url, init);
}

/**
 * The Google transport, and where key rotation happens.
 *
 * Two jobs, in this order:
 *
 *  1. Stamp `x-goog-api-key` with whichever pooled key is currently live, so
 *     ONE cached client serves the whole pool. The alternative — rebuilding the
 *     provider per key — invalidates the client cache on every rotation and
 *     drops the per-provider headers captured at construction.
 *
 *  2. Rotate ON a quota 429: park the exhausted key for as long as Google
 *     asked, then re-issue the same request with the next key.
 *
 * Rotating here rather than in withTransientRetry is deliberate. In the retry
 * layer a 429 would either sleep on the key that just refused (burning the
 * agent deadline on a key whose quota is gone until tomorrow) or escalate
 * straight to the backup leg, skipping the nine other keys entirely. Doing it
 * at the transport means the SDK's own retry budget never observes the 429,
 * `withTransientRetry` and `withFailover` are untouched, and rotation composes
 * with the existing dead-air fallbacks for free.
 *
 * Safe to re-send: every request through here is a model generation (LLM
 * prompt or TTS render), both idempotent, so a repeat costs tokens and nothing
 * else. Bounded by the pool — each recursion parks a key, so the depth is the
 * pool size and `currentKey()` returning the same key ends it.
 *
 * With no pool configured this is exactly the SDK's own transport, so an
 * unconfigured station is byte-identical to before.
 */
/**
 * The `apiKey` to hand `createGoogleGenerativeAI` at CONSTRUCTION time.
 *
 * This exists because the SDK resolves a missing `apiKey` from the environment
 * variable `GOOGLE_GENERATIVE_AI_API_KEY` and throws `LoadAPIKeyError` if that
 * is also unset — it never looks at the pool. Passing `apiKey` only when
 * `cfg.apiKey` was set therefore broke the exact configuration the feature is
 * for: a pool-only station (no singular variable at all) failed every chat
 * generation and every embedding with ZERO fetch calls, so the pooled
 * transport never ran. googleKeyFetch re-stamps the real per-request key on
 * every call, so the value given here is only what the constructor requires —
 * but it must be a real configured credential, not a placeholder, because a
 * placeholder would be sent as the key whenever the pool has nothing live.
 */
export function googleApiKeyForSdk(cfg: any): string | undefined {
  // Order matters, and the pool is consulted for TWO different reasons, so the
  // two middle entries are not interchangeable.
  //
  // `cfg.apiKey` first: it is the operator's explicitly configured single key,
  // and it is the only credential a legacy station has.
  //
  // Then the pool, and here the distinction is the whole fix. `currentKey()` is
  // the LIVE key, and it is deliberately empty when every key is held. Falling
  // straight through to the legacy variable in that state meant a pool-only
  // station — no singular variable at all — had nothing to construct a client
  // with, so `createGoogleGenerativeAI` threw LoadAPIKeyError and every
  // generation failed while the pool was merely WAITING. That is the
  // "creating a client while every key is held leaves it failing" case: the
  // station's ability to recover was gated on a client that could not be built,
  // so nothing ever reached the code that would have noticed the hold lapsed.
  // `currentKeyOrHead()` hands back a real configured credential instead, which
  // the per-request transport re-stamps the moment a live key exists again — so
  // the hold becomes a wait rather than a failure.
  //
  // The legacy variable stays last: it is the only credential a station with no
  // pool has, and `undefined` here is what lets the SDK read it itself exactly as
  // it always did.
  return cfg.apiKey || currentKey() || currentKeyOrHead() || process.env[GOOGLE_KEY_ENV] || undefined;
}

export async function googleKeyFetch(url: any, init?: any): Promise<Response> {
  // Explicit pool configuration is what arms rotation. A legacy single-key
  // station is NOT a one-key pool: it keeps the plain transport, so an
  // unhinted 429 parks nothing and every call retries as it always did.
  if (!poolConfigured()) return debugFetch(url, init);
  return rotateGoogle(url, init, new Set());
}

/**
 * One call's rotation, bounded by the POOL SIZE and by nothing else.
 *
 * `attempted` is request-local and is what actually terminates this. The
 * previous version re-derived eligibility from shared holds on every recursion,
 * and a hold shorter than the request that follows it expired mid-call, so the
 * key that had just failed came back as eligible and was retried — two keys and
 * a 10ms hint gave A,B,A,B,A,B… with no stop. Holds are shared state whose
 * lifetime has nothing to do with this call, so they cannot bound this call.
 * The bound is also capped at the pool size, so a pool mutated mid-call (an
 * operator adding a key) cannot extend the recursion past a sane depth either.
 */
async function rotateGoogle(url: any, init: any, attempted: Set<string>): Promise<Response> {
  const key = currentKey(attempted);
  if (!key) {
    // Every key has been tried on THIS call. Answer from the last real failure
    // instead of spending another request on a credential we have just been
    // told is dead — while carrying enough of that failure for
    // withTransientRetry / withFailover to classify it and escalate to the
    // backup leg.
    const prior = getLastFailure();
    console.log('[google] every pooled key is exhausted for this call — replaying the last quota failure without a request');
    const headers = new Headers(prior?.headers || {});
    if (!headers.has('retry-after')) headers.set('retry-after', '60');
    return new Response(
      prior?.body ?? '{"error":{"code":"quota_exceeded","message":"every pooled key is exhausted"}}',
      { status: prior?.status ?? 429, statusText: prior?.statusText ?? 'Too Many Requests', headers },
    );
  }
  attempted.add(key);

  const headers = new Headers(init?.headers || {});
  headers.set('x-goog-api-key', key);
  const res = await debugFetch(url, { ...init, headers });

  // Only a 2xx ends this call, and only a 2xx clears the key's history.
  //
  // A key that genuinely answered is demonstrably not exhausted, so its hold and
  // strike count go and the next failure starts from the short interval again.
  // Without that the escalation ladder ratchets on failures separated by any
  // number of successes, and a key that recovered stayed pinned at the ceiling.
  //
  // The condition used to be "not a 429 and not a 401", on the reasoning that
  // anything else means the key is fine. That is false for most of what is left.
  // A 503 is Google being briefly overloaded and a 403 is this key's project
  // refusing the request — neither says the QUOTA came back, and both arrive on
  // a key that is frequently already parked. Treating them as success wiped the
  // hold, zeroed the escalation strikes and dropped the pool's recorded failure,
  // so a pool whose keys were all still exhausted reported itself healthy, and the
  // next real 429 restarted the ladder from the bottom. The evidence about the
  // pool must survive anything that is not an answer.
  //
  // 429 and 401 are the two statuses that mean something about the CREDENTIAL, so
  // they park and rotate below; 402 and the generation-blocked codes return
  // untouched, which is right — they are not key problems and another key would
  // refuse the same input.
  if (res.status >= 200 && res.status < 300) {
    reportKeySuccess(key);
    return res;
  }
  if (res.status !== 429 && res.status !== 401) {
    // Not a success, and not a credential verdict. Hand the response back with
    // the key's history exactly as it was.
    return res;
  }

  const body = await res.text().catch(() => '');
  // Record the HEADERS too, not just the body. The replayed response is what
  // the retry/failover layers classify, and `Retry-After` is one of the things
  // they read: dropping it changed a 429's timing classification between the
  // first attempt and the replay, which could prevent the backup leg from ever
  // being selected.
  recordLastFailure(res.status, res.statusText, body, res.headers);
  const heldMs = reportKeyFailure(key, body);
  const next = currentKey(attempted);
  if (!next) {
    console.log(`[google] every pooled key failed on this call — returning the ${res.status} upstream`);
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }
  console.log(`[google] key ${fingerprint(key)} held for ${Math.round(heldMs / 1000)}s — retrying with ${fingerprint(next)}`);
  return rotateGoogle(url, init, attempted);
}

// llama.cpp / vLLM / LM Studio honour chat_template_kwargs.enable_thinking=false;
// the AI SDK's openai provider has no field for it, so it is injected into the
// body. `baseFetch` is the transport to delegate to once rewritten — debugFetch
// in languageModel() (so the capture is post-injection), global fetch elsewhere.
export function noThinkFetch(url: any, init: any, baseFetch: any = fetch) {
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body);
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: false,
      };
      init = { ...init, body: JSON.stringify(body) };
    } catch { /* not JSON — leave the request untouched */ }
  }
  return baseFetch(url, init);
}

// Fetch wrapper for the openai-compatible / locca (llama.cpp / vLLM / LM Studio)
// path. @ai-sdk/openai drops anything outside its own providerOptions schema, so
// these knobs are injected into the JSON body (servers ignore keys they don't know):
//   • repeat_penalty — llama.cpp defaults to 1.0 (off); this is the only path
//     that carries the operator's floor to the agent/object calls. vLLM spells
//     it `repetition_penalty`. If a configured penalty goes missing, check
//     `settings.get().llm.repeatPenalty` first — #1327 was settings.load()
//     dropping the field, not the never-clobber guard here.
//   • reasoning off → enable_thinking:false + reasoning_format + an
//     OpenRouter-style `reasoning` block; each covers a different server
//     (llama.cpp dialect, Gemma-4 leaking thought into `content`, GLM reading
//     top-level `thinking.type`). reasoningMandatoryModel carries the
//     effort:'minimal' exception.
//   • parallel_tool_calls:false, only when tools are present (strict servers
//     reject the field otherwise) — the agent is one call per step, and the
//     peg-gemma4 parser 500s on a second call in one turn (#940).
//
// `forceNoThink` suppresses thinking on THIS instance even with reasoning on:
// body injection is bound at construction, so the picker's forced-tool legs need
// their own no-think model (languageModel's bodyNoThink) or they truncate
// mid-<think> (#914).
export function openAICompatibleFetch(cfg: any, baseFetch: any = fetch, forceNoThink = false) {
  const penalty = appliedRepeatPenalty(cfg);
  const noThink = forceNoThink || cfg?.reasoning !== true;
  return (url: any, init: any) => {
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (penalty != null && body.repeat_penalty === undefined) {
          body.repeat_penalty = penalty;
        }
        if (noThink) {
          body.chat_template_kwargs = {
            ...(body.chat_template_kwargs || {}),
            enable_thinking: false,
          };
          if (body.reasoning_format === undefined) body.reasoning_format = 'deepseek';
          // A proxy forwarding this to a thinking-mandatory Claude model would
          // turn it into the 400 it exists to avoid; `reasoning` below carries
          // the minimal-effort ask for those instead.
          if (body.thinking === undefined && !thinkingMandatoryModel(String(body.model || ''))) {
            body.thinking = { type: 'disabled' };
          }
          if (body.reasoning === undefined) {
            body.reasoning = reasoningMandatoryModel(String(body.model || ''))
              ? { effort: 'minimal' }
              : { enabled: false };
          }
        }
        if (Array.isArray(body.tools) && body.tools.length > 0 &&
            body.parallel_tool_calls === undefined) {
          body.parallel_tool_calls = false;
        }
        init = { ...init, body: JSON.stringify(body) };
      } catch { /* not JSON — leave the request untouched */ }
    }
    return baseFetch(url, init);
  };
}

// Model families that 400 on `reasoning:{enabled:false}` (OpenAI gpt-5/o-series,
// DeepSeek R1 variants, the thinking-mandatory Claude generations) and must be
// minimised with `effort:'minimal'` instead. Deliberately broad at openai/* —
// harmless on non-reasoning openai models.
export function reasoningMandatoryModel(id: string): boolean {
  return /^openai\//i.test(id) || /(^|\/)deepseek-r1/i.test(id) || thinkingMandatoryModel(id);
}

// Ollama server URL: settings field, else the config default.
export function ollamaBaseUrl(cfg: any): string {
  return cfg.ollamaUrl || config.ollama.url;
}

// Chat default for the `locca` provider (llama.cpp on the host). settings
// `llm.baseUrl` overrides.
export const DEFAULT_LOCCA_BASE_URL = 'http://host.docker.internal:8080/v1';

// Used by the builder and the cache signature, so a blank field and the
// resolved default key to the same client.
export function loccaBaseUrl(cfg: any): string {
  return cfg.baseUrl || DEFAULT_LOCCA_BASE_URL;
}

// locca runs embeddings on a separate server (`locca embed`, port 8090) — a
// chat llama.cpp server can't also serve embeddings, so this default is
// distinct from the chat one. settings.embedding.baseUrl overrides.
export const DEFAULT_LOCCA_EMBED_BASE_URL = 'http://host.docker.internal:8090/v1';

export function loccaEmbedBaseUrl(cfg: any): string {
  return cfg.baseUrl || DEFAULT_LOCCA_EMBED_BASE_URL;
}

// Requesty is a fixed-endpoint OpenAI-compatible aggregator, so the base URL is
// not operator-configurable. Keyed by REQUESTY_API_KEY.
export const DEFAULT_REQUESTY_BASE_URL = 'https://router.requesty.ai/v1';

// OpenRouter app attribution (openrouter.ai/docs/app-attribution). Sent on every
// OpenRouter request — chat, embeddings and the key-validation probes.
export const OPENROUTER_APP_HEADERS = {
  'HTTP-Referer': 'https://getsubwave.com',
  'X-Title': 'SUB/WAVE',
} as const;

// LanguageModel for any self-hosted OpenAI-compatible server (llama.cpp, vLLM,
// LM Studio, locca). `.chat()` pins /v1/chat/completions — these servers don't
// implement the Responses API the default `provider(id)` would target. Most
// accept any non-empty key, so fall back to a placeholder.
function openAICompatibleModel(cfg: any, id: string, baseURL: string, name: string, forceNoThink = false) {
  // debugFetch is the inner transport, so the capture is the body as sent.
  const fetchImpl = cfg.provider === 'openai-compatible' && cfg.compatibleMode === 'hosted'
    ? debugFetch : openAICompatibleFetch(cfg, debugFetch, forceNoThink);
  const headers = customHeaders(cfg);
  const provider = createOpenAI({
    baseURL,
    apiKey: cfg.apiKey || 'unused',
    name,
    fetch: fetchImpl,
    // Omitted entirely when unconfigured, so an untouched station is
    // byte-identical (#1618).
    ...(headers ? { headers } : {}),
  });
  return provider.chat(id);
}

// The operator's extra request headers for this leg (settings llm.headers /
// llm.fallback.headers), or undefined when there are none (#1618). The map is
// opaque — nothing here names a specific header. Only the openai-compatible
// transport (openai-compatible + locca) reads it; every hosted provider has a
// fixed endpoint. Shape rules are enforced at the save path in settings/vocab.ts,
// so this never repairs a value.
export function customHeaders(cfg: any): Record<string, string> | undefined {
  const raw = cfg?.headers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const name of Object.keys(raw)) {
    const v = raw[name];
    if (typeof v === 'string' && v) out[name] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Cache-signature form of the header map: key-order stable, '' when empty.
// Headers are captured at CONSTRUCTION (like repeat_penalty and num_ctx), so
// they must key the cache or an edit — or a failover to a leg with different
// headers — keeps hitting the old client until restart.
export function headersSig(cfg: any): string {
  const h = customHeaders(cfg);
  if (!h) return '';
  return Object.keys(h).sort().map((k) => `${k}=${h[k]}`).join(',');
}

// Ollama falls back to the env-configured model; cloud providers must name a
// model explicitly rather than have one guessed.
export function resolveModelId(cfg: any): string {
  if (cfg.model) return cfg.model;
  if (cfg.provider === 'ollama') return config.ollama.model;
  if (cfg.provider === 'deepseek') return 'deepseek-v4-flash';
  throw new Error(
    `llm.provider is "${cfg.provider}" but llm.model is empty — set a model in Settings`
  );
}

// AI SDK LanguageModel for the given config (the active primary leg by default).
// An explicit cfg (the fallback leg) shares the same cache.
export function languageModel(cfg: any = llmCfg(), opts: { forceNoThink?: boolean } = {}) {
  const id = resolveModelId(cfg);
  const baseUrlSig = cfg.provider === 'locca' ? loccaBaseUrl(cfg) : (cfg.baseUrl || '');
  // Two provider families can't suppress thinking per-call, so a forced-tool leg
  // needs its own instance: OpenRouter fixes reasoning at model build, and
  // openai-compatible/locca bind the body wrapper at construction. Everyone else
  // suppresses per-call. Keyed into the sig so the variants don't collide.
  const caps = capabilitiesFor(cfg.provider);
  const constructionNoThink = opts.forceNoThink === true && caps.reasoningConstructionOnly === true;
  const bodyNoThink = opts.forceNoThink === true && caps.samplingViaBody === true
    && !(cfg.provider === 'openai-compatible' && cfg.compatibleMode === 'hosted');
  // repeat_penalty and num_ctx are captured at construction, so both key the
  // cache or an edit reads as ignored until the controller restarts (#1327).
  // The POOL EPOCH is part of the signature, for the google provider only.
  //
  // Every other field here is operator configuration, so a cache hit provably
  // describes the settings it was built from. The Google pool was not in that
  // set, which is the hole: `createGoogleGenerativeAI` captures its `apiKey` at
  // CONSTRUCTION, so a client built while key A was live kept sending A after A
  // was removed — invisibly, because googleKeyFetch re-stamps the header on every
  // request and the cached value only surfaces once the pool stops re-stamping
  // (an emptied pool falls through to the SDK's own transport, which uses the
  // construction value). Keying on the epoch means every pool write yields a
  // different client, so a cached client can never outlive the pool it came from.
  // Scoped to google so an unrelated provider's client is not rebuilt when the
  // operator edits a Google key.
  const poolSig = cfg.provider === 'google' ? `|gp${poolEpoch()}` : '';
  const sig = `${cfg.provider}|${id}|${cfg.apiKey || ''}|${ollamaBaseUrl(cfg)}|${baseUrlSig}|${cfg.reasoning ? 'r1' : 'r0'}|${(constructionNoThink || bodyNoThink) ? 'nt1' : 'nt0'}|ctx${appliedNumCtx(cfg) ?? ''}|rp${appliedRepeatPenalty(cfg) ?? ''}|hd${headersSig(cfg)}|cm${cfg.compatibleMode || 'local'}${poolSig}`;

  const cached = clientCache.get(sig);
  if (cached) return cached;

  let model;
  switch (cfg.provider) {
    case 'anthropic': {
      const provider = createAnthropic({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'openai': {
      const provider = createOpenAI({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'openai-compatible': {
      model = openAICompatibleModel(cfg, id, cfg.baseUrl, 'openai-compatible', bodyNoThink);
      break;
    }
    case 'locca': {
      // Same transport as openai-compatible, with a default base URL.
      model = openAICompatibleModel(cfg, id, loccaBaseUrl(cfg), 'locca', bodyNoThink);
      break;
    }
    case 'google': {
      // googleKeyFetch, not debugFetch: the key is re-stamped per request from
      // the pool, which is what lets a 429 rotate credentials without
      // rebuilding this cached client. The construction apiKey is only what the
      // SDK demands before it will build a client at all — see googleApiKeyForSdk
      // for why omitting it broke pool-only stations entirely.
      const provider = createGoogleGenerativeAI({ fetch: googleKeyFetch, apiKey: googleApiKeyForSdk(cfg) });
      model = provider(id);
      break;
    }
    case 'deepseek': {
      const provider = createDeepSeek({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'openrouter': {
      const provider = createOpenRouter({ fetch: debugFetch, headers: OPENROUTER_APP_HEADERS, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      // OpenRouter reads `reasoning` from construction settings, not per-call
      // providerOptions, so the toggle has to be wired here. Suppressed on
      // forced-tool legs and when the operator turns reasoning off; otherwise
      // the model's default reasoning stands, so free text keeps thinking while
      // the picker runs minimal.
      const suppressReasoning = cfg.reasoning !== true || constructionNoThink;
      // `enabled:false` is the off-switch. effort:'minimal' is NOT one for most
      // families (a no-op for Qwen/GLM; OpenRouter maps any effort onto an
      // Anthropic thinking BUDGET, so it turns thinking on) and survives only
      // for the reasoning-mandatory families — see reasoningMandatoryModel.
      model = suppressReasoning
        ? provider(id, { extraBody: { reasoning: reasoningMandatoryModel(id) ? { effort: 'minimal' } : { enabled: false } } })
        : provider(id);
      break;
    }
    case 'requesty': {
      // Same createOpenAI transport as openai-compatible on a fixed base URL.
      // Hosted aggregator with no thinking knob, so no body injection — that
      // only makes sense for self-hosted llama.cpp/vLLM. A real key is required.
      const provider = createOpenAI({
        baseURL: DEFAULT_REQUESTY_BASE_URL,
        apiKey: cfg.apiKey || process.env.REQUESTY_API_KEY || 'unused',
        name: 'requesty',
        fetch: debugFetch,
      });
      model = provider.chat(id);
      break;
    }
    case 'gateway': {
      // Always constructed so debugFetch can be wired in; with no apiKey it
      // resolves the same env / OIDC credentials the default instance would.
      const provider = createGateway({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'ollama':
    default: {
      // `baseURL` is the bare Ollama host (no `/api` suffix); the package
      // appends the path. The default factory already translates tools /
      // toolChoice / activeTools, so no `.chat(id)` override.
      const provider = createOllama({ baseURL: ollamaBaseUrl(cfg), fetch: debugFetch });
      // Thinking suppression rides the per-call `reasoning` option (capabilities
      // reasoningFor), which outranks any construction-time `think`. num_ctx has
      // no per-call channel in v4, so it goes through construction and keys the
      // sig. Per-call repeat_penalty has no v4 channel and is inert here.
      const numCtx = appliedNumCtx(cfg);
      model = numCtx != null ? provider(id, { options: { num_ctx: numCtx } }) : provider(id);
      break;
    }
  }

  clientCache.set(sig, model);
  return model;
}

/**
 * Test seam: forget every built client.
 *
 * The cache is module-level and outlives any single test, so a test that builds
 * a Google client can be handed the one an EARLIER test built — same
 * configuration, same signature — and then assert against a client whose
 * construction it never triggered. That is how "a client can be built while every
 * key is held" passed against the broken code: the cached client short-circuited
 * `googleApiKeyForSdk` entirely, so the branch under test was never reached.
 *
 * A distinct model id would dodge it too, but invisibly and only for that test.
 * Clearing the cache states the precondition outright.
 */
export function __clearClientCacheForTest(): void {
  clientCache.clear();
}

// Log-friendly label for the active model, used by record() and /debug.
export function activeModelLabel(): string {
  const cfg = llmCfg();
  try {
    return `${cfg.provider}:${resolveModelId(cfg)}`;
  } catch {
    return `${cfg.provider}:(unset)`;
  }
}

// Active provider id, for telemetry surfaces (/stats, /debug).
export function providerName(): string {
  return llmCfg().provider;
}

// Effective Ollama server URL, reported by /debug.
export function activeOllamaUrl(): string {
  return ollamaBaseUrl(llmCfg());
}
