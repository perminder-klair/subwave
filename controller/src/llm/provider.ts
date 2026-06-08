// Provider registry — the one place SUB/WAVE decides which LLM to talk to.
//
// Every model call in the controller resolves its model through here, so the
// operator can switch providers (homelab Ollama ↔ Anthropic ↔ OpenAI ↔ Google
// Gemini ↔ DeepSeek ↔ OpenRouter ↔ the Vercel AI Gateway) from the admin Settings UI
// without a redeploy and without touching a single call site.
//
// The active provider/model lives in `settings.llm` (see settings.js):
//   { provider:  'ollama' | 'openai-compatible' | 'anthropic' | 'openai' |
//                'google' | 'deepseek' | 'openrouter' | 'gateway',
//     model:     string,   // empty → provider default
//     apiKey:    string,   // empty → read the provider's env var
//     ollamaUrl: string,   // empty → config.ollama.url default (Ollama only)
//     baseUrl:   string,   // OpenAI-compatible server URL (openai-compatible only)
//     reasoning: boolean } // false → suppress <think> chain-of-thought
//
// `ollama` is the default and needs no key. The cloud providers are opt-in.

import { gateway, createGateway } from 'ai';
import { createOllama } from 'ai-sdk-ollama';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { config } from '../config.js';
import * as settings from '../settings.js';

// Memoise built clients so we don't reconstruct a provider on every call.
// Keyed by a signature that changes whenever provider/model/key changes, so a
// settings edit is picked up on the next call with no explicit invalidation.
const clientCache = new Map();

function llmCfg() {
  return settings.get().llm
    || { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
}

// When reasoning is disabled, llama.cpp / vLLM / LM Studio honour
// chat_template_kwargs.enable_thinking=false — the Qwen3 (and similar)
// chat template then omits the <think> priming entirely, so the model
// never starts a chain-of-thought. Injected via a fetch wrapper because
// the AI SDK's openai provider has no first-class field for it.
function noThinkFetch(url, init) {
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
  return fetch(url, init);
}

// Ollama server URL — from settings (admin UI), falling back to the config
// default when the settings field is left blank.
function ollamaBaseUrl(cfg) {
  return cfg.ollamaUrl || config.ollama.url;
}

// Resolve the concrete model id. Ollama falls back to the env-configured
// model; cloud providers must name a model explicitly — guessing a model id
// that may not exist fails worse than a clear error.
function resolveModelId(cfg) {
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
export function languageModel(cfg = llmCfg()) {
  const id = resolveModelId(cfg);
  const sig = `${cfg.provider}|${id}|${cfg.apiKey || ''}|${ollamaBaseUrl(cfg)}|${cfg.baseUrl || ''}|${cfg.reasoning ? 'r1' : 'r0'}`;

  const cached = clientCache.get(sig);
  if (cached) return cached;

  let model;
  switch (cfg.provider) {
    case 'anthropic': {
      const provider = createAnthropic(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider(id);
      break;
    }
    case 'openai': {
      const provider = createOpenAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider(id);
      break;
    }
    case 'openai-compatible': {
      // Any self-hosted OpenAI-compatible server (llama.cpp, vLLM, LM Studio…).
      // `.chat()` pins the /v1/chat/completions endpoint — these servers don't
      // implement the Responses API the default `provider(id)` would target.
      // Most accept any non-empty key, so fall back to a placeholder.
      const provider = createOpenAI({
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey || 'unused',
        name: 'openai-compatible',
        // Reasoning off → wrap fetch to force chat_template_kwargs.enable_thinking=false.
        ...(cfg.reasoning ? {} : { fetch: noThinkFetch }),
      });
      model = provider.chat(id);
      break;
    }
    case 'google': {
      const provider = createGoogleGenerativeAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider(id);
      break;
    }
    case 'deepseek': {
      const provider = createDeepSeek(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider(id);
      break;
    }
    case 'openrouter': {
      const provider = createOpenRouter(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider(id);
      break;
    }
    case 'gateway': {
      const provider = cfg.apiKey ? createGateway({ apiKey: cfg.apiKey }) : gateway;
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
      const provider = createOllama({ baseURL: ollamaBaseUrl(cfg) });
      model = provider(id);
      break;
    }
  }

  clientCache.set(sig, model);
  return model;
}

// A short, log-friendly label for the active model — used by record() and the
// /debug surface so a call's provenance is visible.
export function activeModelLabel() {
  const cfg = llmCfg();
  try {
    return `${cfg.provider}:${resolveModelId(cfg)}`;
  } catch {
    return `${cfg.provider}:(unset)`;
  }
}

// The active provider id, used by sdk.ts to gate provider-specific sampling
// (repeat_penalty is Ollama-only) and by /stats and /debug for telemetry.
export function providerName() {
  return llmCfg().provider;
}

// ---------------------------------------------------------------------------
// Legs — primary + optional fallback
// ---------------------------------------------------------------------------
//
// A "leg" bundles everything a single LLM attempt needs: the resolved config
// (so sdk.ts can pick the provider-specific structured-output path + sampling
// from the right provider), the built AI SDK model, and a log label. The
// failover wrapper in sdk.ts tries the primary leg, and only on a
// host-unreachable error retries against the fallback leg. See discussion #320.

export interface Leg {
  cfg: any;       // the resolved llm config for this leg
  model: any;     // AI SDK LanguageModel
  label: string;  // `provider:modelId` for /debug records
}

function labelFor(cfg: any): string {
  try {
    return `${cfg.provider}:${resolveModelId(cfg)}`;
  } catch {
    return `${cfg.provider}:(unset)`;
  }
}

// The active primary leg. Throws on a misconfigured primary (empty model on a
// cloud provider) exactly as languageModel() does today — that's a hard error
// the caller surfaces, not something to silently route around.
export function primaryLeg(): Leg {
  const cfg = llmCfg();
  return { cfg, model: languageModel(cfg), label: labelFor(cfg) };
}

// The optional backup leg, or null when no usable fallback is configured.
// Built lazily — only after a primary failure — so a disabled or misconfigured
// fallback never affects healthy calls. A bad config (e.g. cloud provider with
// no model) degrades to "no fallback" rather than throwing over the primary's
// own error.
export function fallbackLeg(): Leg | null {
  const fb = settings.get().llm?.fallback;
  if (!fb || !fb.enabled) return null;
  try {
    return { cfg: fb, model: languageModel(fb), label: labelFor(fb) };
  } catch {
    return null;
  }
}

// The effective Ollama server URL — settings field, or the config default.
// Used by /debug to report what the registry will actually talk to.
export function activeOllamaUrl() {
  return ollamaBaseUrl(llmCfg());
}

// ---------------------------------------------------------------------------
// Embedding models
// ---------------------------------------------------------------------------
//
// The library tagger uses text embeddings for KNN-propagating moods (see
// music/embeddings.ts + music/tag-library.ts). Provider follows `settings.llm`
// by default — same auth, same dependency surface. Operator can override
// either provider or model via `settings.embedding.{provider,model}`.
//
// Default model per provider (all chosen for the homelab/single-host use case):
//   ollama / unknown    → nomic-embed-text                (768d, free, local)
//   openai / compat     → text-embedding-3-small          (1536d, ~$0.02/1M)
//   google              → text-embedding-004              (768d)
//   anthropic           → falls back to openai embeddings (Anthropic has no
//                                                          first-party API as
//                                                          of 2026-05)

function embeddingCfg() {
  const s: any = settings.get().embedding || {};
  const llm = llmCfg();
  return {
    enabled: s.enabled !== false,
    provider: s.provider || llm.provider || 'ollama',
    model: s.model || '',
    apiKey: s.apiKey || llm.apiKey || '',
    ollamaUrl: s.ollamaUrl || llm.ollamaUrl || '',
    baseUrl: s.baseUrl || llm.baseUrl || '',
  };
}

function defaultEmbeddingModelFor(provider: string): string {
  switch (provider) {
    case 'openai':
    case 'openai-compatible':
      return 'text-embedding-3-small';
    case 'google':
      return 'text-embedding-004';
    case 'anthropic':
      // No first-party Anthropic embedding API. We resolve via openai.
      return 'text-embedding-3-small';
    case 'ollama':
    default:
      return 'nomic-embed-text';
  }
}

function defaultEmbeddingDimFor(model: string): number {
  // Authoritative dim lookup for the default models. If the operator picks a
  // model not in this table, library-db will reject the dim mismatch at
  // upsert time with a friendly --reseed message.
  if (model === 'nomic-embed-text') return 768;
  if (model === 'mxbai-embed-large') return 1024;
  if (model === 'text-embedding-3-small') return 1536;
  if (model === 'text-embedding-3-large') return 3072;
  if (model === 'text-embedding-004') return 768;
  // Unknown model — assume the homelab default until the operator says
  // otherwise via settings.embedding.dim.
  return 768;
}

export function embeddingModel() {
  const cfg = embeddingCfg();
  const id = cfg.model || defaultEmbeddingModelFor(cfg.provider);
  const sig = `embed|${cfg.provider}|${id}|${cfg.apiKey || ''}|${cfg.ollamaUrl}|${cfg.baseUrl}`;

  const cached = clientCache.get(sig);
  if (cached) return cached;

  let model;
  switch (cfg.provider) {
    case 'openai': {
      const provider = createOpenAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider.textEmbeddingModel(id);
      break;
    }
    case 'openai-compatible': {
      const provider = createOpenAI({
        baseURL: cfg.baseUrl,
        apiKey: cfg.apiKey || 'unused',
        name: 'openai-compatible',
      });
      model = provider.textEmbeddingModel(id);
      break;
    }
    case 'google': {
      const provider = createGoogleGenerativeAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider.textEmbeddingModel(id);
      break;
    }
    case 'anthropic': {
      // Anthropic has no first-party embedding model; punt to OpenAI.
      const provider = createOpenAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      model = provider.textEmbeddingModel(id);
      break;
    }
    case 'ollama':
    default: {
      const provider = createOllama({ baseURL: ollamaBaseUrl(cfg as any) });
      model = provider.textEmbeddingModel(id);
      break;
    }
  }

  clientCache.set(sig, model);
  return model;
}

export function activeEmbeddingModelLabel(): string {
  const cfg = embeddingCfg();
  return `${cfg.provider}:${cfg.model || defaultEmbeddingModelFor(cfg.provider)}`;
}

export function activeEmbeddingDim(): number {
  const cfg = embeddingCfg();
  const id = cfg.model || defaultEmbeddingModelFor(cfg.provider);
  return defaultEmbeddingDimFor(id);
}

export function embeddingEnabled(): boolean {
  return embeddingCfg().enabled;
}

// Surface enough config for the tagger to (a) write a useful error message
// and (b) auto-pull a missing model on the Ollama provider. Intentionally
// just the fields callers need — no secrets, no live SDK clients.
export function embeddingProviderInfo(): {
  provider: string;
  model: string;
  ollamaUrl: string;
} {
  const cfg = embeddingCfg();
  return {
    provider: cfg.provider,
    model: cfg.model || defaultEmbeddingModelFor(cfg.provider),
    ollamaUrl: cfg.provider === 'ollama' ? ollamaBaseUrl(cfg as any) : '',
  };
}
