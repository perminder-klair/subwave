// Provider probing and model discovery: does this key work, does this server
// speak the OpenAI-compatible dialect we need, and what models can it offer.
// All read-only against the provider - nothing here writes settings.
//
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { config } from '../../config.js';
import * as settings from '../../settings.js';
import * as llmProvider from '../../llm/provider.js';
import { probeEmbeddingConfig } from '../../music/embeddings.js';
import { requireAdmin } from '../../middleware/auth.js';
import { SECRET_ENV_KEYS } from '../../setup/secrets.js';
import { listenbrainzApiBase } from '../../broadcast/scrobble.js';
import { generateText, createGateway } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { fetchWithTimeout } from '../../util/fetch-timeout.js';
import { probeFishKey } from '../../llm/speech.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// ---------------------------------------------------------------------------
// probeKey — non-mutating live probe for a single secret key.
// Builds a one-off provider client using the supplied value; never writes to
// process.env or secrets.env. Always resolves (never rejects).
// ---------------------------------------------------------------------------
// Distill a raw provider/SDK error into a one-line actionable message.
function briefLlmError(err: unknown): string {
  const e = err as { message?: string; toString(): string } | null | undefined;
  const msg: string = (e?.message || e?.toString() || '').toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid') && msg.includes('key') || msg.includes('incorrect api key')) {
    return 'Key rejected — check it\'s correct and hasn\'t expired';
  }
  if (msg.includes('403') || msg.includes('forbidden')) {
    return 'Access denied — your key may not have permission for this model';
  }
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'Rate limited or quota exceeded — try again shortly';
  }
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) {
    return 'Model not found — switch to a supported model in LLM settings';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return 'Timed out — provider may be slow or unreachable';
  }
  // Fallback: first sentence or first 80 chars of the original message
  const raw: string = (e?.message || '').trim();
  const sentence = raw.split(/[.\n]/)[0].trim();
  return sentence.slice(0, 80) || 'Request failed';
}

// `hint` disambiguates keys shared by several providers — SEARCH_API_KEY holds
// a Tavily OR a Brave key depending on the selected search provider, and the
// admin UI tests the key before saving, so the saved setting can't be trusted
// mid-edit. The UI passes the provider it's editing; absent a hint we fall
// back to the saved provider, then Tavily (the original sole owner of the key).
//
// Probe budget: OpenAI's Responses API (the default path for
// createOpenAI()(model)) rejects max_output_tokens below 16 — a smaller test
// budget fails key validation with "integer below minimum value" and blocks
// saving the key entirely. 32 clears the floor on every provider.
async function probeKey(
  key: (typeof SECRET_ENV_KEYS)[number],
  value: string,
  hint?: string,
): Promise<{ ok: boolean; message: string }> {
  const cfg = settings.get().llm || {};
  const activeModel = (provider: string) =>
    cfg.provider === provider ? (cfg.model || '') : '';

  switch (key) {
    case 'ANTHROPIC_API_KEY': {
      try {
        const model = activeModel('anthropic') || 'claude-haiku-4-5-20251001';
        const m = createAnthropic({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ Anthropic key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'OPENAI_API_KEY': {
      try {
        const model = activeModel('openai') || 'gpt-4o-mini';
        const m = createOpenAI({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ OpenAI key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'GOOGLE_GENERATIVE_AI_API_KEY': {
      try {
        const model = activeModel('google') || 'gemini-1.5-flash';
        const m = createGoogleGenerativeAI({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ Google key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'DEEPSEEK_API_KEY': {
      try {
        const model = activeModel('deepseek') || 'deepseek-chat';
        const m = createDeepSeek({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ DeepSeek key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'OPENROUTER_API_KEY': {
      try {
        const model = activeModel('openrouter') || 'openai/gpt-4o-mini';
        const m = createOpenRouter({ apiKey: value, headers: llmProvider.OPENROUTER_APP_HEADERS })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ OpenRouter key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'ORCAROUTER_API_KEY': {
      try {
        const model = activeModel('orcarouter') || 'orcarouter/auto';
        const m = createOpenAI({ baseURL: llmProvider.DEFAULT_ORCAROUTER_BASE_URL, apiKey: value }).chat(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ OrcaRouter key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'AI_GATEWAY_API_KEY': {
      return { ok: true, message: 'Key format looks valid — confirm via a live LLM call' };
    }
    case 'FISH_API_KEY': {
      try {
        await probeFishKey(value);
        return { ok: true, message: '✓ Fish Audio key valid' };
      } catch (err) {
        return { ok: false, message: briefLlmError(err) };
      }
    }
    case 'ELEVENLABS_API_KEY': {
      const r = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': value },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: { message?: string } | string };
        const msg = typeof j?.detail === 'string' ? j.detail : j?.detail?.message || '';
        return { ok: false, message: r.status === 401 ? 'Key rejected — check it\'s correct and active' : (msg || `Request failed (${r.status})`) };
      }
      const u = await r.json() as { first_name?: string };
      return { ok: true, message: `✓ ElevenLabs key valid${u.first_name ? ` · account: ${u.first_name}` : ''}` };
    }
    case 'SEARCH_API_KEY': {
      const provider = hint || settings.get().search?.provider || 'tavily';
      if (provider === 'brave') {
        const url = new URL('https://api.search.brave.com/res/v1/web/search');
        url.searchParams.set('q', 'test');
        url.searchParams.set('count', '1');
        const r = await fetch(url, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': value },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
          // Brave signals a bad token as 422 SUBSCRIPTION_TOKEN_INVALID
          // (verified live), not 401/403 — check the error code too.
          const j = await r.json().catch(() => ({})) as { error?: { code?: string } };
          const rejected = r.status === 401 || r.status === 403
            || j?.error?.code === 'SUBSCRIPTION_TOKEN_INVALID';
          return { ok: false, message: rejected ? 'Key rejected — check it\'s correct and active' : `Request failed (${r.status})` };
        }
        return { ok: true, message: '✓ Brave Search key valid' };
      }
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value}` },
        body: JSON.stringify({ query: 'test', max_results: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        return { ok: false, message: r.status === 401 || r.status === 403 ? 'Key rejected — check it\'s correct and active' : `Request failed (${r.status})` };
      }
      return { ok: true, message: '✓ Tavily key valid' };
    }
    case 'EMBEDDING_API_KEY': {
      const embCfg = settings.get().embedding || {};
      const r = await probeEmbeddingConfig({
        provider: embCfg.provider || undefined,
        model: embCfg.model || undefined,
        baseUrl: embCfg.baseUrl || undefined,
        ollamaUrl: embCfg.ollamaUrl || undefined,
        apiKey: value,
      });
      return {
        ok: r.code === 'ok',
        message: r.code === 'ok'
          ? `✓ Embeddings working${r.dim ? ` (${r.dim}-dim)` : ''}`
          : r.message,
      };
    }
    case 'LASTFM_API_KEY': {
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getinfo&artist=Radiohead&api_key=${encodeURIComponent(value)}&format=json`;
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null) as { error?: number; message?: string } | null;
      if (!r.ok || j?.error) {
        return { ok: false, message: j?.error === 10 ? 'Invalid API key — check your Last.fm developer credentials' : (j?.message || `Request failed (${r.status})`) };
      }
      return { ok: true, message: '✓ Last.fm API key valid' };
    }
    case 'LISTENBRAINZ_USER_TOKEN': {
      const r = await fetch(`${listenbrainzApiBase()}/validate-token`, {
        headers: { Authorization: `Token ${value}` },
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({})) as { valid?: boolean; user_name?: string; message?: string };
      if (!j.valid) {
        return { ok: false, message: 'Token not valid — check your ListenBrainz user token' };
      }
      return { ok: true, message: `✓ ListenBrainz token valid${j.user_name ? ` · user: ${j.user_name}` : ''}` };
    }
    default:
      return { ok: false, message: `No probe defined for ${key}` };
  }
}

// ---------------------------------------------------------------------------
// POST /settings/secrets/test — probe a key against its provider WITHOUT
// saving. Body: { key: string, value: string, provider?: string } — provider
// disambiguates shared keys (SEARCH_API_KEY → tavily | brave). Always 200s with
// { ok, message, latencyMs } — a bad key is a normal, actionable answer.
// ---------------------------------------------------------------------------
router.post('/settings/secrets/test', requireAdmin, async (req, res) => {
  const { key, value, provider } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ ok: false, message: 'key is required', latencyMs: 0 });
  }
  if (!(SECRET_ENV_KEYS as readonly string[]).includes(key)) {
    return res.status(400).json({ ok: false, message: `Unknown key: ${key}`, latencyMs: 0 });
  }
  let targetValue = typeof value === 'string' ? value.trim() : '';
  if (!targetValue) {
    // If no value provided, check if key is already set in the environment
    const envValue = (process.env[key] || '').trim();
    if (!envValue) {
      return res.status(400).json({ ok: false, message: 'value is required when key is not set in environment', latencyMs: 0 });
    }
    targetValue = envValue;
  }
  const t0 = Date.now();
  try {
    const result = await probeKey(
      key as (typeof SECRET_ENV_KEYS)[number],
      targetValue,
      typeof provider === 'string' ? provider : undefined,
    );
    res.json({ ok: result.ok, message: result.message, latencyMs: Date.now() - t0 });
  } catch (err: unknown) {
    res.json({ ok: false, message: (err as { message?: string })?.message || 'probe failed', latencyMs: Date.now() - t0 });
  }
});


// ---------------------------------------------------------------------------
// GET /settings/llm/discover — probe a locca / openai-compatible server for
// liveness + its loaded model list, so the onboarding wizard and admin
// Settings UI can auto-fill the model field with no hand-typing. Non-mutating.
// `?baseUrl=` overrides; default is the locca host URL (host.docker.internal:8080).
// Always 200s with { reachable, models, baseUrl } — an unreachable server is a
// normal answer, not an error.
// ---------------------------------------------------------------------------
router.get('/settings/llm/discover', requireAdmin, async (req, res) => {
  const baseUrl =
    String(req.query.baseUrl || '').trim().replace(/\/+$/, '') ||
    llmProvider.DEFAULT_LOCCA_BASE_URL;
  try {
    const r = await fetchWithTimeout(`${baseUrl}/models`, { timeoutMs: 3000, bodyDeadline: true });
    if (!r.ok) {
      return res.json({ reachable: false, models: [], baseUrl, error: `HTTP ${r.status}` });
    }
    const data = (await r.json()) as { data?: unknown };
    const models = Array.isArray(data?.data)
      ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string')
      : [];
    res.json({ reachable: true, models, baseUrl });
  } catch (err: unknown) {
    res.json({ reachable: false, models: [], baseUrl, error: (err as { message?: string })?.message || 'unreachable' });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/llm/probe-compat — live probe for an openai-compatible key.
// Body: { apiKey: string, baseUrl: string, model: string }
// Always 200s with { ok, message, latencyMs }. The key is NOT saved.
// ---------------------------------------------------------------------------
router.post('/settings/llm/probe-compat', requireAdmin, async (req, res) => {
  const { apiKey, baseUrl, model } = req.body || {};
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return res.status(400).json({ ok: false, message: 'baseUrl is required', latencyMs: 0 });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ ok: false, message: 'model is required', latencyMs: 0 });
  }
  const t0 = Date.now();
  try {
    let resolvedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!resolvedApiKey) {
      await settings.load();
      const s = settings.get();
      const fallbackUrl = (s.llm?.fallback?.baseUrl || '').trim().replace(/\/+$/, '');
      const targetUrl = baseUrl.trim().replace(/\/+$/, '');
      // Match the target server to a leg, then read that leg's provider's inline
      // key from the per-provider map (issue #657). Falls back to the
      // openai-compatible slot when neither leg's URL matches.
      const legProvider = (targetUrl && targetUrl === fallbackUrl)
        ? s.llm?.fallback?.provider
        : s.llm?.provider;
      resolvedApiKey = settings.llmKeyFor(legProvider || 'openai-compatible');
    }

    const m = createOpenAI({
      apiKey: resolvedApiKey || 'no-key',
      baseURL: baseUrl.trim().replace(/\/+$/, ''),
    }).chat(model.trim());
    await generateText({
      model: m,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 32,
      abortSignal: AbortSignal.timeout(15000),
    });
    res.json({ ok: true, message: '✓ Bearer token accepted · model responded', latencyMs: Date.now() - t0 });
  } catch (err: unknown) {
    res.json({ ok: false, message: briefLlmError(err), latencyMs: Date.now() - t0 });
  }
});

// Providers whose model API returns one mixed list (chat + embedding) with no
// type flag. For scope=embedding we can't tell them apart at the API level like
// openai/google/openrouter/gateway do, so we trim by model-name heuristic below
// — otherwise the embedding picker offers chat models that just fail to embed.
const MIXED_MODEL_LIST_PROVIDERS = new Set(['ollama', 'openai-compatible', 'locca', 'requesty', 'orcarouter']);

// Heuristic: does this model id look like a text-embedding model? Embedding
// model naming is conventional — almost all carry "embed", the rest come from a
// short list of known families (bge / gte / e5 / minilm / instructor). Anything
// unmatched can still be typed by hand (the field falls back to a free-text
// input when discovery returns nothing).
function looksLikeEmbeddingModel(id: string): boolean {
  const s = id.toLowerCase();
  if (s.includes('embed')) return true; // nomic-embed-text, mxbai-embed-large, text-embedding-3-*, *-arctic-embed
  return /(^|[/:_-])(bge|gte|e5|all-minilm|minilm|instructor)([/:_-]|$)/.test(s);
}

// ---------------------------------------------------------------------------
// GET /settings/llm/models — discover available models for any LLM provider.
// Query: provider (required), baseUrl (optional), ollamaUrl (optional).
// Always 200s with { ok, models, provider, error? }.
// ---------------------------------------------------------------------------
router.get('/settings/llm/models', requireAdmin, async (req, res) => {
  const provider = String(req.query.provider || '').trim();
  if (!provider) {
    return res.json({ ok: false, models: [], provider: '', error: 'provider is required' });
  }
  const baseUrl = String(req.query.baseUrl || '').trim().replace(/\/+$/, '');
  const ollamaUrl = String(req.query.ollamaUrl || '').trim().replace(/\/+$/, '');
  const scope = String(req.query.scope || '').trim(); // 'embedding' | '' (chat)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);

  const resolveKey = (envName: string) => (process.env[envName] || '').trim() || '';

  try {
    let models: string[] = [];

    switch (provider) {
      case 'ollama': {
        const url = ollamaUrl || config.ollama.url || 'http://localhost:11434';
        const r = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
        const data = (await r.json()) as { models?: unknown };
        models = Array.isArray(data?.models)
          ? (data.models as { name?: unknown }[]).map((m) => m?.name).filter((n): n is string => typeof n === 'string')
          : [];
        break;
      }

      case 'openai-compatible':
      case 'locca': {
        const url = baseUrl
          || (provider === 'locca' ? llmProvider.DEFAULT_LOCCA_BASE_URL : '');
        if (!url) throw new Error('baseUrl is required for openai-compatible');
        await settings.load();
        // Inline key for this provider from the per-provider map (issue #657).
        // Primary and fallback inline legs of the same provider share one entry,
        // so the key resolves by provider id without a baseUrl match.
        const apiKey = settings.llmKeyFor(provider);
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const r = await fetch(`${url}/models`, { signal: ctrl.signal, headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string')
          : [];
        break;
      }

      case 'openai': {
        const apiKey = resolveKey('OPENAI_API_KEY');
        if (!apiKey) throw new Error('OPENAI_API_KEY not set');
        const r = await fetch('https://api.openai.com/v1/models', {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[])
              .map((m) => m?.id)
              .filter((id): id is string => typeof id === 'string')
              .filter((id: string) => scope === 'embedding' ? id.startsWith('text-embedding-') : !id.startsWith('text-embedding-'))
              .sort()
          : [];
        break;
      }

      case 'anthropic': {
        const apiKey = resolveKey('ANTHROPIC_API_KEY');
        if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
        const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          signal: ctrl.signal,
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
        if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'google': {
        const apiKey = resolveKey('GOOGLE_GENERATIVE_AI_API_KEY');
        if (!apiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not set');
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Google HTTP ${r.status}`);
        const data = (await r.json()) as { models?: unknown };
        models = Array.isArray(data?.models)
          ? (data.models as { supportedGenerationMethods?: unknown; name?: unknown }[])
              .filter((m) => {
                const methods: string[] = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                return scope === 'embedding'
                  ? methods.includes('embedContent')
                  : methods.includes('generateContent');
              })
              .map((m) => String(m?.name || '').replace(/^models\//, ''))
              .filter(Boolean)
              .sort()
          : [];
        break;
      }

      case 'deepseek': {
        const apiKey = resolveKey('DEEPSEEK_API_KEY');
        if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');
        const r = await fetch('https://api.deepseek.com/v1/models', {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`DeepSeek HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'openrouter': {
        const url = scope === 'embedding'
          ? 'https://openrouter.ai/api/v1/models?output_modalities=embeddings'
          : 'https://openrouter.ai/api/v1/models';
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'requesty': {
        const apiKey = resolveKey('REQUESTY_API_KEY');
        if (!apiKey) throw new Error('REQUESTY_API_KEY not set');
        const r = await fetch(`${llmProvider.DEFAULT_REQUESTY_BASE_URL}/models`, {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`Requesty HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'orcarouter': {
        const apiKey = resolveKey('ORCAROUTER_API_KEY');
        if (!apiKey) throw new Error('ORCAROUTER_API_KEY not set');
        const r = await fetch(`${llmProvider.DEFAULT_ORCAROUTER_BASE_URL}/models`, {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`OrcaRouter HTTP ${r.status}`);
        const data = (await r.json()) as { data?: unknown };
        models = Array.isArray(data?.data)
          ? (data.data as { id?: unknown }[]).map((m) => m?.id).filter((id): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'gateway': {
        // Vercel AI Gateway. Use the SDK's getAvailableModels() rather than a
        // hand-rolled URL — the gateway lives at ai-gateway.vercel.sh/v3/ai (not
        // Cloudflare) and the SDK resolves the key / OIDC exactly as the registry's
        // createGateway does. No apiKey → fall through to env / OIDC credentials.
        const apiKey = resolveKey('AI_GATEWAY_API_KEY');
        const gw = createGateway({
          ...(apiKey ? { apiKey } : {}),
          fetch: (u: string | URL | Request, init?: RequestInit) => fetch(u, { ...init, signal: ctrl.signal }),
        });
        const { models: gwModels } = await gw.getAvailableModels();
        models = (Array.isArray(gwModels) ? gwModels : [])
          .filter((m: { modelType?: unknown }) => {
            if (!scope) return true;
            const t = m?.modelType;
            return scope === 'embedding' ? t === 'embedding' : t !== 'embedding';
          })
          .map((m: { id?: unknown }) => m?.id)
          .filter((id): id is string => typeof id === 'string')
          .sort();
        break;
      }

      default:
        return res.json({ ok: false, models: [], provider, error: `unknown provider: ${provider}` });
    }

    // These providers hand back a mixed chat+embedding list; keep only the
    // embedding-looking models so the tagger's embedding picker isn't cluttered
    // with chat models that can't embed. Other providers already filtered by
    // their API above.
    if (scope === 'embedding' && MIXED_MODEL_LIST_PROVIDERS.has(provider)) {
      models = models.filter(looksLikeEmbeddingModel);
    }

    res.json({ ok: true, models, provider });
  } catch (err: unknown) {
    res.json({ ok: false, models: [], provider, error: (err as { message?: string })?.message || 'discovery failed' });
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// POST /settings/embedding/probe — test whether the configured (or supplied)
// embedding endpoint can actually produce embeddings, surfacing the result
// in the admin UI BEFORE a long tagging run instead of failing mid-job.
// Optional body overrides (provider/model/baseUrl/ollamaUrl/apiKey) test the
// unsaved form values; omitted fields fall back to saved settings.embedding →
// llm. POST body rather than query params so the bearer token never rides a
// URL that reverse-proxy access logs capture — same shape as
// /settings/llm/probe-compat.
// Always 200s with { ok, dim, code, message } — a chat-model / unreachable
// server is a normal, actionable answer, not an error.
// ---------------------------------------------------------------------------
router.post('/settings/embedding/probe', requireAdmin, async (req, res) => {
  const overrides: Record<string, string> = {};
  for (const k of ['provider', 'model', 'baseUrl', 'ollamaUrl', 'apiKey']) {
    const v = (req.body || {})[k];
    if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
  }
  try {
    const r = await probeEmbeddingConfig(overrides);
    let message = r.message;
    // Test-only reassurance: a not-yet-pulled Ollama model isn't a real failure —
    // the tagger auto-pulls it on the next run (ensureReady → tryOllamaPull). We
    // add this only here, NOT in the shared actionableMessage, because the tagger
    // reuses that same message only AFTER an auto-pull has already failed.
    if (r.code === 'not_found' && r.provider === 'ollama') {
      message += '\n  You can ignore this — the tagger pulls this model automatically when you start a run.';
    }
    res.json({ ok: r.code === 'ok', dim: r.dim ?? null, code: r.code, message });
  } catch (err: unknown) {
    res.json({ ok: false, dim: null, code: 'unknown', message: (err as { message?: string })?.message || 'probe failed' });
  }
});


