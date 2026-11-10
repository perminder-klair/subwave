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
import { createHash } from 'node:crypto';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';
import { recordRawRequest, rawDebugEnabled } from '../telemetry/raw-debug.js';
import { capabilitiesFor, appliedRepeatPenalty, appliedNumCtx, thinkingMandatoryModel } from './capabilities.js';
import { openaiCompatibleGateway } from '../../../schemas/providers.js';
import { resolveCompatibleMode } from './compat-detect.js';

// Built clients, keyed by a signature covering every field captured at
// construction, so a settings edit is picked up with no explicit invalidation.
// A credential is keyed by its fingerprint (credentialSig), never verbatim.
const clientCache = new Map();

// Short one-way fingerprint of a credential for a cache signature: a rotated key
// builds a fresh client, while the Map never holds the key itself. '' when unset.
export function credentialSig(key: string): string {
  if (!key) return '';
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// The key a builder hands the SDK, and therefore captures at construction: the
// inline key, else the provider's declared env var (capabilities apiKeyEnv).
// Every other provider is built WITHOUT an explicit key when the inline one is
// blank, and its SDK reads its own env var per request, so nothing is pinned.
export function pinnedApiKey(cfg: any): string {
  const inline = typeof cfg?.apiKey === 'string' ? cfg.apiKey : '';
  if (inline) return inline;
  const env = capabilitiesFor(cfg?.provider).apiKeyEnv;
  return (env && process.env[env]) || '';
}

export function llmCfg() {
  const llm = settings.get().llm
    || { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
  // The stored `apiKey` slot is legacy (always '' after settings.load()); the
  // active key is resolved per-provider from settings.llm.keys (#657). Empty →
  // the provider cases below fall through to their env var.
  // `auto` resolves to the detected mode here, so every downstream reader
  // (capabilities, the client builder, its cache signature) sees local|hosted.
  return resolveCompatibleMode({ ...llm, apiKey: settings.llmKeyFor(llm.provider) });
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
          // A proxy forwarding this to a thinking-mandatory Claude model would
          // turn it into the 400 it exists to avoid; `reasoning` below carries
          // the minimal-effort ask for those instead.
          if (body.thinking === undefined && !thinkingMandatoryModel(String(body.model || ''))) {
            body.thinking = { type: 'disabled' };
          }
          if (body.reasoning === undefined) {
            body.reasoning = reasoningMandatoryModel(String(body.model || ''))
              ? mandatoryReasoningFloor()
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

// What a model that cannot stop thinking is asked for in place of
// `enabled:false`: the lowest effort. A fresh object per call, because it is
// spliced into request bodies.
export function mandatoryReasoningFloor(): { effort: 'minimal' } {
  return { effort: 'minimal' };
}

// OpenRouter's answer to `reasoning:{enabled:false}` when the model or endpoint
// it routed the request to cannot stop thinking (#2092): a 400 whose message is
// "Reasoning is mandatory for this endpoint and cannot be disabled."
const REASONING_MANDATORY_RE = /\breasoning is mandatory\b[^"]{0,80}\bcannot be disabled\b/i;

// Model ids already logged as needing the retry below, so a station on a model
// that always needs it gets one line, not one per call.
const reasoningMandatoryLogged = new Set<string>();

// Fetch wrapper for the openrouter provider. reasoningMandatoryModel covers the
// families known by id, but no id list can cover a router id (`openrouter/free`
// picks a model at random on every request, `openrouter/auto` by prompt) or a
// mandatory model it has not met yet, so OpenRouter's rejection is answered
// here: the same request is sent once more with mandatoryReasoningFloor() in
// place of `enabled:false`. Only that rejection of a body that asked for
// reasoning off triggers it; every other request and response passes through
// untouched, and a successful response is never read. Nothing is remembered,
// because the next request may land on a model that can switch reasoning off,
// and the operator's "reasoning off" should still reach it.
export function openRouterFetch(baseFetch: any = fetch) {
  return async (url: any, init: any) => {
    const res = await baseFetch(url, init);
    if (res?.ok !== false || typeof init?.body !== 'string') return res;
    let body: any;
    try { body = JSON.parse(init.body); } catch { return res; }
    if (body?.reasoning?.enabled !== false) return res;
    let text = '';
    try { text = await res.clone().text(); } catch { return res; }
    if (!REASONING_MANDATORY_RE.test(text)) return res;
    const model = String(body.model || '');
    if (!reasoningMandatoryLogged.has(model)) {
      reasoningMandatoryLogged.add(model);
      console.log(`[llm] openrouter: ${model} cannot switch reasoning off — retrying such requests at minimal effort`);
    }
    return baseFetch(url, { ...init, body: JSON.stringify({ ...body, reasoning: mandatoryReasoningFloor() }) });
  };
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

// The server a chat leg actually talks to, as the builder resolves it. Shared by
// the cache signature and the embedding leg's credential-sharing check.
export function chatBaseUrl(cfg: any): string {
  return cfg.provider === 'locca' ? loccaBaseUrl(cfg) : (cfg.baseUrl || '');
}

// locca runs embeddings on a separate server (`locca embed`, port 8090) — a
// chat llama.cpp server can't also serve embeddings, so this default is
// distinct from the chat one. settings.embedding.baseUrl overrides.
export const DEFAULT_LOCCA_EMBED_BASE_URL = 'http://host.docker.internal:8090/v1';

export function loccaEmbedBaseUrl(cfg: any): string {
  return cfg.baseUrl || DEFAULT_LOCCA_EMBED_BASE_URL;
}

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
// headers — keeps hitting the old client until restart. Fingerprinted, because
// a header value can be a credential.
export function headersSig(cfg: any): string {
  const h = customHeaders(cfg);
  if (!h) return '';
  return credentialSig(JSON.stringify(Object.keys(h).sort().map((k) => [k, h[k]])));
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
  const baseUrlSig = chatBaseUrl(cfg);
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
  const apiKey = pinnedApiKey(cfg);
  const sig = `${cfg.provider}|${id}|k${credentialSig(apiKey)}|${ollamaBaseUrl(cfg)}|${baseUrlSig}|${cfg.reasoning ? 'r1' : 'r0'}|${(constructionNoThink || bodyNoThink) ? 'nt1' : 'nt0'}|ctx${appliedNumCtx(cfg) ?? ''}|rp${appliedRepeatPenalty(cfg) ?? ''}|hd${headersSig(cfg)}|cm${cfg.compatibleMode || 'local'}`;

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
      // debugFetch is the inner transport, so a retried request is captured too.
      const provider = createOpenRouter({ fetch: openRouterFetch(debugFetch), headers: OPENROUTER_APP_HEADERS, ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}) });
      // OpenRouter reads `reasoning` from construction settings, not per-call
      // providerOptions, so the toggle has to be wired here. Suppressed on
      // forced-tool legs and when the operator turns reasoning off; otherwise
      // the model's default reasoning stands, so free text keeps thinking while
      // the picker runs minimal.
      const suppressReasoning = cfg.reasoning !== true || constructionNoThink;
      // `enabled:false` is the off-switch. effort:'minimal' is NOT one for most
      // families (a no-op for Qwen/GLM; OpenRouter maps any effort onto an
      // Anthropic thinking BUDGET, so it turns thinking on) and survives only
      // for the reasoning-mandatory families — see reasoningMandatoryModel. A
      // model outside that list that rejects `enabled:false` is retried at the
      // floor by openRouterFetch.
      model = suppressReasoning
        ? provider(id, { extraBody: { reasoning: reasoningMandatoryModel(id) ? mandatoryReasoningFloor() : { enabled: false } } })
        : provider(id);
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
      // A fixed-endpoint OpenAI-compatible gateway (the catalogue's
      // openaiCompatible): the createOpenAI transport on its own base URL.
      // Hosted, with no thinking knob, so no body injection — that only makes
      // sense for self-hosted llama.cpp/vLLM. A real key is required. Any other
      // id is Ollama, as it always has been.
      const gw = openaiCompatibleGateway(cfg.provider);
      if (gw) {
        const provider = createOpenAI({
          baseURL: gw.openaiCompatible.baseUrl,
          apiKey: apiKey || 'unused',
          name: gw.id,
          fetch: debugFetch,
        });
        model = provider.chat(id);
        break;
      }
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
