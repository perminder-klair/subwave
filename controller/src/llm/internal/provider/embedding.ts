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
//   azure               → NO default: the id is a DEPLOYMENT name on the
//                                     operator's own resource, which nothing can
//                                     guess. A blank one is refused.

import { createOpenAI } from '@ai-sdk/openai';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOllama } from 'ai-sdk-ollama';
import * as settings from '../../../settings.js';
import { llmCfg, ollamaBaseUrl, loccaEmbedBaseUrl, azureEndpoint, OPENROUTER_APP_HEADERS } from './registry.js';

// Separate from the registry's language-model cache — the signature is prefixed
// `embed|` so there's no key overlap, and keeping it local avoids exporting a
// mutable Map across modules. Memoisation only; outputs are identical.
const embedCache = new Map();

function embeddingCfg() {
  const s: any = settings.get().embedding || {};
  const llm = llmCfg();
  const provider = s.provider || llm.provider || 'ollama';
  // `baseUrl` inherits the CHAT leg's flat field, which is what keeps a blank
  // embedding URL working on a station whose DJ already points somewhere (#319).
  // Azure is the one provider that must NOT take that inheritance from a
  // different provider: its baseUrl is a RESOURCE endpoint, and azureEndpoint()
  // would dutifully build `<some llama.cpp URL>/openai/v1` out of a chat leg's
  // server — a plausible-looking endpoint that silently talks to the wrong box,
  // where an honest "no Azure endpoint is set" is what the operator needs. When
  // the chat leg IS azure the inheritance is exactly right and is kept, which is
  // the common case (embedding.provider blank = follow the DJ).
  const inheritedBaseUrl =
    provider === 'azure' && llm.provider !== 'azure' ? '' : (llm.baseUrl || '');
  return {
    enabled: s.enabled !== false,
    provider,
    model: s.model || '',
    // Key precedence: the saved settings field wins, then a dedicated
    // `EMBEDDING_API_KEY` env var (the env path most installs use -- keys live in
    // state/secrets.env, not settings.json), then the chat key. This is a
    // runtime env read like config.ts does for SEARCH_API_KEY, so the env value
    // never gets baked into the persisted settings.json. It covers every
    // provider uniformly -- including openai-compatible/locca, which can't safely
    // grab a provider-conventional env var (createOpenAI would otherwise reach
    // for OPENAI_API_KEY against an arbitrary self-hosted server).
    apiKey: s.apiKey || process.env.EMBEDDING_API_KEY || llm.apiKey || '',
    ollamaUrl: s.ollamaUrl || llm.ollamaUrl || '',
    baseUrl: s.baseUrl || inheritedBaseUrl,
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
    case 'requesty':
      // Requesty is OpenAI-compatible and uses provider/model naming, so the
      // OpenAI embedding model is the safe default — same as openrouter.
      return 'openai/text-embedding-3-small';
    case 'anthropic':
      // No first-party Anthropic embedding API. We resolve via openai.
      return 'text-embedding-3-small';
    case 'azure':
      // Deliberately blank. Azure's model id is the DEPLOYMENT name the operator
      // chose, so 'text-embedding-3-small' would be a guess dressed as a default
      // — and the same reasoning as registry.resolveModelId()'s azure branch
      // applies: naming a deployment that may not exist fails worse than a clear
      // error. buildEmbeddingModel refuses a blank one; this table stays TOTAL so
      // the display paths (activeEmbeddingModelLabel / activeEmbeddingDim /
      // embeddingInfoOf) never throw just to render a settings page.
      return '';
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

// Heuristic: is this a "heavy" embedding model — large + slow on CPU relative to
// the light homelab default (nomic-embed-text, ~137M / 768d)? Name-based only,
// drives a perf advisory (doctor) — so unknown models default to NOT heavy, no
// false alarms. The common heavy local picks are bge-m3 (~567M / 1024d,
// multilingual) and mxbai-embed-large (~335M / 1024d); the OpenAI/BGE "-large"
// variants and Qwen embeddings are heavy too (only flagged when run locally —
// see embeddingPerfAdvisory, which gates on provider).
export function isHeavyEmbeddingModel(model: string): boolean {
  const bare = (model || '').toLowerCase();
  if (!bare) return false;
  if (bare.includes('bge-m3')) return true;
  if (bare.includes('large')) return true;       // mxbai-embed-large, *-embedding-3-large, bge-large-*
  if (/qwen3?-?embed/.test(bare)) return true;    // qwen embeddings
  return false;
}

// Task prefixes some embedding models are trained with. Name-based like
// isHeavyEmbeddingModel — unknown models get no prefixes.
//
// nomic-embed-text (the shipped Ollama default) REQUIRES them: the model card
// marks `search_document:` / `search_query:` as mandatory for retrieval, and
// embedding bare measurably degrades neighbour quality. Its document prefix
// changes the stored vectors, so the index records which mode it was built in
// (embedding_meta.text_mode) and queries follow suit.
//
// mxbai-embed-large wants a query-side instruction only — documents embed
// bare, so its query prefix is always safe to apply regardless of index mode.
export interface EmbeddingTextPrefixes {
  document: string; // prepended to indexed track texts; '' = embed bare
  query: string;    // prepended to search queries; '' = embed bare
}

export function embeddingTextPrefixes(model: string): EmbeddingTextPrefixes {
  const bare = (model || '').toLowerCase();
  if (bare.includes('nomic-embed')) {
    return { document: 'search_document: ', query: 'search_query: ' };
  }
  if (bare.includes('mxbai-embed-large')) {
    return { document: '', query: 'Represent this sentence for searching relevant passages: ' };
  }
  return { document: '', query: '' };
}

// Does this embedding provider run on the operator's own hardware (so model
// weight is a CPU/RAM concern they pay for), vs a cloud API that does the work
// off-box? Gates the heavy-model perf advisory — a big model on OpenAI/Google is
// not the operator's performance problem. ollama / locca / openai-compatible are
// the self-hosted transports.
export function isLocalEmbeddingProvider(provider: string): boolean {
  return provider === 'ollama' || provider === 'locca' || provider === 'openai-compatible';
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
  // '' is meaningful for provider (= follow llm), so only override when a
  // non-empty value is supplied.
  const provider = overrides.provider || base.provider;
  // The other half of embeddingCfg()'s azure rule, for the path that resolves
  // the provider LATER: the admin's "Test embeddings" button sends unsaved form
  // values, so an override can switch the provider to azure while `base.baseUrl`
  // was still resolved for whatever is saved. Inheriting it there would hand
  // azureEndpoint() a chat server's URL. The callers that HAVE an endpoint send
  // one (the admin form forwards the LLM tab's azure slot), so an absent
  // override here really does mean "no Azure endpoint configured".
  const inheritable = provider === 'azure' && base.provider !== 'azure' ? '' : base.baseUrl;
  return {
    enabled: overrides.enabled ?? base.enabled,
    provider,
    model: overrides.model ?? base.model,
    apiKey: overrides.apiKey || base.apiKey,
    ollamaUrl: overrides.ollamaUrl || base.ollamaUrl,
    baseUrl: overrides.baseUrl || inheritable,
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
    case 'azure': {
      // Azure OpenAI: the same OpenAI embedding models, deployed on the
      // operator's OWN resource. Everything about WHERE the request goes is
      // already decided by azureEndpoint() — the modern `/openai/v1` surface vs
      // the legacy `/openai/deployments/<dep>/…?api-version=` one — and that
      // resolver stays the single owner of the choice, shared with the chat leg.
      // @ai-sdk/azure's url() appends `/embeddings` to whichever it hands back.
      //
      // Note what is NOT wired: azureChatFetch. It exists to learn the three
      // chat-completion parameter rejections (max_tokens / temperature / top_p),
      // and an embeddings request carries none of them.
      const ep = azureEndpoint(cfg);
      if (!ep.baseURL) {
        throw new Error(
          'No Azure endpoint is set for embeddings. In /admin/settings → Library ' +
            'tagger → Embedding, paste your resource endpoint ' +
            '(https://<resource>.openai.azure.com).',
        );
      }
      if (!id) {
        throw new Error(
          'embedding.provider is "azure" but no model is set — enter the ' +
            'DEPLOYMENT name of your embedding deployment (what you called it in ' +
            'Azure, e.g. text-embedding-3-small) in /admin/settings → Library ' +
            'tagger → Embedding.',
        );
      }
      // The inherited chain (settings.embedding.apiKey → EMBEDDING_API_KEY →
      // the CHAT leg's key) misses one real case: a station whose DJ is on
      // Ollama but which has an inline Azure key on file. Reaching for this
      // provider's own key here is the same move the openrouter/requesty
      // branches make with their env vars. Spread conditionally so that with
      // nothing on file @ai-sdk/azure still reads AZURE_API_KEY itself, exactly
      // as registry.ts does for the chat leg.
      const apiKey = cfg.apiKey || settings.llmKeyFor('azure') || '';
      const provider = createAzure({
        baseURL: ep.baseURL,
        ...(ep.apiVersion ? { apiVersion: ep.apiVersion } : {}),
        ...(ep.useDeploymentBasedUrls ? { useDeploymentBasedUrls: true } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
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
        apiKey: cfg.apiKey || process.env.OPENROUTER_API_KEY || 'unused',
        name: 'openrouter',
        headers: OPENROUTER_APP_HEADERS,
      });
      return provider.textEmbeddingModel(id);
    }
    case 'requesty': {
      // Requesty exposes an OpenAI-compatible embeddings endpoint
      // (POST https://router.requesty.ai/v1/embeddings), so it routes through
      // the same createOpenAI transport as openrouter — just a fixed base URL.
      // A real key is required — a missing one 401s with the 'unauthorized'
      // message.
      const provider = createOpenAI({
        baseURL: 'https://router.requesty.ai/v1',
        apiKey: cfg.apiKey || process.env.REQUESTY_API_KEY || 'unused',
        name: 'requesty',
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
          `(ollama, openai, azure, google, openrouter, requesty, locca, or ` +
          `openai-compatible).`,
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
  // `(unset)` mirrors registry.activeModelLabel()'s catch branch: azure has no
  // default deployment name, and a label reading `azure:` tells the operator
  // nothing about why the doctor line looks wrong.
  const id = cfg.model || defaultEmbeddingModelFor(cfg.provider) || '(unset)';
  return `${cfg.provider}:${id}`;
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
