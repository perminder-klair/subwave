// Provider probing and model discovery. All read-only against the provider:
// nothing here writes settings. Part of the settings/ route split.

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
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { fetchWithTimeout } from '../../util/fetch-timeout.js';
import { probeFishKey } from '../../llm/speech.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

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
  const raw: string = (e?.message || '').trim();
  const sentence = raw.split(/[.\n]/)[0].trim();
  return sentence.slice(0, 80) || 'Request failed';
}

// Non-mutating probe of one secret; builds a one-off client and never writes
// process.env or secrets.env. `form` carries the two fields a probe may need
// that saved settings cannot supply mid-edit — Azure's resource endpoint and
// deployment name — since the UI tests a key BEFORE saving the form around it;
// saved settings are the fallback. `hint` disambiguates a key shared by several
// providers (SEARCH_API_KEY is Tavily or Brave) for the same reason, falling
// back to the saved provider, then Tavily. maxOutputTokens stays at 32:
// OpenAI's Responses API rejects anything below 16.
async function probeKey(
  key: (typeof SECRET_ENV_KEYS)[number],
  value: string,
  hint?: string,
  form?: { baseUrl?: string; model?: string },
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
    case 'AZURE_API_KEY': {
      // Azure has no hosted endpoint and no model list to default to: the probe
      // needs the operator's resource endpoint AND a deployment name. Prefer the
      // live form, fall back to whichever leg has azure selected.
      const azureLeg = cfg.provider === 'azure'
        ? cfg
        : (cfg.fallback?.provider === 'azure' ? cfg.fallback : null);
      const baseUrl = (form?.baseUrl || '').trim() || azureLeg?.providerBaseUrls?.azure || '';
      const deployment = (form?.model || '').trim() || azureLeg?.model || '';
      const ep = llmProvider.azureEndpoint({ baseUrl });
      if (!ep.baseURL || !deployment) {
        return {
          ok: false,
          message: 'Fill in the Azure endpoint and deployment name above first — the key is tested by calling that deployment',
        };
      }
      try {
        const m = createAzure({
          baseURL: ep.baseURL,
          apiKey: value,
          ...(ep.apiVersion ? { apiVersion: ep.apiVersion } : {}),
          ...(ep.useDeploymentBasedUrls ? { useDeploymentBasedUrls: true } : {}),
        }).chat(deployment);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 32, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ Azure OpenAI key valid · deployment "${deployment}" responded` };
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
          // Brave signals a bad token as 422 SUBSCRIPTION_TOKEN_INVALID, not
          // 401/403, so the error code has to be checked too.
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

// Probe a key against its provider WITHOUT saving. Body may also carry
// baseUrl/model — the unsaved Azure endpoint + deployment name. Always 200s
// with { ok, message, latencyMs }: a bad key is a normal, actionable answer.
router.post('/settings/secrets/test', requireAdmin, async (req, res) => {
  const { key, value, provider, baseUrl, model } = req.body || {};
  if (!key || typeof key !== 'string') {
    return res.status(400).json({ ok: false, message: 'key is required', latencyMs: 0 });
  }
  if (!(SECRET_ENV_KEYS as readonly string[]).includes(key)) {
    return res.status(400).json({ ok: false, message: `Unknown key: ${key}`, latencyMs: 0 });
  }
  let targetValue = typeof value === 'string' ? value.trim() : '';
  if (!targetValue) {
    // No value supplied: fall back to the key already in the environment.
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
      {
        baseUrl: typeof baseUrl === 'string' ? baseUrl : undefined,
        model: typeof model === 'string' ? model : undefined,
      },
    );
    res.json({ ok: result.ok, message: result.message, latencyMs: Date.now() - t0 });
  } catch (err: unknown) {
    res.json({ ok: false, message: (err as { message?: string })?.message || 'probe failed', latencyMs: Date.now() - t0 });
  }
});


// Liveness + loaded model list for a locca / openai-compatible server, so the
// wizard can auto-fill the model field. `?baseUrl=` overrides the locca
// default. Always 200s with { reachable, models, baseUrl }.
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

// 'set' is getRedacted()'s sentinel and means "the value already on file", read
// here exactly as applyLlmLegPatch reads it on the save path. Never throws.
function hasRedactedHeader(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.values(raw as Record<string, unknown>).some((v) => v === 'set');
}

function resolveProbeHeaders(raw: unknown, stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const onFile = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  for (const name of Object.keys(raw as Record<string, unknown>)) {
    const v = (raw as Record<string, unknown>)[name];
    const resolved = v === 'set' ? onFile[name.trim()] : v;
    if (typeof resolved === 'string' && resolved.trim()) out[name.trim()] = resolved.trim();
  }
  return out;
}

// Live probe for an openai-compatible key; always 200s and never saves the key.
// `headers` mirrors settings llm.headers (#1618) so the probe asks the same
// question the live path does: a gateway routing on a header rejects a call
// without it.
router.post('/settings/llm/probe-compat', requireAdmin, async (req, res) => {
  const { apiKey, baseUrl, model, headers } = req.body || {};
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return res.status(400).json({ ok: false, message: 'baseUrl is required', latencyMs: 0 });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ ok: false, message: 'model is required', latencyMs: 0 });
  }
  const t0 = Date.now();
  try {
    const typedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    // A 'set' header, like a blank key, means the stored leg must be read.
    const needsStored = !typedKey || hasRedactedHeader(headers);
    let resolvedApiKey = typedKey;
    let storedHeaders: unknown;
    if (needsStored) {
      await settings.load();
      const s = settings.get();
      const fallbackUrl = (s.llm?.fallback?.baseUrl || '').trim().replace(/\/+$/, '');
      const targetUrl = baseUrl.trim().replace(/\/+$/, '');
      // Match the target server to a leg, then read that leg's inline key
      // (#657) and stored headers (#1618), so the fallback editor resolves its
      // own sentinels. Defaults to the primary when no URL matches.
      const isFallback = Boolean(targetUrl) && targetUrl === fallbackUrl;
      const legProvider = isFallback ? s.llm?.fallback?.provider : s.llm?.provider;
      storedHeaders = isFallback ? s.llm?.fallback?.headers : s.llm?.headers;
      if (!resolvedApiKey) resolvedApiKey = settings.llmKeyFor(legProvider || 'openai-compatible');
    }

    const probeHeaders = llmProvider.customHeaders({
      headers: resolveProbeHeaders(headers, storedHeaders),
    });

    const m = createOpenAI({
      apiKey: resolvedApiKey || 'no-key',
      baseURL: baseUrl.trim().replace(/\/+$/, ''),
      ...(probeHeaders ? { headers: probeHeaders } : {}),
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

// Providers whose model API returns one mixed chat+embedding list with no type
// flag, so scope=embedding has to trim them by the name heuristic below.
const MIXED_MODEL_LIST_PROVIDERS = new Set(['ollama', 'openai-compatible', 'locca', 'requesty']);

// Name heuristic: almost all embedding models carry "embed", the rest come from
// a short list of families. An unmatched model can still be typed by hand.
function looksLikeEmbeddingModel(id: string): boolean {
  const s = id.toLowerCase();
  if (s.includes('embed')) return true; // nomic-embed-text, mxbai-embed-large, text-embedding-3-*, *-arctic-embed
  return /(^|[/:_-])(bge|gte|e5|all-minilm|minilm|instructor)([/:_-]|$)/.test(s);
}

// Shape Azure's deployment list into model ids for the picker. A deployment
// carries both its operator-chosen name (`id`) and the model behind it
// (`model`), which is why azure is deliberately NOT in
// MIXED_MODEL_LIST_PROVIDERS: that set trims by the id alone, and `model` is
// strictly better information — a deployment called "vectors" is still an
// embedding deployment. Fall back to the name only when the API omits `model`.
// Only the EMBEDDING scope filters: hiding a deployment from the chat picker
// would be a separate behaviour change, and a hidden one cannot be picked.
export function azureDeploymentIds(raw: unknown, scope: string): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { id?: unknown; model?: unknown }[])
    .filter((d) => {
      if (scope !== 'embedding') return true;
      const backing = typeof d?.model === 'string' ? d.model : '';
      const name = typeof d?.id === 'string' ? d.id : '';
      return looksLikeEmbeddingModel(backing || name);
    })
    .map((d) => d?.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
}

// Discover available models for any provider. Query: provider (required),
// baseUrl, ollamaUrl, scope. Always 200s with { ok, models, provider, error? }.
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
        // Inline key from the per-provider map (#657): both legs of a provider
        // share one entry, so it resolves by provider id, not by baseUrl.
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

      case 'azure': {
        // Azure's model list is per-RESOURCE (the deployments the operator
        // created), so it needs their endpoint and key. The data-plane
        // deployments list is a legacy api-version and some resources/policies
        // do not serve it at all — a failure here is normal and lands the
        // operator on the free-text deployment-name input, which is the same
        // place they would be with no discovery at all. Never throw the key.
        const apiKey = resolveKey('AZURE_API_KEY') || (await (async () => {
          await settings.load();
          return settings.llmKeyFor('azure');
        })());
        if (!apiKey) throw new Error('AZURE_API_KEY not set');
        if (!baseUrl) throw new Error('Azure endpoint is required');
        // Deployment listing lives under the resource root, NOT the /openai/v1
        // chat path, so strip back to the root the operator pasted.
        const root = baseUrl.replace(/\?.*$/, '').replace(/\/+$/, '').replace(/\/openai(\/v1)?$/i, '');
        const r = await fetch(`${root}/openai/deployments?api-version=2023-03-15-preview`, {
          signal: ctrl.signal,
          headers: { 'api-key': apiKey },
        });
        if (!r.ok) throw new Error(`Azure HTTP ${r.status} — type the deployment name instead`);
        const data = (await r.json()) as { data?: unknown };
        models = azureDeploymentIds(data?.data, scope);
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

      case 'gateway': {
        // Use the SDK's getAvailableModels() rather than a hand-rolled URL, so
        // the key/OIDC resolves exactly as the registry's createGateway does.
        // No apiKey falls through to env / OIDC credentials.
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

    // Mixed-list providers only; the rest were already filtered by their API.
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

// Test whether the configured (or supplied) embedding endpoint can actually
// embed, before a long tagging run. Body overrides test unsaved form values;
// omitted fields fall back to settings.embedding then llm. POST rather than
// query params so the bearer token never rides a URL access logs capture.
// Always 200s with { ok, dim, code, message }.
router.post('/settings/embedding/probe', requireAdmin, async (req, res) => {
  const overrides: Record<string, string> = {};
  for (const k of ['provider', 'model', 'baseUrl', 'ollamaUrl', 'apiKey']) {
    const v = (req.body || {})[k];
    if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
  }
  try {
    const r = await probeEmbeddingConfig(overrides);
    let message = r.message;
    // Test-only: a not-yet-pulled Ollama model is auto-pulled on the next run.
    // Kept out of the shared actionableMessage, which the tagger reuses only
    // AFTER an auto-pull has already failed.
    if (r.code === 'not_found' && r.provider === 'ollama') {
      message += '\n  You can ignore this — the tagger pulls this model automatically when you start a run.';
    }
    res.json({ ok: r.code === 'ok', dim: r.dim ?? null, code: r.code, message });
  } catch (err: unknown) {
    res.json({ ok: false, dim: null, code: 'unknown', message: (err as { message?: string })?.message || 'probe failed' });
  }
});


