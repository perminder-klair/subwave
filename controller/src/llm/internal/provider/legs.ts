// Legs — primary + optional fallback.
//
// A "leg" bundles everything a single LLM attempt needs: the resolved config
// (so the strategy layer can pick the provider-specific structured-output path +
// sampling from the right provider), the built AI SDK model, and a log label.
// withFailover (core/failover.ts) tries the primary leg, and only on a
// host-unreachable error retries against the fallback leg. See discussion #320.

import * as settings from '../../../settings.js';
import { languageModel, resolveModelId, ollamaBaseUrl, llmCfg } from './registry.js';

export interface Leg {
  cfg: any;       // the resolved llm config for this leg
  model: any;     // AI SDK LanguageModel — honours the operator reasoning toggle
  // Reasoning-disabled variant for forced-tool / structured legs (picker, done-
  // tool, objectViaToolCall). Identical to `model` for every provider that can
  // suppress thinking per-call; a separate instance only for OpenRouter, whose
  // reasoning is fixed at construction. Lets the DJ's free-text keep reasoning
  // while the picker runs no-think — no operator knowledge required.
  noThinkModel: any;
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
  return { cfg, model: languageModel(cfg), noThinkModel: languageModel(cfg, { forceNoThink: true }), label: labelFor(cfg) };
}

// The optional backup leg, or null when no usable fallback is configured.
// Built lazily — only after a primary failure — so a disabled or misconfigured
// fallback never affects healthy calls. A bad config (e.g. cloud provider with
// no model) degrades to "no fallback" rather than throwing over the primary's
// own error.
export function fallbackLeg(): Leg | null {
  const stored = settings.get().llm?.fallback;
  if (!stored || !stored.enabled) return null;
  // Resolve the fallback's inline key per-provider (issue #657) — the stored
  // fallback.apiKey slot is legacy/empty now. Empty → its env var, as before.
  const fb = { ...stored, apiKey: settings.llmKeyFor(stored.provider) };
  try {
    return { cfg: fb, model: languageModel(fb), noThinkModel: languageModel(fb, { forceNoThink: true }), label: labelFor(fb) };
  } catch {
    return null;
  }
}

// Cheap liveness check for a leg's host, used by the dual-LLM tagger to decide
// whether to spin up a second consumer before committing a long run to it
// (discussion #320). A self-hosted box that's switched off should fail fast here
// rather than after a batch of connect timeouts. Any HTTP answer — even 401/404
// — means the host is up; only a connection/DNS/timeout failure is "down". Cloud
// providers can't be cheaply probed and are assumed reachable; an outage there
// surfaces mid-run and the consumer is dropped then.
export async function probeLegReachable(leg: Leg, timeoutMs = 3000): Promise<boolean> {
  const cfg = leg?.cfg;
  if (!cfg) return false;
  let url: string;
  if (cfg.provider === 'ollama') {
    url = `${ollamaBaseUrl(cfg).replace(/\/$/, '')}/api/version`;
  } else if (cfg.provider === 'openai-compatible') {
    if (!cfg.baseUrl) return false;
    url = `${cfg.baseUrl.replace(/\/$/, '')}/models`;
  } else {
    // Hosted provider — no cheap local probe; assume up.
    return true;
  }
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
