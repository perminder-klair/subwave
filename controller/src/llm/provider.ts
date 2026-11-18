// Public surface for the provider registry. Implementation split under
// internal/provider/** — registry (languageModel + cache), legs (primary/
// fallback + probe), embedding (embedding models). Barrel so call sites keep
// importing from `llm/provider.js` unchanged.

export {
  activeModelLabel,
  providerName,
  activeOllamaUrl,
  DEFAULT_LOCCA_BASE_URL,
  OPENROUTER_APP_HEADERS,
  customHeaders,
  noThinkFetch,
} from './internal/provider/registry.js';

export { primaryLeg, fallbackLeg, legLabel, probeLegReachable, warmCompatDetection } from './internal/provider/legs.js';
export type { Leg } from './internal/provider/legs.js';

export {
  detectCompatibleMode,
  cachedCompatDetection,
} from './internal/provider/compat-detect.js';
export type { CompatDetection } from './internal/provider/compat-detect.js';

export {
  embeddingModel,
  activeEmbeddingModelLabel,
  activeEmbeddingDim,
  embeddingEnabled,
  embeddingProviderInfo,
  embeddingInfoOf,
  embeddingBaseUrl,
  resolveEmbeddingCfg,
  buildEmbeddingModel,
  isHeavyEmbeddingModel,
  isLocalEmbeddingProvider,
  embeddingTextPrefixes,
} from './internal/provider/embedding.js';
export type { EmbeddingCfg, EmbeddingTextPrefixes } from './internal/provider/embedding.js';
