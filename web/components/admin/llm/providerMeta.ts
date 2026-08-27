// Single source of truth for the LLM provider picker, shared by the Settings LLM
// tab and the onboarding wizard's LLM step. Mirrors the TTS engineMeta.ts.
// No React, no DOM — safe to unit-import.

export type ProviderKind = 'local' | 'self-hosted' | 'cloud';

export interface ProviderMeta {
  id: string;
  // Short card name; LLM_PROVIDER_LABELS holds the longer dropdown descriptor.
  label: string;
  // One-line descriptor under the name — what the operator is choosing.
  blurb: string;
  // local: runs on a box you own, no key (ollama/locca). self-hosted: your own
  // OpenAI-compatible server, key optional. cloud: hosted vendor, needs a key.
  kind: ProviderKind;
  // Controller env var the key is read from — cloud providers only.
  envVar?: string;
}

// Order mirrors the controller's settings.LLM_PROVIDERS. The grid renders
// data.llm.providers (server-authoritative) and looks each id up here, so a
// provider the server adds before this map does still renders as a bare card.
export const PROVIDERS: ProviderMeta[] = [
  { id: 'ollama',            label: 'Ollama',            blurb: 'Homelab box · no key',          kind: 'local' },
  { id: 'locca',             label: 'locca',             blurb: 'Local llama.cpp · no key',       kind: 'local' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', blurb: 'llama.cpp · vLLM · LM Studio',   kind: 'self-hosted' },
  { id: 'anthropic',         label: 'Anthropic',         blurb: 'Claude · cloud',                 kind: 'cloud', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai',            label: 'OpenAI',            blurb: 'GPT · cloud',                    kind: 'cloud', envVar: 'OPENAI_API_KEY' },
  { id: 'google',            label: 'Google',            blurb: 'Gemini · cloud',                 kind: 'cloud', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  { id: 'deepseek',          label: 'DeepSeek',          blurb: 'Chat & reasoner · cloud',        kind: 'cloud', envVar: 'DEEPSEEK_API_KEY' },
  { id: 'openrouter',        label: 'OpenRouter',        blurb: 'Multi-vendor aggregator',        kind: 'cloud', envVar: 'OPENROUTER_API_KEY' },
  { id: 'requesty',          label: 'Requesty',          blurb: 'Multi-vendor aggregator',        kind: 'cloud', envVar: 'REQUESTY_API_KEY' },
  { id: 'orcarouter',        label: 'OrcaRouter',        blurb: 'Multi-vendor aggregator',        kind: 'cloud', envVar: 'ORCAROUTER_API_KEY' },
  { id: 'gateway',           label: 'AI Gateway',        blurb: 'Vercel · multi-vendor',          kind: 'cloud', envVar: 'AI_GATEWAY_API_KEY' },
];

export const PROVIDER_META: Record<string, ProviderMeta> = Object.fromEntries(
  PROVIDERS.map(p => [p.id, p]),
);

// Default render order (local first). Settings passes the server's list instead;
// onboarding has none yet and maps over this.
export const PROVIDER_IDS: string[] = PROVIDERS.map(p => p.id);

// Derived from PROVIDERS so the two never drift; exported because SettingsPanel
// indexes it directly.
export const LLM_ENV_VARS: Record<string, string> = Object.fromEntries(
  PROVIDERS.filter(p => p.envVar).map(p => [p.id, p.envVar as string]),
);

// Longer descriptors for the dropdown and the "Routing now" banner.
export const LLM_PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama (local/cloud)',
  locca: 'locca (local llama.cpp, host)',
  'openai-compatible': 'OpenAI-compatible (llama.cpp, vLLM, LM Studio)',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (GPT)',
  google: 'Google (Gemini)',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter (multi-vendor aggregator)',
  requesty: 'Requesty (multi-vendor aggregator)',
  orcarouter: 'OrcaRouter (multi-vendor aggregator)',
  gateway: 'Vercel AI Gateway (multi-vendor aggregator)',
};

export const llmProviderLabel = (id: string | undefined): string =>
  (id && LLM_PROVIDER_LABELS[id]) || id || '—';

export type ProviderStatusTone = 'ok' | 'warn';
export interface ProviderStatus {
  label: string;
  tone: ProviderStatusTone;
}

// Local providers are always "ready" (no key to miss) and a self-hosted
// OpenAI-compatible server's bearer is optional, so it reads ready too. The one
// `warn` case is a cloud provider whose key var isn't set — the #1
// switch-and-it-fails misconfiguration this grid exists to surface before save.
//
// keyAware=false is the onboarding case: first-run has no live controller env, so
// cloud providers read as a neutral "needs key" rather than a red "no key".
export function providerStatus(
  id: string,
  env: Record<string, unknown> | undefined,
  keyAware = true,
): ProviderStatus {
  const meta = PROVIDER_META[id];
  if (!meta) return { label: '', tone: 'ok' };
  switch (meta.kind) {
    case 'local':
      return { label: 'local', tone: 'ok' };
    case 'self-hosted':
      return { label: 'self-host', tone: 'ok' };
    case 'cloud':
      if (!keyAware) return { label: 'needs key', tone: 'ok' };
      return meta.envVar && (env || {})[meta.envVar]
        ? { label: 'key set', tone: 'ok' }
        : { label: 'no key', tone: 'warn' };
    default:
      return { label: '', tone: 'ok' };
  }
}
