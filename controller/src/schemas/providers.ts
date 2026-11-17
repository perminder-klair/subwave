// The LLM provider catalogue: one record per provider, data only. Everything
// that lists providers derives from it: the controller's LLM_PROVIDERS and
// EMBEDDING_PROVIDERS (so GET /settings, the pickers and every "must be one of"
// error keep this order), the secrets allowlist and its env flags, a
// fixed-endpoint gateway's apiKeyEnv, the web's labels, key hints and
// embedding suggestions, and the CLI wizard's options (embedded at build time
// by cli/scripts/embed-assets.ts, because the wizard runs before any controller
// exists). Behaviour does NOT live here: a provider's quirks are a capability
// descriptor in llm/internal/provider/capabilities.ts, and a fixed-endpoint
// gateway names one of its shared reasoning rules rather than carrying code.
//
// Mirrored to web/lib/schemas.generated.ts by `npm run gen:schemas`, so it
// imports nothing. Pinned by scripts/provider-catalogue.test.ts.

// The picker's three groups, in display order.
export const PROVIDER_GROUPS = ['network', 'vendor', 'gateway'] as const;
export type ProviderGroup = (typeof PROVIDER_GROUPS)[number];

// The reasoning rules in capabilities.ts a fixed-endpoint gateway can pick.
export type GatewayReasoningRule = 'openaiModels' | 'minimalWhenOff' | 'vendorRouted';

export interface LlmProviderEntry {
  id: string;
  // Short card name, and the longer descriptor for dropdowns and banners.
  label: string;
  longLabel: string;
  // One line under the card name: what the operator is choosing.
  blurb: string;
  // network: runs on a box the operator owns. vendor: one model maker's own
  // API. gateway: one key in front of many vendors.
  group: ProviderGroup;
  // The key-status badge: local needs no key, self-hosted takes an optional
  // bearer, cloud needs envVar.
  kind: 'local' | 'self-hosted' | 'cloud';
  // Env var the key lives in (state/secrets.env); cloud providers only.
  envVar?: string;
  // Key-field placeholder in the admin UI.
  keyPlaceholder?: string;
  // A model id the CLI shows as a placeholder; never a default.
  exampleModel?: string;
  // The CLI wizard's option; a cloud option's hint is `needs <envVar>`.
  cliLabel: string;
  cliHint?: string;
  // An OpenAI-compatible service at a fixed base URL, reached through
  // createOpenAI like a self-hosted server. Such a gateway takes the one
  // generic path through the registry, the embedding builder, the model
  // lister, the onboarding test and the admin key probe, and its key is read at
  // construction (capabilities apiKeyEnv), so envVar is required.
  openaiCompatible?: { baseUrl: string; reasoning: GatewayReasoningRule };
  // Present when the provider serves text embeddings. defaultModel is what an
  // empty model field resolves to; suggestions fill the admin model picker.
  embedding?: { defaultModel: string; suggestions?: readonly { id: string; dim: number }[] };
}

const OPENAI_EMBEDDING_MODELS = [
  { id: 'text-embedding-3-small', dim: 1536 },
  { id: 'text-embedding-3-large', dim: 3072 },
] as const;

const VENDOR_PREFIXED_OPENAI_EMBEDDING_MODELS = [
  { id: 'openai/text-embedding-3-small', dim: 1536 },
  { id: 'openai/text-embedding-3-large', dim: 3072 },
] as const;

export const LLM_PROVIDER_CATALOG: readonly LlmProviderEntry[] = [
  {
    id: 'ollama', label: 'Ollama', longLabel: 'Ollama (local/cloud)', blurb: 'Homelab box · no key',
    group: 'network', kind: 'local',
    cliLabel: 'Ollama — local homelab', cliHint: 'no API key — point at your homelab box',
    // Ollama wants the short tag, not an HF/locca repo id (those 404). dim is
    // shown so an already-tagged library can be matched.
    embedding: {
      defaultModel: 'nomic-embed-text',
      suggestions: [
        { id: 'nomic-embed-text', dim: 768 },
        { id: 'mxbai-embed-large', dim: 1024 },
        { id: 'bge-m3', dim: 1024 },
        { id: 'all-minilm', dim: 384 },
      ],
    },
  },
  {
    id: 'openai-compatible', label: 'OpenAI-compatible', longLabel: 'OpenAI-compatible (llama.cpp, vLLM, LM Studio)',
    blurb: 'llama.cpp · vLLM · LM Studio', group: 'network', kind: 'self-hosted',
    exampleModel: 'qwen3',
    cliLabel: 'OpenAI-compatible — self-hosted', cliHint: 'llama.cpp, vLLM, LM Studio — your own server URL',
    embedding: { defaultModel: 'text-embedding-3-small' },
  },
  {
    id: 'locca', label: 'locca', longLabel: 'locca (local llama.cpp, host)', blurb: 'Local llama.cpp · no key',
    group: 'network', kind: 'local',
    exampleModel: 'qwen3',
    cliLabel: 'locca — local llama.cpp', cliHint: 'no API key — defaults to the host locca server',
    embedding: { defaultModel: 'nomic-embed-text' },
  },
  {
    id: 'openrouter', label: 'OpenRouter', longLabel: 'OpenRouter (multi-vendor aggregator)', blurb: 'Multi-vendor aggregator',
    group: 'gateway', kind: 'cloud', envVar: 'OPENROUTER_API_KEY', keyPlaceholder: 'sk-or-v1-...',
    exampleModel: 'anthropic/claude-sonnet-4-5', cliLabel: 'OpenRouter — multi-vendor',
    embedding: { defaultModel: 'openai/text-embedding-3-small', suggestions: VENDOR_PREFIXED_OPENAI_EMBEDDING_MODELS },
  },
  {
    id: 'requesty', label: 'Requesty', longLabel: 'Requesty (multi-vendor aggregator)', blurb: 'Multi-vendor aggregator',
    group: 'gateway', kind: 'cloud', envVar: 'REQUESTY_API_KEY', keyPlaceholder: 'Requesty API key',
    exampleModel: 'openai/gpt-4o-mini', cliLabel: 'Requesty — multi-vendor',
    openaiCompatible: { baseUrl: 'https://router.requesty.ai/v1', reasoning: 'minimalWhenOff' },
    embedding: { defaultModel: 'openai/text-embedding-3-small', suggestions: VENDOR_PREFIXED_OPENAI_EMBEDDING_MODELS },
  },
  {
    id: 'anthropic', label: 'Anthropic', longLabel: 'Anthropic (Claude)', blurb: 'Claude · cloud',
    group: 'vendor', kind: 'cloud', envVar: 'ANTHROPIC_API_KEY', keyPlaceholder: 'sk-ant-...',
    exampleModel: 'claude-sonnet-4-5', cliLabel: 'Anthropic — Claude',
  },
  {
    id: 'openai', label: 'OpenAI', longLabel: 'OpenAI (GPT)', blurb: 'GPT · cloud',
    group: 'vendor', kind: 'cloud', envVar: 'OPENAI_API_KEY', keyPlaceholder: 'sk-...',
    exampleModel: 'gpt-4o-mini', cliLabel: 'OpenAI — GPT',
    embedding: { defaultModel: 'text-embedding-3-small', suggestions: OPENAI_EMBEDDING_MODELS },
  },
  {
    id: 'google', label: 'Google', longLabel: 'Google (Gemini)', blurb: 'Gemini · cloud',
    group: 'vendor', kind: 'cloud', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY', keyPlaceholder: 'AIza...',
    exampleModel: 'gemini-2.5-flash', cliLabel: 'Google — Gemini',
    embedding: { defaultModel: 'text-embedding-004', suggestions: [{ id: 'text-embedding-004', dim: 768 }] },
  },
  {
    id: 'deepseek', label: 'DeepSeek', longLabel: 'DeepSeek', blurb: 'Chat & reasoner · cloud',
    group: 'vendor', kind: 'cloud', envVar: 'DEEPSEEK_API_KEY', keyPlaceholder: 'sk-...',
    exampleModel: 'deepseek-chat', cliLabel: 'DeepSeek',
  },
  {
    id: 'gateway', label: 'AI Gateway', longLabel: 'Vercel AI Gateway (multi-vendor aggregator)', blurb: 'Vercel · multi-vendor',
    group: 'gateway', kind: 'cloud', envVar: 'AI_GATEWAY_API_KEY', keyPlaceholder: 'gateway API key',
    exampleModel: 'anthropic/claude-sonnet-4-5', cliLabel: 'Vercel AI Gateway — multi-vendor',
  },
];

export const LLM_PROVIDER_IDS: readonly string[] = LLM_PROVIDER_CATALOG.map((p) => p.id);

// The embedding-capable subset, in catalogue order.
export const EMBEDDING_PROVIDER_IDS: readonly string[] = LLM_PROVIDER_CATALOG
  .filter((p) => p.embedding)
  .map((p) => p.id);

// Every LLM provider key the secrets file may hold, in catalogue order.
export const LLM_KEY_ENV_VARS: readonly string[] = LLM_PROVIDER_CATALOG
  .flatMap((p) => (p.envVar ? [p.envVar] : []));

export function llmProviderEntry(id: string | undefined): LlmProviderEntry | undefined {
  return LLM_PROVIDER_CATALOG.find((p) => p.id === id);
}

export type OpenAICompatibleGateway = LlmProviderEntry & {
  envVar: string;
  openaiCompatible: NonNullable<LlmProviderEntry['openaiCompatible']>;
};

// The catalogue entry when `id` is a fixed-endpoint OpenAI-compatible gateway.
export function openaiCompatibleGateway(id: string | undefined): OpenAICompatibleGateway | undefined {
  const p = llmProviderEntry(id);
  return p?.openaiCompatible && p.envVar ? (p as OpenAICompatibleGateway) : undefined;
}

export const OPENAI_COMPATIBLE_GATEWAYS: readonly OpenAICompatibleGateway[] = LLM_PROVIDER_CATALOG
  .flatMap((p) => {
    const gw = openaiCompatibleGateway(p.id);
    return gw ? [gw] : [];
  });
