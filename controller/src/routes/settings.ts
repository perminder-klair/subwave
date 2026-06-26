// Admin-gated settings surface: the single /settings read endpoint the admin
// UI consumes, the matching write endpoint, plus the mixer-restart and
// auto-pick toggles.
import express from 'express';
import { config } from '../config.js';
import * as library from '../music/library.js';
import * as jingles from '../broadcast/jingles.js';
import * as settings from '../settings.js';
import * as tts from '../audio/tts.js';
import * as chatterbox from '../audio/chatterbox.js';
import * as piper from '../audio/piper.js';
import * as llmProvider from '../llm/provider.js';
import { probeEmbeddingConfig } from '../music/embeddings.js';
import { queue } from '../broadcast/queue.js';
import { restartLiquidsoap, startStream, stopStream, streamStatus } from '../broadcast/liquidsoap-control.js';
import { invalidateWeatherCache } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { saveSecrets, SECRET_ENV_KEYS } from '../setup/secrets.js';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { tagger } from '../broadcast/tagger.js';
import { skillCatalog } from '../skills/_agent.js';
import { clearUserThemeCache, loadUserThemes, listThemes, saveUserTheme } from '../themes.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// SETTINGS — single endpoint that returns everything the /settings UI needs
// ---------------------------------------------------------------------------
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    await library.load();
    await settings.load();
    // Redacted view — masks llm.apiKey / tts.cloud.apiKey so secrets never
    // leave the process. The UI shows "set"/"" and round-trips it harmlessly.
    const s = settings.getRedacted();
    // On-air status — a telnet failure must not 500 the whole settings load.
    let streamOnAir: boolean | null = null;
    try { streamOnAir = await streamStatus(); } catch {}
    // The persona actually on air right now — the same resolution the listener
    // side uses (getEffectivePersona): a scheduled show's owner when a show is
    // live this hour, otherwise the admin-selected default. The roster marks
    // "on air" by THIS, not by activePersonaId, so a show override surfaces the
    // real voice instead of the static default.
    const onAirPersona = settings.getEffectivePersona();
    const activeShow = settings.resolveActiveShow();
    const onAir = {
      personaId: onAirPersona?.id || '',
      // The show reassigning the hour, present only when a show actually owns a
      // persona this hour — null means the default persona is on air.
      show: activeShow?.persona?.id ? { id: activeShow.id, name: activeShow.name } : null,
    };
    // Reference-WAV voices are shared by chatterbox + pocket-tts (issue #213);
    // read once and reuse for both dropdowns.
    const customVoices = await chatterbox.listReferenceVoices();
    // Custom Piper .onnx voices the operator dropped into the same shared folder
    // (issue #230) — only those with a matching .onnx.json manifest are listed.
    const piperVoices = await piper.listPiperVoices();
    const voiceDir = chatterbox.voiceDir();
    res.json({
      autoPick: queue.autoPick,
      pickerBusy: queue.pickerBusy,
      streamOnAir,
      onAir,
      jingles: await jingles.list(),
      libraryStats: library.stats(),
      tagger: { ...tagger, lastLog: tagger.lastLog.slice(-30) },
      ollama: { url: config.ollama.url, model: config.ollama.model },
      // What the configured zone resolves to when timezone is '' (Auto) —
      // lets the UI label the Auto option with the actual server zone.
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      values: {
        jingleRatio: s.jingleRatio,
        crossfadeDuration: s.crossfadeDuration,
        archive: s.archive,
        stream: s.stream,
        station: s.station,
        timezone: s.timezone,
        locale: s.locale,
        theme: s.theme,
        weather: s.weather,
        djPrompt: s.djPrompt,
        personas: s.personas,
        activePersonaId: s.activePersonaId,
        shows: s.shows,
        schedule: s.schedule,
        tts: s.tts,
        llm: s.llm,
        search: s.search,
        embedding: s.embedding,
        audio: s.audio,
        sfx: s.sfx,
        ui: s.ui,
        scrobble: s.scrobble,
      },
      defaults: {
        // The built-in prompt template — the UI shows this when djPrompt is "".
        djPrompt: settings.DEFAULT_DJ_PROMPT_TEMPLATE,
        personas: settings.getDefaults().personas,
        tts: settings.getDefaults().tts,
        llm: settings.getDefaults().llm,
        search: settings.getDefaults().search,
        locale: settings.getDefaults().locale,
      },
      tts: {
        engines: tts.ENGINES,
        available: tts.availableEngines(),
        kokoroVoices: settings.KOKORO_VOICES_BRITISH,
        voiceDir,
        piperVoices,
        chatterboxVoices: customVoices,
        // `chatterboxVoiceDir` kept as an alias of `voiceDir` so older UI
        // builds that haven't picked up the new field don't break.
        chatterboxVoiceDir: voiceDir,
        pocketTtsVoices: settings.POCKET_TTS_VOICES,
        pocketTtsCustomVoices: customVoices,
        cloudProviders: settings.TTS_CLOUD_PROVIDERS,
        frequencies: settings.FREQUENCIES,
        moods: settings.SHOW_MOODS,
      },
      llm: {
        providers: settings.LLM_PROVIDERS,
        active: llmProvider.activeModelLabel(),
      },
      embedding: {
        // Embedding-capable providers only — a strict subset of llm.providers.
        // The picker maps over this so chat-only providers (deepseek, gateway)
        // can't be chosen as an embedding source (#493).
        providers: settings.EMBEDDING_PROVIDERS,
      },
      search: {
        providers: settings.SEARCH_PROVIDERS,
      },
      // Which provider API keys are present in the controller's environment.
      // The UI keys its "key missing" alerts off this — keys are configured
      // via controller/.env, never typed into the admin surface.
      env: {
        OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
        ELEVENLABS_API_KEY: !!process.env.ELEVENLABS_API_KEY,
        ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
        GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        DEEPSEEK_API_KEY: !!process.env.DEEPSEEK_API_KEY,
        OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
        REQUESTY_API_KEY: !!process.env.REQUESTY_API_KEY,
        AI_GATEWAY_API_KEY: !!process.env.AI_GATEWAY_API_KEY,
        SEARCH_API_KEY: !!process.env.SEARCH_API_KEY,
        EMBEDDING_API_KEY: !!process.env.EMBEDDING_API_KEY,
        LASTFM_API_KEY: !!process.env.LASTFM_API_KEY,
        LASTFM_API_SECRET: !!process.env.LASTFM_API_SECRET,
        LASTFM_SESSION_KEY: !!process.env.LASTFM_SESSION_KEY,
        LISTENBRAINZ_USER_TOKEN: !!process.env.LISTENBRAINZ_USER_TOKEN,
      },
      // Skill catalogue — consumed by the Skills page and by Personas for the
      // per-persona skill-assignment checklist.
      skills: { catalog: skillCatalog() },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings — update values. Returns { requiresRestart } so the UI can
// prompt the user to restart the mixer for jingle freq / crossfade changes.
// ---------------------------------------------------------------------------
router.post('/settings', requireAdmin, async (req, res) => {
  try {
    const result = await settings.update(req.body || {});
    // Apply live: weather location flows through config.weather to context.js
    if ('weather' in (req.body || {})) {
      config.weather.lat = result.saved.weather.lat;
      config.weather.lng = result.saved.weather.lng;
      config.weather.locationName = result.saved.weather.locationName;
      config.weather.units = result.saved.weather.units;
      invalidateWeatherCache();
      queue.log(
        'scheduler',
        `weather location → ${result.saved.weather.locationName} (${result.saved.weather.units})`,
      );
    }
    if (result.requiresRestart) {
      queue.log('scheduler', `mixer settings changed — Liquidsoap restart required`);
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/secrets — write one or more API keys to state/secrets.env.
// Only keys listed in SECRET_ENV_KEYS are accepted; blank values are skipped
// (blank = "leave existing key in place"). Takes effect in-process immediately
// via saveSecrets(); no controller restart needed.
// ---------------------------------------------------------------------------
router.post('/settings/secrets', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be a key-value object' });
    }
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (!SECRET_ENV_KEYS.includes(key as any)) continue;
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (trimmed.length > 4096) continue;
      patch[key] = trimmed;
    }
    if (Object.keys(patch).length === 0) {
      return res.json({ saved: [] });
    }
    await saveSecrets(patch);
    res.json({ saved: Object.keys(patch) });
  } catch (err: any) {
    console.error('[settings/secrets]', err);
    res.status(400).json({ error: 'Failed to save secrets' });
  }
});

// ---------------------------------------------------------------------------
// probeKey — non-mutating live probe for a single secret key.
// Builds a one-off provider client using the supplied value; never writes to
// process.env or secrets.env. Always resolves (never rejects).
// ---------------------------------------------------------------------------
// Distill a raw provider/SDK error into a one-line actionable message.
function briefLlmError(err: any): string {
  const msg: string = (err?.message || err?.toString() || '').toLowerCase();
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
  const raw: string = (err?.message || '').trim();
  const sentence = raw.split(/[.\n]/)[0].trim();
  return sentence.slice(0, 80) || 'Request failed';
}

async function probeKey(
  key: (typeof SECRET_ENV_KEYS)[number],
  value: string,
): Promise<{ ok: boolean; message: string }> {
  const cfg = settings.get().llm || {};
  const activeModel = (provider: string) =>
    cfg.provider === provider ? (cfg.model || '') : '';

  switch (key) {
    case 'ANTHROPIC_API_KEY': {
      try {
        const model = activeModel('anthropic') || 'claude-haiku-4-5-20251001';
        const m = createAnthropic({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ Anthropic key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'OPENAI_API_KEY': {
      try {
        const model = activeModel('openai') || 'gpt-4o-mini';
        const m = createOpenAI({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ OpenAI key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'GOOGLE_GENERATIVE_AI_API_KEY': {
      try {
        const model = activeModel('google') || 'gemini-1.5-flash';
        const m = createGoogleGenerativeAI({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ Google key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'DEEPSEEK_API_KEY': {
      try {
        const model = activeModel('deepseek') || 'deepseek-chat';
        const m = createDeepSeek({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ DeepSeek key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'OPENROUTER_API_KEY': {
      try {
        const model = activeModel('openrouter') || 'openai/gpt-4o-mini';
        const m = createOpenRouter({ apiKey: value })(model);
        await generateText({ model: m, prompt: 'Reply with the single word OK.', maxOutputTokens: 8, abortSignal: AbortSignal.timeout(15000) });
        return { ok: true, message: `✓ OpenRouter key valid · model responded` };
      } catch (err) { return { ok: false, message: briefLlmError(err) }; }
    }
    case 'AI_GATEWAY_API_KEY': {
      return { ok: true, message: 'Key format looks valid — confirm via a live LLM call' };
    }
    case 'ELEVENLABS_API_KEY': {
      const r = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': value },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as { detail?: { message?: string } | string };
        const msg = typeof j?.detail === 'string' ? j.detail : (j?.detail as any)?.message || '';
        return { ok: false, message: r.status === 401 ? 'Key rejected — check it\'s correct and active' : (msg || `Request failed (${r.status})`) };
      }
      const u = await r.json() as { first_name?: string };
      return { ok: true, message: `✓ ElevenLabs key valid${u.first_name ? ` · account: ${u.first_name}` : ''}` };
    }
    case 'SEARCH_API_KEY': {
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
      const r = await fetch('https://api.listenbrainz.org/1/validate-token', {
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
// saving. Body: { key: string, value: string }. Always 200s with
// { ok, message, latencyMs } — a bad key is a normal, actionable answer.
// ---------------------------------------------------------------------------
router.post('/settings/secrets/test', requireAdmin, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || !value || typeof key !== 'string' || typeof value !== 'string') {
    return res.status(400).json({ ok: false, message: 'key and value are required', latencyMs: 0 });
  }
  if (!SECRET_ENV_KEYS.includes(key as any)) {
    return res.status(400).json({ ok: false, message: `Unknown key: ${key}`, latencyMs: 0 });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return res.status(400).json({ ok: false, message: 'value must not be blank', latencyMs: 0 });
  }
  const t0 = Date.now();
  try {
    const result = await probeKey(key as (typeof SECRET_ENV_KEYS)[number], trimmed);
    res.json({ ok: result.ok, message: result.message, latencyMs: Date.now() - t0 });
  } catch (err: any) {
    res.json({ ok: false, message: err?.message || 'probe failed', latencyMs: Date.now() - t0 });
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${baseUrl}/models`, { signal: ctrl.signal });
    if (!r.ok) {
      return res.json({ reachable: false, models: [], baseUrl, error: `HTTP ${r.status}` });
    }
    const data: any = await r.json();
    const models = Array.isArray(data?.data)
      ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string')
      : [];
    res.json({ reachable: true, models, baseUrl });
  } catch (err: any) {
    res.json({ reachable: false, models: [], baseUrl, error: err?.message || 'unreachable' });
  } finally {
    clearTimeout(timer);
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
    const m = createOpenAI({
      apiKey: (typeof apiKey === 'string' && apiKey.trim()) ? apiKey.trim() : 'no-key',
      baseURL: baseUrl.trim().replace(/\/+$/, ''),
    }).chat(model.trim());
    await generateText({
      model: m,
      prompt: 'Reply with the single word OK.',
      maxOutputTokens: 8,
      abortSignal: AbortSignal.timeout(15000),
    });
    res.json({ ok: true, message: '✓ Bearer token accepted · model responded', latencyMs: Date.now() - t0 });
  } catch (err: any) {
    res.json({ ok: false, message: briefLlmError(err), latencyMs: Date.now() - t0 });
  }
});

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
        const data: any = await r.json();
        models = Array.isArray(data?.models)
          ? data.models.map((m: any) => m?.name).filter((n: any): n is string => typeof n === 'string')
          : [];
        break;
      }

      case 'openai-compatible':
      case 'locca': {
        const url = baseUrl
          || (provider === 'locca' ? llmProvider.DEFAULT_LOCCA_BASE_URL : '');
        if (!url) throw new Error('baseUrl is required for openai-compatible');
        await settings.load();
        const s = settings.get();
        const apiKey = (s.llm?.apiKey && typeof s.llm.apiKey === 'string') ? s.llm.apiKey : '';
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const r = await fetch(`${url}/models`, { signal: ctrl.signal, headers });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string')
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
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data
              .map((m: any) => m?.id)
              .filter((id: any): id is string => typeof id === 'string')
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
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string').sort()
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
        const data: any = await r.json();
        models = Array.isArray(data?.models)
          ? data.models
              .filter((m: any) => {
                const methods: string[] = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                return scope === 'embedding'
                  ? methods.includes('embedContent')
                  : methods.includes('generateContent');
              })
              .map((m: any) => String(m?.name || '').replace(/^models\//, ''))
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
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'openrouter': {
        const url = scope === 'embedding'
          ? 'https://openrouter.ai/api/v1/models?output_modalities=embeddings'
          : 'https://openrouter.ai/api/v1/models';
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'requesty': {
        const apiKey = resolveKey('REQUESTY_API_KEY');
        if (!apiKey) throw new Error('REQUESTY_API_KEY not set');
        const r = await fetch('https://router.requesty.ai/v1/models', {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`Requesty HTTP ${r.status}`);
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      case 'gateway': {
        const apiKey = resolveKey('AI_GATEWAY_API_KEY');
        if (!apiKey) throw new Error('AI_GATEWAY_API_KEY not set');
        const r = await fetch('https://gateway.ai.cloudflare.com/v1/models', {
          signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!r.ok) throw new Error(`Gateway HTTP ${r.status}`);
        const data: any = await r.json();
        models = Array.isArray(data?.data)
          ? data.data.map((m: any) => m?.id).filter((id: any): id is string => typeof id === 'string').sort()
          : [];
        break;
      }

      default:
        return res.json({ ok: false, models: [], provider, error: `unknown provider: ${provider}` });
    }

    res.json({ ok: true, models, provider });
  } catch (err: any) {
    res.json({ ok: false, models: [], provider, error: err?.message || 'discovery failed' });
  } finally {
    clearTimeout(timer);
  }
});

// ---------------------------------------------------------------------------
// GET /settings/embedding/probe — test whether the configured (or supplied)
// embedding endpoint can actually produce embeddings, surfacing the result
// in the admin UI BEFORE a long tagging run instead of failing mid-job.
// Optional query overrides (provider/model/baseUrl/ollamaUrl) test the unsaved
// form values; omitted fields fall back to saved settings.embedding → llm.
// Always 200s with { ok, dim, code, message } — a chat-model / unreachable
// server is a normal, actionable answer, not an error.
// ---------------------------------------------------------------------------
router.get('/settings/embedding/probe', requireAdmin, async (req, res) => {
  const overrides: Record<string, string> = {};
  for (const k of ['provider', 'model', 'baseUrl', 'ollamaUrl']) {
    const v = req.query[k];
    if (typeof v === 'string' && v.trim()) overrides[k] = v.trim();
  }
  try {
    const r = await probeEmbeddingConfig(overrides);
    res.json({ ok: r.code === 'ok', dim: r.dim ?? null, code: r.code, message: r.message });
  } catch (err: any) {
    res.json({ ok: false, dim: null, code: 'unknown', message: err?.message || 'probe failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /restart-mixer — telnet → Liquidsoap → shutdown → container restart
// Brief gap of dead air covered by Icecast burst buffer + emergency.mp3.
// ---------------------------------------------------------------------------
router.post('/restart-mixer', requireAdmin, async (req, res) => {
  try {
    await restartLiquidsoap();
    queue.log('scheduler', 'mixer restart requested');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-stop — take the station off air by stopping the Icecast output.
// The mixer process keeps running; the /stream.mp3 mount disconnects.
// ---------------------------------------------------------------------------
router.post('/stream-stop', requireAdmin, async (req, res) => {
  try {
    await stopStream();
    queue.log('scheduler', 'stream stopped — off air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /stream-start — bring the station back on air (reconnect Icecast output)
// ---------------------------------------------------------------------------
router.post('/stream-start', requireAdmin, async (req, res) => {
  try {
    await startStream();
    queue.log('scheduler', 'stream started — on air');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /auto-pick — toggle whether the LLM picks the next track
// Body: { "on": true | false }
// ---------------------------------------------------------------------------
router.post('/auto-pick', requireAdmin, express.json(), (req, res) => {
  if (typeof req.body?.on === 'boolean') queue.autoPick = req.body.on;
  queue.log('scheduler', `auto-pick ${queue.autoPick ? 'enabled' : 'disabled'}`);
  res.json({ autoPick: queue.autoPick });
});

// ---------------------------------------------------------------------------
// POST /themes/refresh — re-scan ${STATE_DIR}/themes/. Use after dropping a
// new JSON in there to pick it up without bouncing the controller. Returns
// the freshly-listed registry so the admin UI can render it immediately.
// ---------------------------------------------------------------------------
router.post('/themes/refresh', requireAdmin, async (req, res) => {
  try {
    clearUserThemeCache();
    await loadUserThemes(true);
    const themes = await listThemes();
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /themes — create/overwrite a user theme as ${STATE_DIR}/themes/<id>.json.
// Body: { id?, name, description?, mode, tokens }. The id is derived from the
// name when absent. Validated by the shared ThemeSchema (token security regex);
// reserved built-in ids are rejected. Returns the refreshed registry.
// ---------------------------------------------------------------------------
router.post('/themes', requireAdmin, async (req, res) => {
  try {
    const themes = await saveUserTheme(req.body || {});
    res.json({ ok: true, themes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /settings/search/test-searxng — verifies the supplied SearXNG instance
// answers a JSON query. Used by the admin UI's "Test" button so the operator
// gets immediate feedback instead of waiting for a segment tick to fail.
// Body { baseUrl: string }. Does not persist anything.
// ---------------------------------------------------------------------------
// Intentionally permits RFC-1918 targets — SearXNG is typically on the homelab LAN.
router.post('/settings/search/test-searxng', requireAdmin, async (req, res) => {
  try {
    const baseUrl = String(req.body?.baseUrl || '').trim();
    if (!baseUrl) return res.status(400).json({ ok: false, error: 'baseUrl required' });
    if (!/^https?:\/\//i.test(baseUrl)) {
      return res.status(400).json({ ok: false, error: 'baseUrl must start with http:// or https://' });
    }

    const url = new URL('/search', baseUrl);
    url.searchParams.set('q', 'subwave connectivity probe');
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let r: Response;
    try {
      r = await fetch(url, {
        headers: { 'User-Agent': 'SUB-WAVE radio controller (probe)' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!r.ok) return res.json({ ok: false, error: `HTTP ${r.status}` });
    const data: any = await r.json();
    const count = Array.isArray(data?.results) ? data.results.length : 0;
    return res.json({ ok: true, results: count });
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'request timed out after 8s' : err?.message || 'fetch failed';
    return res.json({ ok: false, error: msg });
  }
});
