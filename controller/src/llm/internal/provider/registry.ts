// Provider registry — the one place SUB/WAVE decides which LLM to talk to.
//
// Every model call in the controller resolves its model through here, so the
// operator can switch providers (homelab Ollama ↔ Anthropic ↔ OpenAI ↔ Google
// Gemini ↔ DeepSeek ↔ OpenRouter ↔ the Vercel AI Gateway) from the admin Settings UI
// without a redeploy and without touching a single call site.
//
// The active provider/model lives in `settings.llm` (see settings.js):
//   { provider:  'ollama' | 'openai-compatible' | 'locca' | 'anthropic' |
//                'openai' | 'google' | 'deepseek' | 'openrouter' | 'requesty' |
//                'gateway',
//     model:     string,   // empty → provider default
//     apiKey:    string,   // empty → read the provider's env var
//     ollamaUrl: string,   // empty → config.ollama.url default (Ollama only)
//     baseUrl:   string,   // server URL (openai-compatible; locca → host default)
//     reasoning: boolean } // false → suppress <think> chain-of-thought
//
// `ollama` is the default and needs no key. The cloud providers are opt-in.

import { createGateway } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';
import { recordRawRequest, rawDebugEnabled } from '../telemetry/raw-debug.js';
import { capabilitiesFor, appliedRepeatPenalty } from './capabilities.js';

// Memoise built clients so we don't reconstruct a provider on every call.
// Keyed by a signature that changes whenever provider/model/key changes, so a
// settings edit is picked up on the next call with no explicit invalidation.
const clientCache = new Map();

export function llmCfg() {
  const llm = settings.get().llm
    || { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
  // The stored `apiKey` slot is legacy (always '' after settings.load()); the
  // active key is resolved per-provider from settings.llm.keys (issue #657).
  // Empty → every provider case below falls through to its env var, as before.
  // Embedding inheritance reads llm.apiKey from here too, so it stays correct.
  return { ...llm, apiKey: settings.llmKeyFor(llm.provider) };
}

// When raw-request debug capture is enabled (LLM_DEBUG_RAW env flag or the
// settings.llm.debugRawRequests admin toggle), record the exact outbound body —
// verbatim, the JSON string as actually sent — before delegating to the real
// fetch. This is the single capture point: it's wired into EVERY provider's
// `fetch` option in languageModel() below, so capture is provider-agnostic.
// Gated at call time, so when disabled it's one boolean check then a plain
// passthrough — zero behavioural change, no file writes. Only method + URL +
// body are recorded; Authorization and other headers are never touched.
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

// When reasoning is disabled, llama.cpp / vLLM / LM Studio honour
// chat_template_kwargs.enable_thinking=false — the Qwen3 (and similar)
// chat template then omits the <think> priming entirely, so the model
// never starts a chain-of-thought. Injected via a fetch wrapper because
// the AI SDK's openai provider has no first-class field for it. `baseFetch`
// is the transport to delegate to once the body is rewritten — debugFetch in
// languageModel() (so the captured body is the post-injection one as sent),
// global fetch for callers that don't compose it (e.g. onboarding probes).
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
// path. The AI SDK's openai provider has no first-class field for these knobs,
// and it validates providerOptions against its own schema — so anything not in
// that schema is dropped. We inject them straight into the JSON request body
// instead (servers ignore keys they don't recognise, same bet the existing
// chat_template_kwargs injection already makes):
//   • repeat_penalty — llama.cpp's own default is 1.0 (OFF), so the operator's
//     configured repetition floor is otherwise never applied and the tool-loop
//     agent can run away repeating a token block (gist quirk #2). This is the
//     ONLY path that carries it to the agent/object calls, which never pass
//     repeat_penalty through providerOptions. `repeat_penalty` is llama.cpp's
//     param name (vLLM's is `repetition_penalty`); to opt out, set
//     llm.repeatPenalty to 1.0. We never clobber a value already on the body.
//   • reasoning off → enable_thinking:false PLUS reasoning_format. Gemma-4's
//     chat template pre-seeds an empty <|channel|>thought block even with
//     enable_thinking:false, and with reasoning_format unset (defaults to none)
//     llama.cpp routes that thought to `content`, so it leaks into the visible
//     script and reaches TTS. reasoning_format:"deepseek" routes it to
//     reasoning_content, which the SDK surfaces as a reasoning part, not text
//     (gist quirk #4). GLM-family models (Zhipu/Z.ai — including the GLM
//     Coding Plan's api.z.ai/api/coding/paas/v4 endpoint) ignore
//     enable_thinking entirely and read a DIFFERENT, top-level `thinking.type`
//     field instead, so their thinking never actually turned off via the
//     knobs above alone — the hidden chain-of-thought burned through
//     maxOutputTokens/step budgets before a forced tool call could land,
//     surfacing as multi-minute calls or "agent did not call the done tool
//     before stopping". Send it alongside the others — an unrecognised field
//     is silently ignored by servers that don't define it, same bet as the
//     other body-injection knobs here.
export function openAICompatibleFetch(cfg: any, baseFetch: any = fetch) {
  const penalty = appliedRepeatPenalty(cfg);
  const noThink = cfg?.reasoning !== true;
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
          if (body.thinking === undefined) body.thinking = { type: 'disabled' };
        }
        init = { ...init, body: JSON.stringify(body) };
      } catch { /* not JSON — leave the request untouched */ }
    }
    return baseFetch(url, init);
  };
}

// Ollama server URL — from settings (admin UI), falling back to the config
// default when the settings field is left blank.
export function ollamaBaseUrl(cfg: any): string {
  return cfg.ollamaUrl || config.ollama.url;
}

// Default base URL for the `locca` provider — a locca-served llama.cpp on the
// host, reachable from the controller container via host.docker.internal. The
// operator can still override it (settings `llm.baseUrl`) for a non-default
// port / remote host; an explicit value always wins.
export const DEFAULT_LOCCA_BASE_URL = 'http://host.docker.internal:8080/v1';

// Effective base URL for the `locca` provider: the settings field if set, else
// the host default. Used by the builder and the cache signature so a blank
// field and the resolved default key to the same client.
export function loccaBaseUrl(cfg: any): string {
  return cfg.baseUrl || DEFAULT_LOCCA_BASE_URL;
}

// locca runs embeddings on a SEPARATE server (`locca embed`) on its own port —
// a chat llama.cpp server can't also serve embeddings. locca's default embed
// port is 8090, so embeddings get their own host default, distinct from the
// chat default above. Operator still overrides via settings.embedding.baseUrl.
export const DEFAULT_LOCCA_EMBED_BASE_URL = 'http://host.docker.internal:8090/v1';

// Effective base URL for a locca EMBEDDING server: the (embedding) settings
// field if set, else the host embed default. Mirrors loccaBaseUrl but points at
// the dedicated embed port so a blank field resolves to `locca embed`, not chat.
export function loccaEmbedBaseUrl(cfg: any): string {
  return cfg.baseUrl || DEFAULT_LOCCA_EMBED_BASE_URL;
}

// Requesty is an OpenAI-compatible LLM gateway (provider/model naming, e.g.
// openai/gpt-4o-mini). Like openrouter it's a fixed-endpoint aggregator — one
// key, any vendor — so the base URL isn't operator-configurable; the chat path
// goes through createOpenAI with this base, keyed by REQUESTY_API_KEY.
export const DEFAULT_REQUESTY_BASE_URL = 'https://router.requesty.ai/v1';

// Build a LanguageModel for any self-hosted OpenAI-compatible server (llama.cpp,
// vLLM, LM Studio, locca). `.chat()` pins /v1/chat/completions — these servers
// don't implement the Responses API the default `provider(id)` would target.
// Most accept any non-empty key, so fall back to a placeholder. The fetch
// wrapper injects the body-only knobs (repeat_penalty, and — reasoning off —
// enable_thinking:false + reasoning_format); see openAICompatibleFetch.
function openAICompatibleModel(cfg: any, id: string, baseURL: string, name: string) {
  // debugFetch is the inner transport, so what's recorded is the body exactly
  // as sent (post-injection).
  const fetchImpl = openAICompatibleFetch(cfg, debugFetch);
  const provider = createOpenAI({
    baseURL,
    apiKey: cfg.apiKey || 'unused',
    name,
    fetch: fetchImpl,
  });
  return provider.chat(id);
}

// Resolve the concrete model id. Ollama falls back to the env-configured
// model; cloud providers must name a model explicitly — guessing a model id
// that may not exist fails worse than a clear error.
export function resolveModelId(cfg: any): string {
  if (cfg.model) return cfg.model;
  if (cfg.provider === 'ollama') return config.ollama.model;
  if (cfg.provider === 'deepseek') return 'deepseek-v4-flash';
  throw new Error(
    `llm.provider is "${cfg.provider}" but llm.model is empty — set a model in Settings`
  );
}

// Returns an AI SDK LanguageModel for the given config (the active primary leg
// by default). Passing an explicit cfg — the fallback leg — reuses the same
// client cache, since the signature below already keys on every field.
export function languageModel(cfg: any = llmCfg(), opts: { forceNoThink?: boolean } = {}) {
  const id = resolveModelId(cfg);
  const baseUrlSig = cfg.provider === 'locca' ? loccaBaseUrl(cfg) : (cfg.baseUrl || '');
  // Construction-time no-think: only providers whose reasoning is set at build
  // time (OpenRouter) need a distinct reasoning-disabled instance for forced-tool
  // legs; everyone else suppresses per-call via providerOptions, so the same
  // cached model serves both. Keyed into the sig so the two variants don't collide.
  const constructionNoThink = opts.forceNoThink === true
    && capabilitiesFor(cfg.provider).reasoningConstructionOnly === true;
  const sig = `${cfg.provider}|${id}|${cfg.apiKey || ''}|${ollamaBaseUrl(cfg)}|${baseUrlSig}|${cfg.reasoning ? 'r1' : 'r0'}|${constructionNoThink ? 'nt1' : 'nt0'}`;

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
      model = openAICompatibleModel(cfg, id, cfg.baseUrl, 'openai-compatible');
      break;
    }
    case 'locca': {
      // First-class locca: an openai-compatible llama.cpp server with a sane
      // default base URL (host.docker.internal:8080) so the operator doesn't
      // hand-type a URL. Same transport as openai-compatible, incl. no-think.
      model = openAICompatibleModel(cfg, id, loccaBaseUrl(cfg), 'locca');
      break;
    }
    case 'google': {
      const provider = createGoogleGenerativeAI({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'deepseek': {
      const provider = createDeepSeek({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'openrouter': {
      const provider = createOpenRouter({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      // OpenRouter reads `reasoning` from construction settings, not per-call
      // providerOptions — so the toggle must be wired HERE or it's dead (we used
      // to pass nothing → models reasoned by default). We MINIMISE rather than
      // disable reasoning when suppressing: some OpenRouter models mandate it —
      // OpenAI gpt-5/o-series 400 with "Reasoning is mandatory for this endpoint"
      // on `enabled:false` — but every model accepts `effort:'minimal'`, which
      // both satisfies the mandate AND drops thinking low enough that
      // reasoning-rejects-tools models (mimo) can still emit forced tool calls.
      // Suppress on forced-tool legs (constructionNoThink) and when the operator
      // turns reasoning off; otherwise leave the model's default reasoning. This
      // lets the DJ's free-text keep full reasoning while the picker runs minimal,
      // so a reasoning model Just Works with no operator knowledge. The cache sig
      // includes both the reasoning flag and the no-think flag, so each variant is
      // built once.
      const suppressReasoning = cfg.reasoning !== true || constructionNoThink;
      model = suppressReasoning
        ? provider(id, { extraBody: { reasoning: { effort: 'minimal' } } })
        : provider(id);
      break;
    }
    case 'requesty': {
      // Requesty is an OpenAI-compatible gateway, so it reuses the same
      // createOpenAI transport as openai-compatible — just a fixed base URL
      // (router.requesty.ai/v1) instead of an operator-supplied one. Models use
      // provider/model naming (e.g. openai/gpt-4o-mini). Like openrouter it's a
      // hosted aggregator with no first-class thinking knob, so we pass through
      // verbatim (debugFetch only — no enable_thinking injection, which only
      // makes sense for self-hosted llama.cpp/vLLM). A real key is required; it
      // comes from settings or REQUESTY_API_KEY.
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
      // Always go through createGateway so debugFetch can be wired in; with no
      // apiKey it resolves the same env / OIDC credentials the bare `gateway`
      // default instance would.
      const provider = createGateway({ fetch: debugFetch, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      model = provider(id);
      break;
    }
    case 'ollama':
    default: {
      // `ai-sdk-ollama` is built on the official Ollama JS client and uses
      // its chat-completions path natively. The default factory `provider(id)`
      // returns a LanguageModelV3 that translates tools / toolChoice / activeTools
      // correctly — no `.chat(id)` override required. `baseURL` is the bare
      // Ollama host (no `/api` suffix); the package appends the path itself.
      const provider = createOllama({ baseURL: ollamaBaseUrl(cfg), fetch: debugFetch });
      model = provider(id);
      break;
    }
  }

  clientCache.set(sig, model);
  return model;
}

// A short, log-friendly label for the active model — used by record() and the
// /debug surface so a call's provenance is visible.
export function activeModelLabel(): string {
  const cfg = llmCfg();
  try {
    return `${cfg.provider}:${resolveModelId(cfg)}`;
  } catch {
    return `${cfg.provider}:(unset)`;
  }
}

// The active provider id, used to gate provider-specific sampling
// (repeat_penalty is Ollama-only) and by /stats and /debug for telemetry.
export function providerName(): string {
  return llmCfg().provider;
}

// The effective Ollama server URL — settings field, or the config default.
// Used by /debug to report what the registry will actually talk to.
export function activeOllamaUrl(): string {
  return ollamaBaseUrl(llmCfg());
}
