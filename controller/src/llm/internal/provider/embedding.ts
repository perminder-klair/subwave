// Embedding models — the library tagger uses text embeddings for
// KNN-propagating moods (see music/embeddings.ts + music/tag-library.ts).
// Provider follows `settings.llm` by default — same auth, same dependency
// surface — but operator can override either provider or model via
// `settings.embedding.{provider,model}`.
//
// Default model per provider (all chosen for the homelab/single-host use case):
//   ollama / unknown    → nomic-embed-text                (768d, free, local)
//   openai / compat     → text-embedding-3-small          (1536d, ~$0.02/1M)
//   google              → text-embedding-004              (768d)
//   openrouter          → openai/text-embedding-3-small   (OpenAI-compatible
//                                                          embeddings endpoint)
//   anthropic           → falls back to openai embeddings (Anthropic has no
//                                                          first-party API as
//                                                          of 2026-05)

import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import * as settings from '../../../settings.js';
import { llmCfg, ollamaBaseUrl, loccaEmbedBaseUrl } from './registry.js';

// Separate from the registry's language-model cache — the signature is prefixed
// `embed|` so there's no key overlap, and keeping it local avoids exporting a
// mutable Map across modules. Memoisation only; outputs are identical.
const embedCache = new Map();

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
    case 'openrouter':
      // OpenRouter proxies many embedding backends; default to the OpenAI model
      // since it's the most widely available and OpenAI-compatible (#522).
      return 'openai/text-embedding-3-small';
    case 'anthropic':
      // No first-party Anthropic embedding API. We resolve via openai.
      return 'text-embedding-3-small';
    case 'locca':
      // Local llama.cpp embedding server — the homelab default model.
      return 'nomic-embed-text';
    case 'ollama':
    default:
      return 'nomic-embed-text';
  }
}

function defaultEmbeddingDimFor(model: string): number {
  // Best-effort dim guess for known model names. This is only a FALLBACK seed:
  // the tagger probes the live server and uses the real vector length as the
  // authoritative dim (music/embeddings.ts probeOnce → tag-library.ts), and the
  // live controller adopts whatever dim the tagger recorded (library-db
  // adoptStoredDim). So an unknown / arbitrarily-named embedding model still
  // works — this table just seeds the schema before the first tag run (#319).
  const bare = model.includes('/') ? model.split('/').pop()! : model;
  if (bare === 'nomic-embed-text') return 768;
  if (bare === 'mxbai-embed-large') return 1024;
  if (bare === 'text-embedding-3-small') return 1536;
  if (bare === 'text-embedding-3-large') return 3072;
  if (bare === 'text-embedding-004') return 768;
  return 768; // homelab default until a probe says otherwise
}

// Resolved embedding config. `settings.embedding` overrides settings.llm field
// by field; `overrides` (e.g. unsaved form values from the probe endpoint) win
// over both. Mirrors the precedence in embeddingCfg().
export interface EmbeddingCfg {
  enabled: boolean;
  provider: string;
  model: string;
  apiKey: string;
  ollamaUrl: string;
  baseUrl: string;
}

export function resolveEmbeddingCfg(overrides: Partial<EmbeddingCfg> = {}): EmbeddingCfg {
  const base = embeddingCfg();
  return {
    enabled: overrides.enabled ?? base.enabled,
    // '' is meaningful for provider (= follow llm), so only override when a
    // non-empty value is supplied.
    provider: overrides.provider || base.provider,
    model: overrides.model ?? base.model,
    apiKey: overrides.apiKey || base.apiKey,
    ollamaUrl: overrides.ollamaUrl || base.ollamaUrl,
    baseUrl: overrides.baseUrl || base.baseUrl,
  };
}

// Effective base URL for the openai-compatible embedding transport. `locca`
// defaults to its dedicated EMBED server (`locca embed`, port 8090) — NOT the
// chat default — so first-class locca embeddings work with a blank field and
// never collapse to a relative `/embeddings` URL (fetch rejects that as "Failed
// to parse URL"). Plain `openai-compatible` has no sane default, so '' here
// means "no server configured" and the caller errors.
export function embeddingBaseUrl(cfg: { provider: string; baseUrl?: string }): string {
  if (cfg.provider === 'locca') return loccaEmbedBaseUrl(cfg);
  return cfg.baseUrl || '';
}

// Build an AI SDK text-embedding model from an explicit, already-resolved cfg.
// No caching (callers that want it wrap, like embeddingModel below) — the probe
// endpoint deliberately builds a fresh one-off client per test.
export function buildEmbeddingModel(cfg: EmbeddingCfg) {
  const id = cfg.model || defaultEmbeddingModelFor(cfg.provider);
  switch (cfg.provider) {
    case 'openai':
    case 'anthropic': {
      // Anthropic has no first-party embedding model; punt to OpenAI.
      const provider = createOpenAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      return provider.textEmbeddingModel(id);
    }
    case 'openai-compatible':
    case 'locca': {
      // locca = a self-hosted openai-compatible embedding server (run via
      // `locca embed`); same transport, the operator points baseUrl at it.
      // Resolve the base URL (locca defaults to the host) and refuse a blank
      // one with an actionable message — otherwise createOpenAI emits a
      // relative `/embeddings` URL that fetch can't parse.
      const baseURL = embeddingBaseUrl(cfg);
      if (!baseURL) {
        throw new Error(
          'No embedding server URL is set. In /admin/settings → Embedding, set ' +
            'the base URL to your embedding server (e.g. http://host:8090/v1).',
        );
      }
      const provider = createOpenAI({
        baseURL,
        apiKey: cfg.apiKey || 'unused',
        name: cfg.provider,
      });
      return provider.textEmbeddingModel(id);
    }
    case 'google': {
      const provider = createGoogleGenerativeAI(cfg.apiKey ? { apiKey: cfg.apiKey } : {});
      return provider.textEmbeddingModel(id);
    }
    case 'openrouter': {
      // OpenRouter exposes an OpenAI-compatible embeddings endpoint
      // (POST https://openrouter.ai/api/v1/embeddings), so it goes through the
      // same createOpenAI transport as openai-compatible — just a fixed base URL
      // (#522). The chat path uses @openrouter/ai-sdk-provider, but that builder
      // is chat-only; embeddings route straight through OpenAI's client. A real
      // key is required — a missing one 401s with the 'unauthorized' message.
      const provider = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: cfg.apiKey || 'unused',
        name: 'openrouter',
      });
      return provider.textEmbeddingModel(id);
    }
    case 'ollama': {
      const provider = createOllama({ baseURL: ollamaBaseUrl(cfg as any) });
      return provider.textEmbeddingModel(id);
    }
    default:
      // deepseek / gateway (and any future chat-only provider) have no embeddings
      // endpoint. Previously these fell through to the ollama branch, silently
      // pointed at a local Ollama, and failed with a misleading "can't reach
      // <provider>" (#493). Throw an honest error so the probe + tagger preflight
      // name the real problem. The picker already hides these
      // (settings.EMBEDDING_PROVIDERS) — this guards the API/JSON path.
      // (openrouter used to be here too, but it shipped embeddings — see above, #522.)
      throw new Error(
        `Provider "${cfg.provider}" has no text-embedding support. Pick an ` +
          `embedding-capable provider in Settings → Library tagger → Embedding ` +
          `(ollama, openai, google, openrouter, locca, or openai-compatible).`,
      );
  }
}

export function embeddingModel() {
  const cfg = resolveEmbeddingCfg();
  const id = cfg.model || defaultEmbeddingModelFor(cfg.provider);
  const sig = `embed|${cfg.provider}|${id}|${cfg.apiKey || ''}|${cfg.ollamaUrl}|${cfg.baseUrl}`;

  const cached = embedCache.get(sig);
  if (cached) return cached;

  const model = buildEmbeddingModel(cfg);
  embedCache.set(sig, model);
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
// Display/diagnostic info for an explicit cfg — resolves the model name and the
// effective Ollama URL. Shared by embeddingProviderInfo() (saved) and the probe
// endpoint (unsaved overrides) so error messages name the right server.
export function embeddingInfoOf(cfg: EmbeddingCfg): {
  provider: string;
  model: string;
  ollamaUrl: string;
} {
  return {
    provider: cfg.provider,
    model: cfg.model || defaultEmbeddingModelFor(cfg.provider),
    ollamaUrl: cfg.provider === 'ollama' ? ollamaBaseUrl(cfg as any) : '',
  };
}

export function embeddingProviderInfo(): {
  provider: string;
  model: string;
  ollamaUrl: string;
} {
  return embeddingInfoOf(embeddingCfg());
}
