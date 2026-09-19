// Provider registry: resolves and caches the LanguageModel for `settings.llm`.
// Every model call goes through here; call sites never name a provider.
// `ollama` is the default and needs no key; cloud providers are opt-in.

import { createGateway } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';
import { recordRawRequest, rawDebugEnabled } from '../telemetry/raw-debug.js';
import {
  capabilitiesFor,
  appliedRepeatPenalty,
  appliedNumCtx,
  azureRequiresCompletionTokens,
  azureRequiresDefaultTemperature,
  azureRejectsTopP,
  azureRejectsReasoningEffort,
  azureRequiresNoReasoningEffort,
  azureRejectsParallelToolCalls,
} from './capabilities.js';

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

// Azure's request dialect. A reasoning deployment (o-series, gpt-5.x) rejects
// parameters a gpt-4-class one accepts, and `cfg.model` is a DEPLOYMENT alias,
// so nothing in the request identifies which contract applies — @ai-sdk/openai
// infers it only from ids it recognises, and a deployment called `radio-dj` in
// front of gpt-5 gets the gpt-4 dialect and a hard 400.
//
// So the dialect is SEEDED from the operator's declaration
// (`llm.reasoningModel`), so a correct answer spends no 400 at all, and then
// LEARNED from Azure's own rejections for the operator who left the box
// unchecked or answered wrongly — each correction keyed to one documented error
// naming one parameter (the sniffers in capabilities.ts); an unrecognised 400
// keeps its normal error path.
//
// Two rules that must hold. Learned corrections are applied and then the loop
// still runs: an earlier cut returned out of that fast path once anything had
// been learned, so a deployment rejecting all three sampling parameters only
// ever learned the two the first request carried — picks (max_tokens +
// temperature) worked and every DJ script after, which also sends top_p, 400'd
// forever. And the attempt budget is one per learnable correction PLUS the
// success. A worst-case cold client spends one request per correction, all
// inside the caller's single deadline (`core/retry.ts`).
interface AzureDialect {
  // Rename max_tokens -> max_completion_tokens (every reasoning model).
  completionTokens: boolean;
  // Drop rather than pin. Azure has two wordings for temperature — a rejected
  // VALUE on the original gpt-5 and a rejected PARAMETER from gpt-5.x on — and
  // omitting satisfies both, while `temperature: 1` satisfies only the first.
  omitTemperature: boolean;
  omitTopP: boolean;
  // This deployment takes no reasoning_effort at all (`gpt-5-chat`, `o1-mini`).
  omitReasoningEffort: boolean;
  // The opposite, and the only correction that ADDS a parameter: gpt-5.6+
  // refuses a tool-bearing Chat Completions request unless reasoning is
  // explicitly off. Mutually exclusive with omitReasoningEffort.
  noReasoningEffort: boolean;
  omitParallelToolCalls: boolean;
}

// One request per learnable field, plus the one that finally succeeds.
const AZURE_DIALECT_ATTEMPTS = 7;

function seedAzureDialect(reasoningModel: boolean): AzureDialect {
  return {
    // A declared reasoning deployment rejects all three sampling parameters, so
    // seed those. NOT the reasoning_effort pair: a reasoning deployment is
    // exactly the one that accepts an effort, and whether it also refuses tools
    // without 'none' depends on a generation the declaration does not name.
    completionTokens: reasoningModel,
    omitTemperature: reasoningModel,
    omitTopP: reasoningModel,
    omitReasoningEffort: false,
    noReasoningEffort: false,
    omitParallelToolCalls: false,
  };
}

// Structured outputs and parallel function calls are documented as mutually
// exclusive on Azure, and parallel_tool_calls DEFAULTS to true — so omitting it
// is not the same as disabling it, and a schema-bearing tool call can return
// something the schema never described. Same rewrite, and the same reason, as
// openAICompatibleFetch's Gemma-4 clamp below (#940). Deliberately NOT learned:
// it is a property of the request shape, not of the deployment. A deployment
// that rejects the parameter itself teaches omitParallelToolCalls.
function wantsSerialToolCalls(body: Record<string, unknown>): boolean {
  const format = body.response_format as { type?: unknown } | undefined;
  return Array.isArray(body.tools)
    && body.tools.length > 0
    && !!format
    && format.type === 'json_schema';
}

// Would applying the dialect change anything? When it would not, the caller's
// own request is forwarded untouched, so a gpt-4-class deployment's body leaves
// the process exactly as the SDK built it — same bytes, same key order, nothing
// for a debug capture or a wire test to have to explain.
function azureDialectIsNoop(body: Record<string, unknown>, d: AzureDialect): boolean {
  if (d.completionTokens && body.max_tokens != null) return false;
  if (d.omitTemperature && body.temperature != null) return false;
  if (d.omitTopP && body.top_p != null) return false;
  if (d.omitReasoningEffort && body.reasoning_effort != null) return false;
  if (d.noReasoningEffort && Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (d.omitParallelToolCalls && body.parallel_tool_calls != null) return false;
  if (!d.omitParallelToolCalls && body.parallel_tool_calls == null && wantsSerialToolCalls(body)) return false;
  return true;
}

// Rebuild the outbound body under a dialect. Always derived from the ORIGINAL
// parsed body, never from a previous correction, so re-applying is idempotent.
function applyAzureDialect(body: Record<string, unknown>, d: AzureDialect): Record<string, unknown> {
  const { max_tokens, temperature, top_p, reasoning_effort, ...rest } = body;
  const out: Record<string, unknown> = { ...rest };

  if (max_tokens != null) {
    if (d.completionTokens) out.max_completion_tokens = rest.max_completion_tokens ?? max_tokens;
    else out.max_tokens = max_tokens;
  }
  if (temperature != null && !d.omitTemperature) out.temperature = temperature;
  if (top_p != null && !d.omitTopP) out.top_p = top_p;

  const toolBearing = Array.isArray(body.tools) && body.tools.length > 0;
  if (d.omitReasoningEffort) {
    // Nothing: the parameter is unsupported on this deployment.
  } else if (d.noReasoningEffort && toolBearing) {
    out.reasoning_effort = 'none';
  } else if (reasoning_effort != null) {
    out.reasoning_effort = reasoning_effort;
  }

  if (d.omitParallelToolCalls) delete out.parallel_tool_calls;
  else if (out.parallel_tool_calls == null && wantsSerialToolCalls(body)) out.parallel_tool_calls = false;

  return out;
}

// Fold one rejection into the dialect. Returns false when nothing was learned,
// which is the caller's signal to hand the response back untouched. Every flag
// flips at most once, which is what bounds the loop.
function learnAzureDialect(
  d: AzureDialect,
  payload: unknown,
  body: Record<string, unknown>,
): boolean {
  const toolBearing = Array.isArray(body.tools) && body.tools.length > 0;
  let learned = false;
  if (!d.completionTokens && body.max_tokens != null && azureRequiresCompletionTokens(payload)) {
    d.completionTokens = true;
    learned = true;
  }
  if (!d.omitTemperature && body.temperature != null && azureRequiresDefaultTemperature(payload)) {
    d.omitTemperature = true;
    learned = true;
  }
  if (!d.omitTopP && body.top_p != null && azureRejectsTopP(payload)) {
    d.omitTopP = true;
    learned = true;
  }
  // The two reasoning_effort corrections are opposites, so each is learnable
  // only while the other is unset, or a deployment answering both has us
  // alternate inside the budget instead of surfacing an error we cannot
  // satisfy. Every branch also checks the parameter was really on the wire, so
  // a recognised error cannot buy a retry that changes nothing — the only
  // source is the caller's own body, the injection below being guarded out by
  // `!d.noReasoningEffort`.
  if (
    !d.omitReasoningEffort && !d.noReasoningEffort && body.reasoning_effort != null
    && azureRejectsReasoningEffort(payload)
  ) {
    d.omitReasoningEffort = true;
    learned = true;
  }
  if (
    !d.noReasoningEffort && !d.omitReasoningEffort && toolBearing
    && azureRequiresNoReasoningEffort(payload)
  ) {
    d.noReasoningEffort = true;
    learned = true;
  }
  if (
    !d.omitParallelToolCalls
    && (body.parallel_tool_calls != null || wantsSerialToolCalls(body))
    && azureRejectsParallelToolCalls(payload)
  ) {
    d.omitParallelToolCalls = true;
    learned = true;
  }
  return learned;
}

// The transport. Its dialect store is keyed by endpoint path + deployment, so
// one resource serving a chat deployment and a reasoning one keeps them apart,
// and a learned dialect is not re-learned per request.
export function azureChatFetch(
  baseFetch: typeof fetch = fetch,
  { reasoningModel = false }: { reasoningModel?: boolean } = {},
): typeof fetch {
  const dialects = new Map<string, AzureDialect>();
  return async (url, init) => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null');
    } catch { return baseFetch(url, init); }
    if (!body || typeof body !== 'object') return baseFetch(url, init);

    // The deployment is in the body on the v1 surface and in the path on the
    // legacy one, so key on both and neither surface can collide.
    const key = `${String(url).split('?')[0]}|${typeof body.model === 'string' ? body.model : ''}`;
    let dialect = dialects.get(key);
    if (!dialect) {
      dialect = seedAzureDialect(reasoningModel);
      dialects.set(key, dialect);
    }
    const d = dialect;

    // `init` itself is never mutated, so the caller's headers and signal ride
    // every attempt unchanged and a debug capture sees each exact body.
    const requestFor = (): RequestInit => (
      azureDialectIsNoop(body, d)
        ? (init as RequestInit)
        : { ...init, body: JSON.stringify(applyAzureDialect(body, d)) }
    );

    let request = requestFor();
    let response: Response | undefined;
    for (let attempt = 0; attempt < AZURE_DIALECT_ATTEMPTS; attempt++) {
      response = await baseFetch(url, request);
      if (response.status !== 400) return response;
      let payload: unknown;
      try { payload = await response.clone().json(); } catch { return response; }
      if (!learnAzureDialect(d, payload, body)) return response;
      init?.signal?.throwIfAborted();
      request = requestFor();
    }
    return response!;
  };
}

// Every model built for one Azure resource shares its transport, so a dialect
// learned on the picker's leg is already known to the DJ's and survives a
// settings save. Never persisted: a learned dialect is a fact about a
// deployment, and a deployment can be replaced under the same name.
const azureTransports = new Map<string, typeof fetch>();

function azureTransportFor(ep: AzureEndpoint, reasoningModel: boolean): typeof fetch {
  const key = `${ep.baseURL}|${ep.apiVersion ?? ''}|${reasoningModel ? 'r1' : 'r0'}`;
  let transport = azureTransports.get(key);
  if (!transport) {
    transport = azureChatFetch(debugFetch, { reasoningModel });
    azureTransports.set(key, transport);
  }
  return transport;
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

// Azure OpenAI runs the same models as `openai` on the operator's OWN resource,
// so the endpoint is per-install: it rides the existing per-provider base-URL
// map (`llm.providerBaseUrls.azure`, #1082), which `cfg.baseUrl` is re-derived
// from on every save. Three endpoint shapes reach here and each takes a
// different path — get one wrong and the result is a 404, i.e. a silent DJ with
// nothing in the UI naming the cause:
//
//   • the v1 surface (default) — `https://<res>.openai.azure.com/openai/v1`,
//     no api-version, OpenAI's own request shape. The portal hands over the
//     bare resource root, so append the path @ai-sdk/azure reads as
//     already-versioned (it then omits the api-version query entirely).
//   • the legacy deployment surface — reached by pasting the endpoint WITH its
//     `?api-version=<date>` query, as Azure's own config blobs quote it. Kept
//     because resources pinned to a dated api-version 404 on the v1 path, but
//     NOT the path to steer an operator onto: the dated track is retired, tops
//     out at 2025-04-01-preview, and cannot express reasoning_effort
//     'none'/'xhigh' or verbosity at all, so a pinned resource cannot run
//     gpt-5.x.
//   • an AI Foundry *project* endpoint
//     (`https://<res>.services.ai.azure.com/api/projects/<proj>`) — recognised
//     by @ai-sdk/azure itself, which routes it to `<base>/v1<path>`. Appending
//     `/openai/v1` to it built exactly that 404, so pass it through untouched.
//
// Pure: a function of cfg.baseUrl alone, pinned in llm-azure.test.ts.
export interface AzureEndpoint {
  baseURL: string;
  apiVersion?: string;
  useDeploymentBasedUrls?: boolean;
}

export function azureEndpoint(cfg: any): AzureEndpoint {
  const raw = String(cfg?.baseUrl || '').trim();
  if (!raw) return { baseURL: '' };
  const q = raw.indexOf('?');
  let base = raw;
  let apiVersion = '';
  if (q >= 0) {
    base = raw.slice(0, q);
    const m = /(?:^|[?&])api-version=([^&]+)/i.exec(raw.slice(q));
    if (m) apiVersion = decodeURIComponent(m[1]).trim();
  }
  base = base.trim().replace(/\/+$/, '');
  if (!base) return { baseURL: '' };
  // 'v1' is the modern surface's own version token, so an operator who pasted
  // it explicitly gets the default path, not the legacy one.
  if (apiVersion && apiVersion.toLowerCase() !== 'v1') {
    const root = /\/openai$/i.test(base) ? base : `${base}/openai`;
    return { baseURL: root, apiVersion, useDeploymentBasedUrls: true };
  }
  // Already versioned — either `…/openai/v1` or a custom OpenAI-shaped gateway.
  if (/\/v1$/i.test(base)) return { baseURL: base };
  // A Foundry project path the SDK routes itself. Adding a path here is how the
  // 404 got built, so add nothing.
  if (/\/api\/projects\/[^/]+$/i.test(base)) return { baseURL: base };
  return { baseURL: /\/openai$/i.test(base) ? `${base}/v1` : `${base}/openai/v1` };
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
  // Azure's model id is the operator's DEPLOYMENT name, which no default can
  // guess — say so, or the error reads as "pick a model from a list" when there
  // is no list to pick from.
  if (cfg.provider === 'azure') {
    throw new Error(
      'llm.provider is "azure" but llm.model is empty — set the DEPLOYMENT name '
      + '(what you called it in Azure, e.g. gpt-4o-mini) in Settings'
    );
  }
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
  // `reasoningModel` too, and not cosmetically: the azure client is built around
  // a transport chosen by that flag, so without it an operator who ticks "this
  // deployment is a reasoning model" keeps being served the un-seeded instance.
  const sig = `${cfg.provider}|${id}|${cfg.apiKey || ''}|${ollamaBaseUrl(cfg)}|${baseUrlSig}|${cfg.reasoning ? 'r1' : 'r0'}|${(constructionNoThink || bodyNoThink) ? 'nt1' : 'nt0'}|ctx${appliedNumCtx(cfg) ?? ''}|rp${appliedRepeatPenalty(cfg) ?? ''}|hd${headersSig(cfg)}|rm${cfg.reasoningModel === true ? 1 : 0}`;

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
    case 'azure': {
      // Azure OpenAI: same models, the operator's own resource. The endpoint is
      // required — there is no hosted default to fall back to — so an empty one
      // is a config error named at the point of use, not a mystery 404 later.
      const ep = azureEndpoint(cfg);
      if (!ep.baseURL) {
        throw new Error(
          'llm.provider is "azure" but no endpoint is set — paste the resource '
          + 'endpoint (https://<resource>.openai.azure.com) in Settings → LLM'
        );
      }
      const provider = createAzure({
        baseURL: ep.baseURL,
        // Shared per resource, so the dialect the picker's leg learned is
        // already known to the DJ's — and seeded from the operator's own
        // answer, so a declared reasoning deployment spends no 400 at all.
        fetch: azureTransportFor(ep, cfg.reasoningModel === true),
        ...(ep.apiVersion ? { apiVersion: ep.apiVersion } : {}),
        ...(ep.useDeploymentBasedUrls ? { useDeploymentBasedUrls: true } : {}),
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
      });
      // `.chat()` pins Chat Completions. The bare `provider(id)` targets the
      // Responses API, which is not enabled on every deployment or region —
      // Chat Completions is the one surface every Azure deployment serves.
      model = provider.chat(id);
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
