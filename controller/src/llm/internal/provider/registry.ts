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
import { config } from '../../../config.js';
import * as settings from '../../../settings.js';

// Memoise built clients so we don't reconstruct a provider on every call.
// Keyed by a signature that changes whenever provider/model/key changes, so a
// settings edit is picked up on the next call with no explicit invalidation.
const clientCache = new Map();

export function llmCfg() {
  return settings.get().llm
    || { provider: 'ollama', model: '', apiKey: '', ollamaUrl: '', baseUrl: '', reasoning: false };
}

// When reasoning is disabled, llama.cpp / vLLM / LM Studio honour
// chat_template_kwargs.enable_thinking=false — the Qwen3 (and similar)
// chat template then omits the <think> priming entirely, so the model
// never starts a chain-of-thought. Injected via a fetch wrapper because
// the AI SDK's openai provider has no first-class field for it.
function noThinkFetch(url: any, init: any) {
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
export function ollamaBaseUrl(cfg: any): string {
  return cfg.ollamaUrl || config.ollama.url;
}

// Resolve the concrete model id. Ollama falls back to the env-configured
// model; cloud providers must name a model explicitly — guessing a model id
// that may not exist fails worse than a clear error.
export function resolveModelId(cfg: any): string {
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
export function languageModel(cfg: any = llmCfg()) {
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
export function activeModelLabel(): string {
  const cfg = llmCfg();
  try {
    return `${cfg.provider}:${resolveModelId(cfg)}`;
  } catch {
    return `${cfg.provider}:(unset)`;
  }
}

// The active provider id, used to gate provider-specific sampling
// (repeat_penalty is Ollama-only) and by /stats and /debug for telemetry.
export function providerName(): string {
  return llmCfg().provider;
}

// The effective Ollama server URL — settings field, or the config default.
// Used by /debug to report what the registry will actually talk to.
export function activeOllamaUrl(): string {
  return ollamaBaseUrl(llmCfg());
}
