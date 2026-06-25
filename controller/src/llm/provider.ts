// Public surface for the provider registry. Implementation split under
// internal/provider/** — registry (languageModel + cache), legs (primary/
// fallback + probe), embedding (embedding models). Barrel so call sites keep
// importing from `llm/provider.js` unchanged.

export {
  languageModel,
  activeModelLabel,
  providerName,
  activeOllamaUrl,
  loccaBaseUrl,
  DEFAULT_LOCCA_BASE_URL,
  DEFAULT_REQUESTY_BASE_URL,
  noThinkFetch,
} from './internal/provider/registry.js';

export { primaryLeg, fallbackLeg, probeLegReachable } from './internal/provider/legs.js';
export type { Leg } from './internal/provider/legs.js';

export {
  embeddingModel,
  activeEmbeddingModelLabel,
  activeEmbeddingDim,
  embeddingEnabled,
  embeddingProviderInfo,
  embeddingInfoOf,
  resolveEmbeddingCfg,
  buildEmbeddingModel,
} from './internal/provider/embedding.js';
export type { EmbeddingCfg } from './internal/provider/embedding.js';
