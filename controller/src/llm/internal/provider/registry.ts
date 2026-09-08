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
import { recordRawRequest, rawDebugEnabled } from '../telemetry/raw-debug.js';
import { capabilitiesFor, appliedRepeatPenalty, appliedNumCtx } from './capabilities.js';

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
          if (body.thinking === undefined) body.thinking = { type: 'disabled' };
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
// DeepSeek R1 variants) and must be minimised with `effort:'minimal'` instead.
// Deliberately broad at openai/* — harmless on non-reasoning openai models.
export function reasoningMandatoryModel(id: string): boolean {
  return /^openai\//i.test(id) || /(^|\/)deepseek-r1/i.test(id);
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
  const fetchImpl = openAICompatibleFetch(cfg, debugFetch, forceNoThink);
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
  const bodyNoThink = opts.forceNoThink === true && caps.samplingViaBody === true;
  // repeat_penalty and num_ctx are captured at construction, so both key the
  // cache or an edit reads as ignored until the controller restarts (#1327).
  const sig = `${cfg.provider}|${id}|${cfg.apiKey || ''}|${ollamaBaseUrl(cfg)}|${baseUrlSig}|${cfg.reasoning ? 'r1' : 'r0'}|${(constructionNoThink || bodyNoThink) ? 'nt1' : 'nt0'}|ctx${appliedNumCtx(cfg) ?? ''}|rp${appliedRepeatPenalty(cfg) ?? ''}|hd${headersSig(cfg)}`;

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
